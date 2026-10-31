import AVFoundation
import Foundation
import SwiftUI

/// Horloge de lecture, isolée du reste du lecteur.
///
/// POURQUOI UN OBJET SÉPARÉ
/// `@Published` sur un `ObservableObject` prévient TOUTES les vues qui l'observent, à chaque
/// changement. Avec `position` publiée par le lecteur lui-même, la grille des pochettes se
/// redessinait 4 fois par seconde — c'est exactement ce qui rend une interface « pâteuse ».
///
/// Ici, seules les vues qui affichent un temps (barre de progression, minuteur) observent cette
/// horloge. La bibliothèque ne bronche plus pendant la lecture.
@MainActor
final class PlaybackClock: ObservableObject {
    @Published var position: Double = 0
    @Published var duration: Double = 0

    var progress: Double {
        guard duration > 0 else { return 0 }
        return min(1, max(0, position / duration))
    }

    func formatted(_ value: Double) -> String {
        guard value.isFinite, value >= 0 else { return "0:00" }
        let total = Int(value.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// Retour haptique léger, comme les apps Apple : confirme un geste sans bruit.
@MainActor
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let selection = UISelectionFeedbackGenerator()

    static func tap() {
        light.prepare()
        light.impactOccurred(intensity: 0.6)
    }

    static func press() {
        soft.prepare()
        soft.impactOccurred(intensity: 0.5)
    }

    static func choose() {
        selection.prepare()
        selection.selectionChanged()
    }
}

/// Animation commune : ressort court, jamais mou, jamais élastique à l'excès.
enum Motion {
    static let spring = Animation.spring(response: 0.34, dampingFraction: 0.82)
    static let quick = Animation.spring(response: 0.22, dampingFraction: 0.9)
    static let appear = Animation.spring(response: 0.45, dampingFraction: 0.86)
}
