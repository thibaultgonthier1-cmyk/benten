import SwiftUI
import UIKit

/// Fond animé tiré de la pochette du morceau en cours.
///
/// C'est le principe du « Motion Artwork » d'Apple Music : l'arrière-plan n'est pas une couleur
/// choisie, c'est la pochette elle-même, agrandie, floutée, et mise en mouvement. Deux mouvements
/// se superposent :
///
/// 1. une DÉRIVE lente (18 s) qui évite l'effet « image figée » ;
/// 2. une PULSATION calée sur le TEMPO du morceau — c'est ce qui donne l'impression que la pochette
///    respire avec la musique plutôt qu'au hasard.
///
/// Le tout est calculé à 30 images par seconde et désactivé si « Réduire les animations » est actif :
/// un fond animé ne doit jamais coûter de batterie pour rien.
struct CoverBackdrop: View {
    let track: Track?
    let playing: Bool
    /// Tempo du morceau, s'il a pu être estimé (sinon : pas de pulsation, juste la dérive).
    let bpm: Double?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Pochette chargée hors du fil principal. Petite (260 px) : elle est floutée à 55 px, une image
    /// fine ne servirait à rien et coûterait à décoder.
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Theme.ink

            if let image {
                if reduceMotion {
                    blurred(image, scale: 1.15, opacity: 0.5)
                } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                        let seconds = context.date.timeIntervalSinceReferenceDate
                        // Dérive : deux sinusoïdes lentes, déphasées, pour un mouvement qui ne se
                        // répète pas de façon visible.
                        let driftX = sin(seconds / 9) * 10
                        let driftY = cos(seconds / 12) * 8

                        // Pulsation : une période = un temps du morceau. Sans tempo connu, on
                        // retombe sur 100 BPM, ce qui reste crédible.
                        let beat = 60 / max(60, min(180, bpm ?? 100))
                        let phase = (seconds.truncatingRemainder(dividingBy: beat)) / beat
                        let pulse = playing ? 0.022 * sin(phase * 2 * .pi) : 0

                        blurred(image, scale: 1.18 + pulse, opacity: playing ? 0.55 : 0.45)
                            .offset(x: driftX, y: driftY)
                    }
                }
            }

            // Voile sombre : garantit que le texte reste lisible quelle que soit la pochette.
            LinearGradient(
                colors: [Color.black.opacity(0.28), Color.black.opacity(0.62)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
        .task(id: track?.id) {
            guard let track else { image = nil; return }
            if let hit = ArtworkCache.shared.cached(for: track, maxPixel: 260) {
                image = hit
                return
            }
            let loaded = await ArtworkCache.shared.load(for: track, maxPixel: 260)
            if !Task.isCancelled { image = loaded }
        }
    }

    private func blurred(_ image: UIImage, scale: CGFloat, opacity: Double) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            .blur(radius: 55)
            .scaleEffect(scale)
            .opacity(opacity)
            .clipped()
    }
}
