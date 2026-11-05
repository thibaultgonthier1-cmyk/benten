import CoreMotion
import SwiftUI
import UIKit

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
        // On GARDE la dernière inclinaison : à la reprise, la nouvelle position neutre la ramène
        // en douceur vers 0 (lissage). Remettre x/y à 0 ici faisait sauter le reflet et la
        // parallaxe à chaque pause / reprise.
        referenceRoll = nil
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

// MARK: - Autorisation des animations d'ambiance

/// Les mêmes garde-fous qu'Apple pour ses pochettes animées : en mode Économie d'énergie, quand
/// l'iPhone chauffe (état thermique « sérieux » ou pire) ou quand « Lecture auto. des aperçus
/// vidéo » est désactivée, la pochette et le fond restent IMMOBILES (image fixe, zéro calcul).
/// « Réduire les animations » est géré à part, par l'environnement SwiftUI.
@MainActor
final class AmbientMotion: ObservableObject {
    static let shared = AmbientMotion()

    @Published private(set) var allowed = true
    private var observers: [NSObjectProtocol] = []

    private init() {
        refresh()
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            .NSProcessInfoPowerStateDidChange,
            ProcessInfo.thermalStateDidChangeNotification,
            UIAccessibility.videoAutoplayStatusDidChangeNotification
        ]
        for name in names {
            // Ces notifications peuvent arriver sur n'importe quel fil : on repasse sur le principal.
            let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
            observers.append(token)
        }
    }

    private func refresh() {
        let info = ProcessInfo.processInfo
        let hot = info.thermalState == .serious || info.thermalState == .critical
        let next = !info.isLowPowerModeEnabled && !hot && UIAccessibility.isVideoAutoplayEnabled
        if next != allowed { allowed = next }
    }
}

// MARK: - Horloge d'animation

/// Horloge qui n'avance QUE pendant la lecture : en pause tout se fige, et à la reprise le
/// mouvement repart exactement d'où il s'était arrêté (aucun saut).
struct MotionClock {
    private var elapsed: Double = 0
    private var resumedAt: Date?

    func time(at date: Date) -> Double {
        guard let resumedAt else { return elapsed }
        return elapsed + max(0, date.timeIntervalSince(resumedAt))
    }

    mutating func set(running: Bool, at date: Date = Date()) {
        if running {
            if resumedAt == nil { resumedAt = date }
        } else if let since = resumedAt {
            elapsed += max(0, date.timeIntervalSince(since))
            resumedAt = nil
        }
    }
}

// MARK: - Reflet holographique

/// Reflet irisé (cyan → violet → rose → or) qui tourne lentement et suit l'inclinaison, plus une
/// fine bande de lumière qui glisse sur la pochette : la pochette reste la même, mais elle « vit »
/// comme une carte holographique.
///
/// SANS ARTEFACT :
/// - l'irisation est en `softLight` : elle teinte les tons moyens sans jamais brûler les clairs
///   (l'ancien `colorDodge` faisait exploser les pochettes claires en blanc) ni griser les noirs ;
/// - la lumière est en `screen` : elle ne peut jamais dépasser le blanc ;
/// - dégradés à nombreux arrêts et pente marquée : pas de marches visibles (banding) ;
/// - découpé par l'appelant à la forme exacte de la pochette.
struct HoloSheen: View {
    let time: Double
    let tiltX: Double
    let tiltY: Double
    var strength: Double = 1

    var body: some View {
        let angle = time * 0.18 + tiltX * 1.1
        let c = cos(angle)
        let s = sin(angle)
        // Position de la bande de lumière (0…1 le long de la diagonale), toujours dans le cadre.
        let glint = CGFloat(min(0.82, max(0.18, 0.5 + 0.32 * tiltX + 0.14 * sin(time * 0.21))))
        ZStack {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: Color(red: 0.30, green: 1.00, blue: 0.95).opacity(0.55), location: 0.22),
                    .init(color: Color(red: 0.62, green: 0.42, blue: 1.00).opacity(0.55), location: 0.40),
                    .init(color: Color(red: 1.00, green: 0.42, blue: 0.76).opacity(0.50), location: 0.58),
                    .init(color: Color(red: 1.00, green: 0.88, blue: 0.40).opacity(0.45), location: 0.76),
                    .init(color: .clear, location: 1)
                ],
                startPoint: UnitPoint(x: 0.5 - c * 0.8, y: 0.5 - s * 0.8),
                endPoint: UnitPoint(x: 0.5 + c * 0.8, y: 0.5 + s * 0.8)
            )
            .blendMode(.softLight)
            .opacity(0.7 * strength)

            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .clear, location: glint - 0.16),
                    .init(color: .white.opacity(0.05), location: glint - 0.07),
                    .init(color: .white.opacity(0.13), location: glint),
                    .init(color: .white.opacity(0.05), location: glint + 0.07),
                    .init(color: .clear, location: glint + 0.16),
                    .init(color: .clear, location: 1)
                ],
                startPoint: UnitPoint(x: 0, y: 0.15 + tiltY * 0.1),
                endPoint: UnitPoint(x: 1, y: 0.85 - tiltY * 0.1)
            )
            .blendMode(.screen)
            .opacity(strength)
        }
        .allowsHitTesting(false)
    }
}

/// Abonnement au capteur d'inclinaison : actif SEULEMENT si la vue est affichée, l'app au premier
/// plan et `wanted` vrai. En arrière-plan (écran verrouillé, musique qui tourne), le capteur est
/// coupé : zéro batterie gaspillée.
///
/// Le capteur démarre 0,45 s APRÈS l'apparition : son démarrage (quelques ms sur le fil principal)
/// ne tombe jamais pendant l'animation d'ouverture du lecteur.
struct TiltSubscription: ViewModifier {
    let wanted: Bool
    @Environment(\.scenePhase) private var phase
    @State private var visible = false
    @State private var holding = false

    func body(content: Content) -> some View {
        content
            .task {
                try? await Task.sleep(nanoseconds: 450_000_000)
                guard !Task.isCancelled else { return }
                visible = true
                sync()
            }
            .onDisappear { visible = false; sync() }
            .onChange(of: phase) { _, _ in sync() }
            .onChange(of: wanted) { _, _ in sync() }
    }

    private func sync() {
        let should = visible && wanted && phase == .active
        guard should != holding else { return }
        holding = should
        if should { TiltModel.shared.retain() } else { TiltModel.shared.release() }
    }
}

/// Ajoute le reflet holographique + une légère inclinaison 3D qui suit le téléphone. Le reflet
/// est découpé EXACTEMENT à la forme de la pochette (carré arrondi, rond…) : rien ne déborde.
struct HolographicModifier: ViewModifier {
    @ObservedObject private var tilt = TiltModel.shared
    @ObservedObject private var ambient = AmbientMotion.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("livingArtwork") private var enabled = true

    func body(content: Content) -> some View {
        if enabled && !reduceMotion {
            content
                .overlay {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !ambient.allowed)) { context in
                        HoloSheen(time: context.date.timeIntervalSinceReferenceDate,
                                  tiltX: tilt.x, tiltY: tilt.y, strength: 0.8)
                    }
                    .mask(content)
                }
                // Les modes de fusion du reflet ne s'appliquent qu'à la pochette, jamais au décor.
                .compositingGroup()
                .rotation3DEffect(.degrees(tilt.x * 7), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
                .rotation3DEffect(.degrees(-tilt.y * 5), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
                .modifier(TiltSubscription(wanted: ambient.allowed))
        } else {
            content
        }
    }
}

extension View {
    func holographic() -> some View { modifier(HolographicModifier()) }
}

// MARK: - Pochette animée plein écran

/// Image prête à dessiner pour un morceau (pochette nette + version floutée).
struct ArtFace {
    let id: UUID
    let image: UIImage?
    let blurred: UIImage?

    /// Largeur / hauteur de la pochette (1 si inconnue).
    var aspect: CGFloat {
        guard let image, image.size.height > 0 else { return 1 }
        return image.size.width / image.size.height
    }

    /// Vignette nette déjà en mémoire (aucun décodage) : la plus grande disponible.
    static func cachedImage(_ track: Track) -> UIImage? {
        let cache = ArtworkCache.shared
        return cache.cached(for: track, maxPixel: 1000)
            ?? cache.cached(for: track, maxPixel: 700)
            ?? cache.cached(for: track, maxPixel: 560)
    }

    static func cached(_ track: Track) -> ArtFace? {
        guard let image = cachedImage(track) else { return nil }
        return ArtFace(id: track.id, image: image, blurred: BlurredArtwork.cached(track))
    }
}

/// Pochette ANIMÉE du lecteur (comme les pochettes animées d'Apple Music) : même image, mais
/// vivante.
///
/// Deux présentations :
/// - BORD À BORD (`fullBleed`) : pleine largeur, ENTIÈRE, juste sous la barre d'état ; au-dessus,
///   la pochette se prolonge en miroir flouté jusqu'en haut de l'écran (sans couture), et son bas
///   se fond dans le fond du lecteur. La hauteur suit le format de la pochette (une pochette 16:9
///   occupe 16:9, sans bandes) ;
/// - CARTE (petits écrans, iPad) : carré arrondi centré, ombre douce.
///
/// Mouvement (toujours borné : jamais de bord vide, la pochette reste visible à ≥ 98 %) :
/// - respiration lente et dérive en ellipse (≈ 20 s) ;
/// - parallaxe discrète quand on incline le téléphone ;
/// - reflet holographique irisé qui tourne et suit l'inclinaison ;
/// - pulsation légère sur le tempo du morceau.
/// En pause, en mode Économie d'énergie ou si l'iPhone chauffe : tout se fige, puis repart
/// exactement d'où il s'était arrêté.
///
/// Changement de morceau : fondu enchaîné INTERNE (la nouvelle pochette se pose sur l'ancienne,
/// le mouvement continue sans redémarrer) — aucun passage par le fond.
struct LivingArtwork: View {
    let track: Track
    let playing: Bool
    let bpm: Double?
    /// Taille de la pochette elle-même (hors prolongement du haut).
    let size: CGSize
    var fullBleed: Bool = true
    /// Hauteur du prolongement en miroir au-dessus de la pochette (zone de la barre d'état).
    var topBleed: CGFloat = 0
    var cornerRadius: CGFloat = 0
    /// Format de la pochette affichée, remonté au lecteur pour sa mise en page.
    @Binding var aspect: CGFloat?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var ambient = AmbientMotion.shared
    @State private var base: ArtFace?
    @State private var incoming: ArtFace?
    @State private var clock = MotionClock()

    init(track: Track, playing: Bool, bpm: Double?, size: CGSize, fullBleed: Bool = true,
         topBleed: CGFloat = 0, cornerRadius: CGFloat = 0, aspect: Binding<CGFloat?>) {
        self.track = track
        self.playing = playing
        self.bpm = bpm
        self.size = size
        self.fullBleed = fullBleed
        self.topBleed = topBleed
        self.cornerRadius = cornerRadius
        _aspect = aspect
        // Pochette déjà décodée (préparée dès le début du morceau) : visible dès la première
        // image de l'ouverture, sans fondu ni attente.
        _base = State(initialValue: ArtFace.cached(track))
    }

    /// Format de la pochette en mémoire, sans décodage (pour la mise en page du lecteur).
    static func cachedAspect(_ track: Track?) -> CGFloat? {
        guard let track, let image = ArtFace.cachedImage(track), image.size.height > 0 else { return nil }
        return image.size.width / image.size.height
    }

    private var animating: Bool { playing && !reduceMotion && ambient.allowed }

    var body: some View {
        let bleed = fullBleed ? max(0, topBleed) : 0
        let total = CGSize(width: size.width, height: size.height + bleed)
        // Ambiance lente : 60 images/s suffisent (et suivent l'inclinaison sans retard) ; les
        // 120 Hz restent réservés aux gestes (glisser, fermer).
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: !animating)) { context in
            let t = clock.time(at: context.date)
            // Dernière inclinaison connue, gardée telle quelle en pause : rien ne saute.
            let tiltX = TiltModel.shared.x
            let tiltY = TiltModel.shared.y
            let motion = ArtMotion(t: t, date: context.date, pulsing: animating, bpm: bpm,
                                   tiltX: tiltX, tiltY: tiltY, size: size)
            ZStack(alignment: .top) {
                if let base {
                    faceStack(base, bleed: bleed, motion: motion)
                        .id(base.id)
                }
                if let incoming {
                    faceStack(incoming, bleed: bleed, motion: motion)
                        .id(incoming.id)
                        .transition(.opacity)
                }
                if base == nil && incoming == nil {
                    placeholder
                        .frame(width: size.width, height: size.height)
                        .padding(.top, bleed)
                }
                // Reflet holographique, sur la pochette seulement (pas sur le prolongement).
                HoloSheen(time: t, tiltX: tiltX, tiltY: tiltY, strength: fullBleed ? 0.9 : 0.8)
                    .frame(width: size.width, height: size.height)
                    .padding(.top, bleed)
            }
            .frame(width: total.width, height: total.height, alignment: .top)
        }
        .frame(width: total.width, height: total.height)
        // Le reflet ne se fond qu'avec la pochette, puis tout est découpé à la forme exacte.
        .compositingGroup()
        .clipShape(RoundedRectangle(cornerRadius: fullBleed ? 0 : cornerRadius, style: .continuous))
        .mask { fadeMask(bleed: bleed, total: total.height) }
        .saturation(playing ? 1 : 0.85)
        .animation(.easeInOut(duration: 0.6), value: playing)
        .modifier(TiltSubscription(wanted: animating))
        .onAppear {
            clock.set(running: animating)
            if let shown = incoming ?? base, aspect != shown.aspect { aspect = shown.aspect }
        }
        // L'horloge n'avance que lorsque la pochette bouge vraiment : aucun saut à la reprise.
        .onChange(of: animating) { _, moving in clock.set(running: moving) }
        .task(id: track.id) { await present(track) }
    }

    // MARK: Dessin

    /// Une pochette complète : prolongement en miroir (bord à bord) + pochette animée.
    private func faceStack(_ face: ArtFace, bleed: CGFloat, motion: ArtMotion) -> some View {
        VStack(spacing: 0) {
            if bleed > 0 {
                mirror(face, height: bleed)
            }
            cover(face, motion: motion)
                .frame(width: size.width, height: size.height)
                .clipped()
        }
        .background(Theme.ink)
    }

    /// La pochette, animée À L'INTÉRIEUR de son cadre (zoom ≥ 1, déplacement borné par la marge
    /// du zoom) : aucun bord ne peut apparaître.
    @ViewBuilder
    private func cover(_ face: ArtFace, motion: ArtMotion) -> some View {
        Group {
            if let image = face.image {
                let frameAspect = size.width / max(1, size.height)
                if abs(face.aspect - frameAspect) <= frameAspect * 0.04 {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    // Format inhabituel (portrait, très large) : pochette ENTIÈRE sur sa propre
                    // version floutée — jamais de bandes noires, rien de coupé.
                    ZStack {
                        Image(uiImage: face.blurred ?? image)
                            .resizable()
                            .scaledToFill()
                            .opacity(face.blurred == nil ? 0.5 : 1)
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size.width, height: size.height)
        .scaleEffect(motion.scale)
        .offset(x: motion.dx, y: motion.dy)
    }

    /// Prolongement au-dessus de la pochette : son haut, retourné en miroir et flouté. Le bord du
    /// miroir touche EXACTEMENT le bord de la pochette : la couleur continue sans couture jusqu'en
    /// haut de l'écran. Un léger voile garde la barre d'état lisible sur une pochette claire.
    private func mirror(_ face: ArtFace, height: CGFloat) -> some View {
        ZStack(alignment: .bottom) {
            if let source = face.blurred ?? face.image {
                Image(uiImage: source)
                    .resizable()
                    .frame(width: size.width, height: size.height)
                    .scaleEffect(x: 1, y: -1)
                    .frame(width: size.width, height: height, alignment: .bottom)
                    .clipped()
                    .opacity(face.blurred == nil ? 0.6 : 1)
            }
            LinearGradient(colors: [.black.opacity(0.32), .black.opacity(0.06)],
                           startPoint: .top, endPoint: .bottom)
        }
        .frame(width: size.width, height: height)
        .clipped()
    }

    private var placeholder: some View {
        Theme.accentGradient
            .overlay(
                Image(systemName: "music.note")
                    .font(.system(size: 64, weight: .light))
                    .foregroundStyle(Theme.ink.opacity(0.55))
            )
    }

    /// Bord à bord : le bas de la pochette se fond dans le fond du lecteur. Carte : aucun fondu.
    private func fadeMask(bleed: CGFloat, total: CGFloat) -> some View {
        let height = max(1, total)
        let fadeStart = min(0.97, max(0.5, (bleed + size.height * 0.88) / height))
        let fadeMid = min(0.99, fadeStart + (1 - fadeStart) * 0.55)
        return LinearGradient(
            stops: fullBleed
                ? [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: fadeStart),
                    .init(color: .black.opacity(0.55), location: fadeMid),
                    .init(color: .clear, location: 1)
                ]
                : [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: 1)
                ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // MARK: Changement de pochette

    /// Charge (ou reprend du cache) la pochette du morceau, puis l'affiche en fondu enchaîné.
    private func present(_ track: Track) async {
        let shown = incoming ?? base
        if let shown, shown.id == track.id, shown.image != nil, shown.blurred != nil { return }

        let image: UIImage?
        if let hit = ArtFace.cachedImage(track) {
            image = hit
        } else {
            image = await ArtworkCache.shared.load(for: track, maxPixel: 1000)
        }
        let blurred: UIImage?
        if let hit = BlurredArtwork.cached(track) {
            blurred = hit
        } else {
            blurred = await BlurredArtwork.make(track)
        }
        guard !Task.isCancelled else { return }
        let face = ArtFace(id: track.id, image: image, blurred: blurred)

        let current = incoming ?? base
        if let current, current.id == face.id {
            // Même morceau, données complétées (flou arrivé après coup) : sur place, sans fondu.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if incoming != nil { incoming = face } else { base = face }
                aspect = face.aspect
            }
            return
        }
        show(face)
    }

    private func show(_ face: ArtFace) {
        if let pending = incoming {
            // Un fondu était en cours : il devient la base (déjà presque entièrement visible).
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                base = pending
                incoming = nil
            }
        }
        if base == nil {
            withAnimation(.easeInOut(duration: 0.4)) {
                base = face
                aspect = face.aspect
            }
            return
        }
        withAnimation(.easeInOut(duration: 0.55)) {
            incoming = face
            aspect = face.aspect
        } completion: {
            guard incoming?.id == face.id else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                base = face
                incoming = nil
            }
        }
    }
}

/// Valeurs d'animation d'une image de la pochette : zoom TRÈS léger (0,6 à 2,4 %), dérive et
/// parallaxe TOUJOURS contenues dans la marge du zoom.
private struct ArtMotion {
    let scale: CGFloat
    let dx: CGFloat
    let dy: CGFloat

    init(t: Double, date: Date, pulsing: Bool, bpm: Double?, tiltX: Double, tiltY: Double, size: CGSize) {
        let beat: Double = 60 / max(60, min(180, bpm ?? 100))
        let phase = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: beat) / beat
        let pulse: Double = pulsing ? 0.006 * pow(max(0, cos(phase * 2 * .pi)), 4) : 0
        let zoom: Double = 1.012 + 0.006 * sin(t * 2 * .pi / 21) + pulse
        let roomX = max(0, (zoom - 1) * Double(size.width) / 2 - 0.5)
        let roomY = max(0, (zoom - 1) * Double(size.height) / 2 - 0.5)
        let rawX = 3 * sin(t * 2 * .pi / 17) + tiltX * 4
        let rawY = 2 * cos(t * 2 * .pi / 23) + tiltY * 3
        scale = CGFloat(zoom)
        dx = CGFloat(max(-roomX, min(roomX, rawX)))
        dy = CGFloat(max(-roomY, min(roomY, rawY)))
    }
}
