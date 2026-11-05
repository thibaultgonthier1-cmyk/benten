import CoreMotion
import SwiftUI

// MARK: - Inclinaison de l'iPhone (pour l'effet holographique)

/// Inclinaison du téléphone, lissée, entre −1 et 1 sur chaque axe. Un seul capteur partagé,
/// allumé seulement quand une pochette animée est à l'écran (compteur d'utilisateurs).
@MainActor
final class TiltModel: ObservableObject {
    static let shared = TiltModel()

    @Published private(set) var x: Double = 0
    @Published private(set) var y: Double = 0

    private let manager = CMMotionManager()
    private var users = 0
    private var referenceRoll: Double?
    private var referencePitch: Double = 0

    func retain() {
        users += 1
        if users == 1 { start() }
    }

    func release() {
        users = max(0, users - 1)
        guard users == 0 else { return }
        manager.stopDeviceMotionUpdates()
        referenceRoll = nil
        x = 0
        y = 0
    }

    private func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 60.0
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            guard let motion else { return }
            let roll = motion.attitude.roll
            let pitch = motion.attitude.pitch
            MainActor.assumeIsolated { self?.update(roll: roll, pitch: pitch) }
        }
    }

    private func update(roll: Double, pitch: Double) {
        // La position « neutre » suit lentement la façon dont on tient le téléphone : seul le
        // mouvement compte, jamais la posture.
        guard let reference = referenceRoll else {
            referenceRoll = roll
            referencePitch = pitch
            return
        }
        referenceRoll = reference + (roll - reference) * 0.008
        referencePitch += (pitch - referencePitch) * 0.008
        let targetX = max(-1, min(1, (roll - reference) / 0.35))
        let targetY = max(-1, min(1, (pitch - referencePitch) / 0.35))
        let nextX = x + (targetX - x) * 0.18
        let nextY = y + (targetY - y) * 0.18
        if abs(nextX - x) > 0.002 { x = nextX }
        if abs(nextY - y) > 0.002 { y = nextY }
    }
}

// MARK: - Reflet holographique

/// Reflet irisé (cyan → violet → rose → or) qui tourne lentement et suit l'inclinaison, plus un
/// point de lumière qui glisse sur la pochette : la pochette reste la même, mais elle « vit »
/// comme une carte holographique.
struct HoloSheen: View {
    let time: Double
    let tiltX: Double
    let tiltY: Double
    var strength: Double = 1

    var body: some View {
        let angle = time * 0.22 + tiltX * 1.3
        let c = cos(angle)
        let s = sin(angle)
        ZStack {
            LinearGradient(
                colors: [
                    .clear,
                    Color(red: 0.30, green: 1.00, blue: 0.95).opacity(0.22),
                    Color(red: 0.62, green: 0.42, blue: 1.00).opacity(0.20),
                    Color(red: 1.00, green: 0.42, blue: 0.76).opacity(0.18),
                    Color(red: 1.00, green: 0.88, blue: 0.40).opacity(0.16),
                    .clear
                ],
                startPoint: UnitPoint(x: 0.5 - c * 0.85, y: 0.5 - s * 0.85),
                endPoint: UnitPoint(x: 0.5 + c * 0.85, y: 0.5 + s * 0.85)
            )
            .blendMode(.colorDodge)
            .opacity(0.6 * strength)

            RadialGradient(
                colors: [Color.white.opacity(0.30 * strength), .clear],
                center: UnitPoint(x: 0.5 + tiltX * 0.45 + 0.18 * sin(time * 0.37),
                                  y: 0.38 + tiltY * 0.35 + 0.08 * cos(time * 0.29)),
                startRadius: 0,
                endRadius: 280
            )
            .blendMode(.softLight)
        }
        .allowsHitTesting(false)
    }
}

/// Ajoute le reflet holographique + une légère inclinaison 3D qui suit le téléphone.
struct HolographicModifier: ViewModifier {
    @ObservedObject private var tilt = TiltModel.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("livingArtwork") private var enabled = true

    func body(content: Content) -> some View {
        if enabled && !reduceMotion {
            content
                .overlay {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                        HoloSheen(time: context.date.timeIntervalSinceReferenceDate,
                                  tiltX: tilt.x, tiltY: tilt.y, strength: 0.8)
                    }
                }
                .rotation3DEffect(.degrees(tilt.x * 7), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
                .rotation3DEffect(.degrees(-tilt.y * 5), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
                .onAppear { tilt.retain() }
                .onDisappear { tilt.release() }
        } else {
            content
        }
    }
}

extension View {
    func holographic() -> some View { modifier(HolographicModifier()) }
}

// MARK: - Pochette animée plein écran

/// Pochette ANIMÉE du lecteur (comme les pochettes animées d'Apple Music) : la pochette du
/// morceau prend toute la largeur en haut de l'écran, bord à bord, et se fond dans le fond.
/// Elle reste la même image, mais elle vit :
/// - zoom lent et dérive en ellipse (≈ 20 s), comme une caméra qui respire ;
/// - parallaxe : elle glisse légèrement quand on incline le téléphone ;
/// - reflet holographique irisé qui tourne et suit l'inclinaison ;
/// - pulsation discrète sur le tempo du morceau.
/// En pause, tout se fige en douceur.
struct LivingArtwork: View {
    let track: Track
    let playing: Bool
    let bpm: Double?
    let height: CGFloat

    @ObservedObject private var tilt = TiltModel.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let width = UIScreen.main.bounds.width
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: !playing || reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let zoom = 1.09 + 0.045 * sin(t * 2 * .pi / 21)
            let beat = 60 / max(60, min(180, bpm ?? 100))
            let phase = t.truncatingRemainder(dividingBy: beat) / beat
            let pulse = playing ? 0.012 * pow(max(0, cos(phase * 2 * .pi)), 4) : 0
            let dx = 12 * sin(t * 2 * .pi / 17) + tilt.x * 18
            let dy = 9 * cos(t * 2 * .pi / 23) + tilt.y * 12
            ZStack {
                ArtworkView(track: track, maxPixel: 1000)
                    .frame(width: width, height: height)
                    .scaleEffect(zoom + pulse)
                    .offset(x: dx, y: dy)
                HoloSheen(time: t, tiltX: tilt.x, tiltY: tilt.y)
            }
        }
        .frame(width: width, height: height)
        .clipped()
        // Fondu vers le bas : la pochette se prolonge dans le fond, sans bord.
        .mask(
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: 0.68),
                    .init(color: .black.opacity(0.55), location: 0.84),
                    .init(color: .clear, location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        .saturation(playing ? 1 : 0.85)
        .animation(.easeInOut(duration: 0.6), value: playing)
        .onAppear { tilt.retain() }
        .onDisappear { tilt.release() }
    }
}
