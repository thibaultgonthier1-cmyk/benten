import CoreImage
import SwiftUI
import UIKit

/// Fond animé tiré de la pochette du morceau en cours (le « Motion Artwork » d'Apple Music).
///
/// L'arrière-plan est la pochette elle-même, agrandie, floutée, et mise en mouvement :
/// 1. une DÉRIVE lente qui évite l'effet « image figée » ;
/// 2. une PULSATION calée sur le TEMPO du morceau — la pochette respire avec la musique.
///
/// PERFORMANCE : le flou est calculé UNE fois par pochette, hors du fil principal (Core Image),
/// puis seule la position / l'échelle de l'image floutée bouge. Avant, un `.blur(radius: 55)`
/// plein écran était recalculé à chaque rafraîchissement de l'écran (jusqu'à 120 fois/s).
struct CoverBackdrop: View {
    let track: Track?
    let playing: Bool
    let bpm: Double?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Theme.ink

            if let image {
                if reduceMotion {
                    layer(image, scale: 1.2)
                } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                        let seconds = context.date.timeIntervalSinceReferenceDate
                        let driftX = sin(seconds / 9) * 14
                        let driftY = cos(seconds / 12) * 10
                        // Une période = un temps du morceau (100 BPM si le tempo est inconnu).
                        let beat = 60 / max(60, min(180, bpm ?? 100))
                        let phase = seconds.truncatingRemainder(dividingBy: beat) / beat
                        let pulse = playing ? 0.025 * pow(max(0, cos(phase * 2 * .pi)), 3) : 0
                        layer(image, scale: 1.22 + pulse)
                            .offset(x: driftX, y: driftY)
                    }
                }
            }

            // Voile : garantit la lisibilité du texte quelle que soit la pochette.
            LinearGradient(
                colors: [Color.black.opacity(0.22), Color.black.opacity(0.35), Color.black.opacity(0.68)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .animation(.easeInOut(duration: 0.6), value: track?.id)
        .ignoresSafeArea()
        .task(id: track?.id) {
            guard let track else {
                image = nil
                return
            }
            if let hit = BlurredArtwork.cached(track) {
                image = hit
                return
            }
            let blurred = await BlurredArtwork.make(track)
            if !Task.isCancelled {
                withAnimation(.easeInOut(duration: 0.5)) { image = blurred }
            }
        }
    }

    private func layer(_ image: UIImage, scale: CGFloat) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            .scaleEffect(scale)
            .clipped()
            .transition(.opacity)
    }
}

/// Pochettes floutées, préparées une fois et gardées en mémoire.
enum BlurredArtwork {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 12
        return cache
    }()
    private static let context = CIContext(options: [.useSoftwareRenderer: false])

    static func cached(_ track: Track) -> UIImage? {
        cache.object(forKey: track.id.uuidString as NSString)
    }

    static func make(_ track: Track) async -> UIImage? {
        guard let thumbnail = await ArtworkCache.shared.load(for: track, maxPixel: 260) else { return nil }
        let key = track.id.uuidString as NSString
        let blurred = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            blur(thumbnail)
        }.value
        if let blurred { cache.setObject(blurred, forKey: key) }
        return blurred
    }

    /// Flou gaussien + légère saturation, recadré à la taille d'origine (pas de bords gris).
    nonisolated private static func blur(_ image: UIImage) -> UIImage? {
        guard let cg = image.cgImage else { return nil }
        let input = CIImage(cgImage: cg)
        let extent = input.extent
        let blurred = input
            .clampedToExtent()
            .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 14])
            .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1.35, kCIInputBrightnessKey: -0.02])
            .cropped(to: extent)
        guard let output = context.createCGImage(blurred, from: extent) else { return nil }
        return UIImage(cgImage: output)
    }
}
