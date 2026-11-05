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
///
/// LATENCE : Apple le dit noir sur blanc — appeler `prepare()` JUSTE avant `impactOccurred()` ne
/// sert à rien, le moteur Taptic a besoin d'un court délai pour se réveiller (≈ 200 ms à froid
/// contre une poignée de ms une fois prêt). Avant, chaque retour faisait « prepare puis vibre » :
/// toujours à froid. Désormais :
/// - les générateurs sont préparés au lancement (`warmUp`) ;
/// - ils sont RE-préparés juste APRÈS chaque retour (le suivant, quelques secondes plus tard,
///   part à chaud) ;
/// - les boutons les préparent dès l'APPUI du doigt (`PressableStyle`) : le retour du relâcher,
///   ~100 ms plus tard, tombe pile avec l'animation.
@MainActor
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private static let selection = UISelectionFeedbackGenerator()

    /// Réveille le moteur pour les secondes qui suivent (appui du doigt, lancement).
    static func warmUp() {
        light.prepare()
        soft.prepare()
        selection.prepare()
    }

    static func tap() {
        light.impactOccurred(intensity: 0.6)
        light.prepare()
    }

    static func press() {
        soft.impactOccurred(intensity: 0.7)
        soft.prepare()
    }

    static func tick() {
        rigid.impactOccurred(intensity: 0.45)
        rigid.prepare()
    }

    static func choose() {
        selection.selectionChanged()
        selection.prepare()
    }
}

/// Animations communes : ressorts courts, jamais mous, jamais élastiques à l'excès.
///
/// Un ressort démarre à la vitesse du geste dès l'image suivante (contrairement à une courbe
/// ease-in qui « traîne » au départ) : c'est ce qui donne la sensation de réponse immédiate.
/// À 120 Hz (ProMotion), l'enfoncement (`pressIn`, réponse 0,14 s ≈ 17 images) est déjà
/// nettement visible à la 2e image. Amortis ≥ 0,86 : pas de dépassement perceptible (WWDC18/23).
enum Motion {
    static let spring = Animation.spring(response: 0.34, dampingFraction: 0.86)
    static let quick = Animation.spring(response: 0.24, dampingFraction: 0.88)
    static let appear = Animation.spring(response: 0.42, dampingFraction: 0.86)
    /// Ouverture/fermeture du lecteur plein écran (proche de la courbe d'Apple Music).
    static let sheet = Animation.spring(response: 0.42, dampingFraction: 0.9)
    /// Pochette qui grossit à la lecture / rétrécit en pause, comme Apple Music.
    static let artwork = Animation.spring(response: 0.5, dampingFraction: 0.72)
    /// Enfoncement au toucher : quasi instantané, sans rebond (le doigt « pousse » l'élément).
    static let pressIn = Animation.spring(response: 0.14, dampingFraction: 0.92)
    /// Relâchement : `.snappy` court (rebond de base 0,15, à peine perceptible). WWDC18 « Designing
    /// Fluid Interfaces » : pas de dépassement sans geste à élan ; l'ancien amorti 0,62–0,68
    /// faisait « gigoter » les boutons.
    static let pressOut = Animation.snappy(duration: 0.25)
}

/// Bouton qui « s'enfonce » au toucher (pochettes, cartes, boutons pleins).
///
/// Basé sur `configuration.isPressed` : aucun geste supplémentaire, donc AUCUN conflit avec le
/// défilement (l'ancien `DragGesture(minimumDistance: 0)` sur chaque tuile gênait le scroll).
///
/// FLUIDITÉ : l'ancien ressort (0,26 s, amorti 0,68) servait aux deux sens — l'enfoncement
/// arrivait mou et « flottait » ; et `.brightness` ajoutait un filtre de couleur sur toute la
/// tuile (pochette comprise) en permanence. Désormais : enfoncement en ~2 images (`pressIn`),
/// relâchement `.snappy` (`pressOut`), léger voile d'opacité UNIQUEMENT pendant l'appui, et moteur
/// haptique réveillé dès que le doigt se pose.
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.95

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(configuration.isPressed ? Motion.pressIn : Motion.pressOut, value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, pressed in
                // Rappel livré sur le fil principal ; `assumeIsolated` l'affirme au compilateur.
                if pressed { MainActor.assumeIsolated { Haptics.warmUp() } }
            }
    }
}

/// Bouton de transport (précédent / lecture / suivant) : halo circulaire au toucher, comme
/// Apple Music. Même logique : halo et enfoncement immédiats à l'appui, ressort au relâcher.
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
            .animation(configuration.isPressed ? Motion.pressIn : Motion.pressOut, value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, pressed in
                // Rappel livré sur le fil principal ; `assumeIsolated` l'affirme au compilateur.
                if pressed { MainActor.assumeIsolated { Haptics.warmUp() } }
            }
    }
}
