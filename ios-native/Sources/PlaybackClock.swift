import AVFoundation
import Foundation
import SwiftUI

/// Horloge de lecture, isolée du reste du lecteur.
///
/// POURQUOI UN OBJET SÉPARÉ
/// `@Published` sur un `ObservableObject` prévient TOUTES les vues qui l'observent, à chaque
/// changement. Seules les vues qui affichent un temps (barre de progression, minuteur) observent
/// cette horloge : la bibliothèque et les onglets ne se redessinent pas pendant la lecture.
@MainActor
final class PlaybackClock: ObservableObject {
    @Published var position: Double = 0
    @Published var duration: Double = 0
    /// Secondes restantes du minuteur de sommeil (nil = inactif). Ici et pas dans le lecteur :
    /// sinon tous les onglets se redessineraient chaque seconde.
    @Published var sleepRemaining: Int?

    var progress: Double {
        guard duration > 0 else { return 0 }
        return min(1, max(0, position / duration))
    }

    func formatted(_ value: Double) -> String {
        guard value.isFinite, value >= 0 else { return "0:00" }
        let total = Int(value.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// Retour haptique léger, comme les apps Apple : confirme un geste sans bruit.
@MainActor
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private static let selection = UISelectionFeedbackGenerator()

    static func tap() {
        light.prepare()
        light.impactOccurred(intensity: 0.6)
    }

    static func press() {
        soft.prepare()
        soft.impactOccurred(intensity: 0.7)
    }

    static func tick() {
        rigid.prepare()
        rigid.impactOccurred(intensity: 0.45)
    }

    static func choose() {
        selection.prepare()
        selection.selectionChanged()
    }
}

/// Animations communes : ressorts courts, jamais mous, jamais élastiques à l'excès.
enum Motion {
    static let spring = Animation.spring(response: 0.38, dampingFraction: 0.84)
    static let quick = Animation.spring(response: 0.24, dampingFraction: 0.86)
    static let appear = Animation.spring(response: 0.45, dampingFraction: 0.86)
    /// Ouverture/fermeture du lecteur plein écran (proche de la courbe d'Apple Music).
    static let sheet = Animation.spring(response: 0.42, dampingFraction: 0.9)
    /// Pochette qui grossit à la lecture / rétrécit en pause, comme Apple Music.
    static let artwork = Animation.spring(response: 0.5, dampingFraction: 0.72)
}

/// Bouton qui « s'enfonce » au toucher (pochettes, cartes, boutons pleins).
///
/// Basé sur `configuration.isPressed` : aucun geste supplémentaire, donc AUCUN conflit avec le
/// défilement (l'ancien `DragGesture(minimumDistance: 0)` sur chaque tuile gênait le scroll).
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.95

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .brightness(configuration.isPressed ? -0.06 : 0)
            .animation(.spring(response: 0.26, dampingFraction: 0.68), value: configuration.isPressed)
    }
}

/// Bouton de transport (précédent / lecture / suivant) : halo circulaire au toucher, comme
/// Apple Music.
struct TransportStyle: ButtonStyle {
    var haloSize: CGFloat = 64

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                Circle()
                    .fill(Color.white.opacity(configuration.isPressed ? 0.16 : 0))
                    .frame(width: haloSize, height: haloSize)
            )
            .scaleEffect(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.62), value: configuration.isPressed)
    }
}
