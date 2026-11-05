import Combine
import CoreImage
import ImageIO
import Observation
import SwiftUI
import UIKit

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
    /// Fonds flous PRÉ-CALCULÉS des pochettes non carrées (même clé que la vignette). Avant, le
    /// flou était un `.blur` SwiftUI en direct : une passe de rendu hors écran par tuile et par
    /// image pendant le défilement. Ici : 48 px floutés une fois, hors du fil principal.
    private let backdrops = NSCache<NSString, UIImage>()
    nonisolated(unsafe) private static let ciContext = CIContext(options: [.cacheIntermediates: false])

    /// Tailles demandées par l'interface (en pixels) — sert à oublier toutes les variantes d'une
    /// pochette quand elle change.
    static let sizes: [CGFloat] = [180, 260, 560, 700, 1000]

    private init() {
        images.countLimit = 220
        images.totalCostLimit = 140 * 1024 * 1024
        backdrops.countLimit = 400
    }

    /// Oublie une pochette précise (toutes tailles) — quand elle vient d'être remplacée.
    func forget(fileName: String) {
        for size in Self.sizes {
            images.removeObject(forKey: "\(fileName)@\(Int(size))" as NSString)
            backdrops.removeObject(forKey: "\(fileName)@\(Int(size))" as NSString)
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

    /// Fond flou déjà prêt d'une pochette non carrée (sinon `nil`).
    func cachedBackdrop(for track: Track, maxPixel: CGFloat) -> UIImage? {
        guard let url = track.artworkURL else { return nil }
        return backdrops.object(forKey: key(url, maxPixel))
    }

    /// Pochette NETTEMENT rectangulaire (16:9…) : affichée entière, sur un fond flou d'elle-même.
    nonisolated static func isNonSquare(_ image: UIImage) -> Bool {
        guard image.size.height > 0 else { return false }
        return abs(image.size.width / image.size.height - 1) > 0.22
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
        if let hit = images.object(forKey: k) {
            // Vignette en cache mais fond flou oublié (cache plein) : on le refait, hors fil principal.
            if Self.isNonSquare(hit), backdrops.object(forKey: k) == nil {
                let backdrop = await Task.detached(priority: .userInitiated) {
                    ArtworkCache.blurredBackdrop(of: hit)
                }.value
                if let backdrop { backdrops.setObject(backdrop, forKey: k) }
            }
            return hit
        }

        // Vignette ET (si besoin) fond flou préparés dans la MÊME tâche de fond : ils arrivent
        // ensemble à l'écran, sans image intermédiaire.
        let made = await Task.detached(priority: .userInitiated) { () -> (UIImage, UIImage?)? in
            guard let image = ArtworkCache.thumbnail(at: url, maxPixel: maxPixel) else { return nil }
            let backdrop = ArtworkCache.isNonSquare(image) ? ArtworkCache.blurredBackdrop(of: image) : nil
            return (image, backdrop)
        }.value
        guard let made else { return nil }
        let image = made.0

        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        images.setObject(image, forKey: k, cost: cost)
        if let backdrop = made.1 { backdrops.setObject(backdrop, forKey: k) }
        let tintKey = url.lastPathComponent as NSString
        if tints.object(forKey: tintKey) == nil {
            tints.setObject(image.dominantColor, forKey: tintKey)
        }
        return image
    }

    /// Fond flou d'une pochette : réduite à 48 px puis floutée (Core Image). Agrandie à l'écran,
    /// elle reste douce — même rendu qu'un gros flou, pour un coût quasi nul et UNE seule fois.
    nonisolated static func blurredBackdrop(of image: UIImage) -> UIImage? {
        guard let cg = image.cgImage else { return nil }
        let source = CIImage(cgImage: cg)
        let longest = max(source.extent.width, source.extent.height)
        guard longest > 0 else { return nil }
        let scale = min(1, 48 / longest)
        let small = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let blurred = small.clampedToExtent().applyingGaussianBlur(sigma: 2.5).cropped(to: small.extent)
        guard let output = ciContext.createCGImage(blurred, from: small.extent.integral) else { return nil }
        return UIImage(cgImage: output)
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
        backdrops.removeAllObjects()
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

    /// Accès SANS abonnement, pour les vues qui ne font que CHANGER d'onglet (bouton Rechercher).
    /// Un `@EnvironmentObject router` les redessinait entièrement à chaque changement d'onglet —
    /// pile pendant l'animation de la barre : une des causes du « lag » sur les icônes.
    private(set) static weak var shared: AppRouter?

    init() { Self.shared = self }
}

/// Ce que les LISTES ont besoin de savoir du lecteur : quel morceau joue, lecture/pause, historique.
///
/// POURQUOI (cause n°1 du manque de fluidité)
/// `Player` est un `ObservableObject` : chaque `@Published` (morceau, lecture, BPM, tonalité, mix,
/// historique, ouverture du plein écran, glissé d'une bande d'égaliseur…) redessinait TOUTES les
/// vues qui l'observaient — les cinq onglets, la grille d'albums entière, la liste des titres…
/// Un simple « lecture » déclenchait 5 à 6 vagues de recalcul de toute l'interface, et
/// l'ouverture du lecteur une de plus, pile pendant son animation.
///
/// ICI
/// Objet `@Observable` : SwiftUI suit propriété par propriété QUI lit QUOI. Seules les lignes
/// VISIBLES qui lisent `currentID` se redessinent quand le morceau change ; seule la ligne en
/// cours lit `playing`. Les listes parentes ne bougent plus du tout.
/// Pour AGIR (lire, mélanger…), on passe par `player` — sans abonnement.
@MainActor
@Observable
final class NowPlayingState {
    static let shared = NowPlayingState()

    private(set) var currentID: UUID?
    private(set) var playing = false
    private(set) var history: [UUID] = []

    @ObservationIgnored private(set) weak var player: Player?
    @ObservationIgnored private var subscriptions: Set<AnyCancellable> = []

    /// Branche l'état sur le lecteur (une fois, au lancement).
    func bind(to player: Player) {
        guard self.player !== player else { return }
        self.player = player
        subscriptions.removeAll()
        currentID = player.current?.id
        playing = player.playing
        history = player.history
        // `@Published` émet de façon synchrone, sur le fil principal : la copie est à jour dans
        // la même transaction que le lecteur (aucun retard d'une image).
        player.$current
            .map { $0?.id }
            .removeDuplicates()
            .sink { [weak self] id in self?.currentID = id }
            .store(in: &subscriptions)
        player.$playing
            .removeDuplicates()
            .sink { [weak self] value in self?.playing = value }
            .store(in: &subscriptions)
        player.$history
            .removeDuplicates()
            .sink { [weak self] value in self?.history = value }
            .store(in: &subscriptions)
    }

    // MARK: Actions (sans abonnement aux changements du lecteur)

    func play(_ tracks: [Track], startingAt index: Int) {
        player?.play(tracks, startingAt: index)
    }

    /// Lit `tracks` à partir de `track` — index cherché AU TOUCHER, pas à chaque rendu de la liste
    /// (avant : `Array(list.enumerated())` de 1000+ éléments recréé à chaque rendu).
    func play(_ tracks: [Track], from track: Track) {
        let index = tracks.firstIndex(where: { $0.id == track.id }) ?? 0
        player?.play(tracks, startingAt: index)
    }

    func playShuffled(_ tracks: [Track]) {
        player?.playShuffled(tracks)
    }
}
