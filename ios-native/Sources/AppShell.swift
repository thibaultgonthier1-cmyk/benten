import SwiftUI
import UIKit
import ImageIO

/// Cache d'images de pochettes — redimensionnées et décodées HORS du fil principal.
///
/// POURQUOI (c'était la cause n°1 des saccades)
/// `UIImage(contentsOfFile:)` ne décode pas tout de suite : il décode l'image ENTIÈRE (souvent
/// 1000 px et plus) au moment où SwiftUI la dessine — donc sur le fil principal, pendant qu'on fait
/// défiler la grille. Une pochette de 1000 px affichée dans une tuile de 120 px, décodée à chaque
/// apparition : c'est exactement ce qui fait sauter le défilement.
///
/// ICI
/// On lit un vignette déjà à la bonne taille via `CGImageSource` (`ShouldCacheImmediately` force le
/// décodage TOUT DE SUITE, donc plus rien à décoder au dessin), le tout dans une tâche détachée —
/// le fil principal ne décode plus jamais une image. Chaque vignette est gardée en mémoire (bornée).
final class ArtworkCache {
    static let shared = ArtworkCache()

    // NSCache est thread-safe : on peut le lire/écrire depuis une tâche d'arrière-plan.
    private let images = NSCache<NSString, UIImage>()
    private let tints = NSCache<NSString, UIColor>()

    private init() {
        images.countLimit = 160
    }

    private func key(_ url: URL, _ maxPixel: CGFloat) -> NSString {
        "\(url.lastPathComponent)@\(Int(maxPixel))" as NSString
    }

    /// Vignette DÉJÀ en cache, sans aucun décodage. À appeler dans un `body` (fil principal) :
    /// si elle est là on l'affiche, sinon on laisse `load` la préparer en arrière-plan.
    func cached(for track: Track, maxPixel: CGFloat) -> UIImage? {
        guard let url = track.artworkURL else { return nil }
        return images.object(forKey: key(url, maxPixel))
    }

    /// Teinte dominante si elle est déjà connue (sinon `nil` — jamais de calcul sur le fil principal).
    func cachedTint(for track: Track) -> Color? {
        guard let url = track.artworkURL else { return nil }
        return tints.object(forKey: url.lastPathComponent as NSString).map(Color.init(uiColor:))
    }

    /// Prépare la vignette en arrière-plan (décodage + redimensionnement), la met en cache et la
    /// renvoie. Ne bloque jamais le fil principal.
    ///
    /// Le décodage se fait dans une tâche détachée (hors fil principal) ; elle ne capture QUE des
    /// valeurs simples (`url`, `maxPixel`). La mise en cache et le calcul de teinte se font ensuite
    /// dans la continuation de cette fonction `async` — également hors du fil principal.
    func load(for track: Track, maxPixel: CGFloat) async -> UIImage? {
        guard let url = track.artworkURL else { return nil }
        let k = key(url, maxPixel)
        if let hit = images.object(forKey: k) { return hit }

        let image = await Task.detached(priority: .userInitiated) {
            ArtworkCache.thumbnail(at: url, maxPixel: maxPixel)
        }.value
        guard let image else { return nil }

        images.setObject(image, forKey: k)
        let tintKey = url.lastPathComponent as NSString
        if tints.object(forKey: tintKey) == nil {
            tints.setObject(image.dominantColor, forKey: tintKey)
        }
        return image
    }

    /// Décode une vignette à la taille demandée (en PIXELS), déjà « aplatie » en bitmap prête à
    /// dessiner. `maxPixel` est une taille en pixels : pas d'accès à `UIScreen` ici, car cette
    /// fonction tourne hors du fil principal.
    nonisolated static func thumbnail(at url: URL, maxPixel: CGFloat) -> UIImage? {
        let srcOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, srcOptions) else {
            return UIImage(contentsOfFile: url.path)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,          // décode MAINTENANT, pas au dessin
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return UIImage(contentsOfFile: url.path)
        }
        return UIImage(cgImage: cg)
    }

    /// Vide le cache quand la bibliothèque change (suppression, vidage).
    func invalidate() {
        images.removeAllObjects()
        tints.removeAllObjects()
    }
}

/// Navigation globale : permet à n'importe quelle vue de changer d'onglet.
///
/// Sans ça, le bouton « Rechercher » de la bibliothèque ne pouvait pas basculer sur l'onglet
/// Recherche — c'était l'une des plaintes : impossible d'accéder aux réglages ou à la recherche
/// quand on écoutait un morceau.
@MainActor
final class AppRouter: ObservableObject {
    enum Tab: Int { case library = 0, favorites = 1, playlists = 2, search = 3, settings = 4 }
    @Published var tab: Tab = .library
}
