import SwiftUI
import UIKit

/// Cache d'images de pochettes.
///
/// POURQUOI
/// `UIImage(contentsOfFile:)` décode l'image à CHAQUE affichage. Dans une grille qu'on fait défiler,
/// c'est le poste le plus coûteux — et c'est ce qui fait saccader une interface. Ici, chaque
/// pochette est décodée une fois puis gardée en mémoire (bornée), comme le cache du bureau.
@MainActor
final class ArtworkCache {
    static let shared = ArtworkCache()

    private let cache = NSCache<NSString, UIImage>()

    private init() {
        // Borne : ~200 pochettes. Au-delà, iOS libère les plus anciennes tout seul.
        cache.countLimit = 200
    }

    /// Image d'une pochette, décodée une seule fois.
    func image(for track: Track) -> UIImage? {
        guard let url = track.artworkURL else { return nil }
        let key = url.lastPathComponent as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let image = UIImage(contentsOfFile: url.path) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// Teinte dominante, calculée une fois par pochette (elle sert au halo).
    private var tints: [String: UIColor] = [:]

    func tint(for track: Track) -> Color {
        guard let url = track.artworkURL else { return Theme.accent }
        let key = url.lastPathComponent
        if let known = tints[key] { return Color(uiColor: known) }
        guard let image = image(for: track) else { return Theme.accent }
        let color = image.dominantColor
        tints[key] = color
        return Color(uiColor: color)
    }

    /// Vide le cache quand la bibliothèque change (suppression, vidage).
    func invalidate() {
        cache.removeAllObjects()
        tints.removeAll()
    }
}

/// Navigation globale : permet à n'importe quelle vue de changer d'onglet.
///
/// Sans ça, le bouton « Rechercher » de la bibliothèque ne pouvait pas basculer sur l'onglet
/// Recherche — c'était l'une des plaintes : impossible d'accéder aux réglages ou à la recherche
/// quand on écoutait un morceau.
@MainActor
final class AppRouter: ObservableObject {
    enum Tab: Int { case library = 0, search = 1, settings = 2 }
    @Published var tab: Tab = .library
}

