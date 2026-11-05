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

    /// Tailles demandées par l'interface (en pixels) — sert à oublier toutes les variantes d'une
    /// pochette quand elle change.
    static let sizes: [CGFloat] = [180, 260, 560, 700, 1000]

    private init() {
        images.countLimit = 220
        images.totalCostLimit = 140 * 1024 * 1024
    }

    /// Oublie une pochette précise (toutes tailles) — quand elle vient d'être remplacée.
    func forget(fileName: String) {
        for size in Self.sizes {
            images.removeObject(forKey: "\(fileName)@\(Int(size))" as NSString)
        }
        tints.removeObject(forKey: fileName as NSString)
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

    /// Variante VIVE et lumineuse de la teinte de la pochette : lisible sur fond sombre, sert à
    /// colorer le lecteur (halo, barre, visualiseur, boutons actifs) — chaque morceau a sa couleur.
    func cachedVividTint(for track: Track) -> Color? {
        guard let url = track.artworkURL,
              let base = tints.object(forKey: url.lastPathComponent as NSString) else { return nil }
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        guard base.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else {
            return Color(uiColor: base)
        }
        // Une pochette grise donne un gris : on garde alors l'accent de l'app.
        guard saturation > 0.12 else { return nil }
        return Color(hue: Double(hue), saturation: Double(min(1, max(0.5, saturation * 1.2))), brightness: Double(max(0.85, brightness)))
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

        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        images.setObject(image, forKey: k, cost: cost)
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
        return UIImage(cgImage: trimmingLetterbox(cg))
    }

    /// Retire les bandes NOIRES autour d'une pochette (miniatures vidéo 16:9 avec la vraie
    /// pochette carrée au milieu) : la pochette est alors affichée entière, en grand, au lieu
    /// d'un bandeau noir rogné.
    nonisolated static func trimmingLetterbox(_ image: CGImage) -> CGImage {
        let width = image.width
        let height = image.height
        guard width > 16, height > 16 else { return image }
        // Uniquement les images NETTEMENT non carrées (miniatures vidéo 16:9…) : une pochette
        // carrée sombre n'est jamais recadrée.
        let sourceAspect = Double(width) / Double(height)
        guard abs(sourceAspect - 1) > 0.15 else { return image }
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return image }

        // Une ligne (ou colonne) est une bande si TOUS ses points sont presque noirs.
        func dark(_ x: Int, _ y: Int) -> Bool {
            let index = (y * width + x) * 4
            return Int(pixels[index]) + Int(pixels[index + 1]) + Int(pixels[index + 2]) < 3 * 18
        }
        func rowDark(_ y: Int) -> Bool {
            var x = 0
            while x < width { if !dark(x, y) { return false }; x += 2 }
            return true
        }
        func columnDark(_ x: Int, from top: Int, to bottom: Int) -> Bool {
            var y = top
            while y < bottom { if !dark(x, y) { return false }; y += 2 }
            return true
        }
        var top = 0
        while top < height / 2, rowDark(top) { top += 1 }
        var bottom = height
        while bottom > height / 2, rowDark(bottom - 1) { bottom -= 1 }
        var left = 0
        while left < width / 2, columnDark(left, from: top, to: bottom) { left += 1 }
        var right = width
        while right > width / 2, columnDark(right - 1, from: top, to: bottom) { right -= 1 }

        // Une vraie bande de format (letterbox) est SYMÉTRIQUE et fait ≥ 4 % du côté. Une
        // pochette simplement sombre d'un seul côté (ciel noir…) n'est jamais recadrée.
        let horizontal = left >= width / 25 && abs(left - (width - right)) <= max(2, width / 30)
        let vertical = top >= height / 25 && abs(top - (height - bottom)) <= max(2, height / 30)
        if !horizontal { left = 0; right = width }
        if !vertical { top = 0; bottom = height }
        let cropWidth = right - left
        let cropHeight = bottom - top
        guard horizontal || vertical, cropWidth > width / 4, cropHeight > height / 4 else { return image }
        // Le résultat doit être (presque) carré : c'est la vraie pochette au milieu des bandes.
        let cropAspect = Double(cropWidth) / Double(cropHeight)
        guard cropAspect > 0.85, cropAspect < 1.18 else { return image }
        // Mémoire du contexte et `cropping` : tous deux en lignes de haut en bas.
        let rect = CGRect(x: left, y: top, width: cropWidth, height: cropHeight)
        return image.cropping(to: rect) ?? image
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
