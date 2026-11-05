import CoreImage
import SwiftUI
import UIKit

/// Fond animé tiré de la pochette du morceau en cours (le fond « vivant » d'Apple Music).
///
/// Trois couches, toutes calculées UNE fois par pochette, hors du fil principal :
/// 1. iOS 18+ : un DÉGRADÉ MAILLÉ (`MeshGradient`) des couleurs de la pochette, zone par zone,
///    ALIGNÉ sur la pochette à l'écran : le haut de la pochette colore le haut de l'écran, son bas
///    se prolonge vers le bas. La pochette semble s'étendre sur toute la page. Les points du
///    maillage ondulent lentement (comme le fond d'Apple Music) ;
/// 2. la pochette floutée (texture), qui dérive lentement ;
/// 3. une PULSATION calée sur le TEMPO du morceau.
///
/// BORDS : tout ce qui bouge est borné par la marge que lui donne son agrandissement, et le
/// découpage se fait APRÈS le déplacement. Avant, l'image était découpée PUIS décalée : la dérive
/// (±14 pt) faisait apparaître une bande sombre sur les côtés et en bas de l'écran.
///
/// CHANGEMENT DE MORCEAU : fondu enchaîné (la nouvelle couche se pose sur l'ancienne, opaque) :
/// aucun passage par le noir.
///
/// PAUSE : tout se fige, et repart exactement d'où il s'était arrêté.
struct CoverBackdrop: View {
    let track: Track?
    let playing: Bool
    let bpm: Double?
    /// Cadre de la pochette à l'écran (coordonnées plein écran) : le maillage de couleurs s'aligne
    /// dessus. `nil` : répartition par défaut.
    var focus: CGRect?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var ambient = AmbientMotion.shared
    @State private var base: BackdropFace?
    @State private var incoming: BackdropFace?
    @State private var clock = MotionClock()

    init(track: Track?, playing: Bool, bpm: Double?, focus: CGRect? = nil) {
        self.track = track
        self.playing = playing
        self.bpm = bpm
        self.focus = focus
        // Déjà préparé (RootView prépare le fond dès qu'un morceau démarre) : affiché dès la
        // première image de l'ouverture, sans fondu ni calcul.
        _base = State(initialValue: track.flatMap { BackdropFace.cached($0) })
    }

    private var animating: Bool { playing && !reduceMotion && ambient.allowed }

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            let rows = MeshRows(focus: focus, height: size.height)
            // Ambiance lente : 30 images/s suffisent (recommandation Apple pour un mouvement de
            // fond) ; les 120 Hz restent aux gestes. Figé en pause, en Économie d'énergie, à chaud.
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !animating)) { context in
                let motion = BackdropMotion(
                    t: reduceMotion ? 0 : clock.time(at: context.date),
                    date: context.date,
                    pulsing: animating,
                    bpm: bpm,
                    size: size
                )
                ZStack {
                    Theme.ink
                    if let base {
                        BackdropLayer(face: base, size: size, rows: rows, motion: motion)
                            .id(base.id)
                    }
                    if let incoming {
                        BackdropLayer(face: incoming, size: size, rows: rows, motion: motion)
                            .id(incoming.id)
                            .transition(.opacity)
                    }
                }
                .frame(width: size.width, height: size.height)
            }
            // Voile : garantit la lisibilité du texte quelle que soit la pochette.
            .overlay(
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.16), location: 0),
                        .init(color: .black.opacity(0.26), location: 0.45),
                        .init(color: .black.opacity(0.62), location: 1)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            // Découpage APRÈS les mouvements : rien ne dépasse, aucun bord ne se découvre.
            .frame(width: size.width, height: size.height)
            .clipped()
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        // L'horloge n'avance que lorsque le fond bouge vraiment : aucun saut à la reprise.
        .onAppear { clock.set(running: animating) }
        .onChange(of: animating) { _, moving in clock.set(running: moving) }
        .task(id: track?.id) { await present(track) }
    }

    /// Prépare (ou reprend du cache) le fond du morceau, puis l'affiche en fondu enchaîné.
    private func present(_ track: Track?) async {
        guard let track else {
            withAnimation(.easeInOut(duration: 0.5)) {
                base = nil
                incoming = nil
            }
            return
        }
        let current = incoming ?? base
        if let current, current.id == track.id, current.complete { return }

        var face = BackdropFace.cached(track)
        if face?.complete != true {
            _ = await BlurredArtwork.make(track)
            face = BackdropFace.cached(track) ?? BackdropFace(id: track.id, image: nil, mesh: nil)
        }
        guard !Task.isCancelled, let ready = face else { return }

        let shown = incoming ?? base
        if let shown, shown.id == ready.id {
            // Même morceau, données complétées : remplacement sur place, sans fondu.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if incoming != nil { incoming = ready } else { base = ready }
            }
            return
        }
        show(ready)
    }

    private func show(_ face: BackdropFace) {
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
            // Première image : pas de couche dessous, on pose directement (fondu depuis l'encre).
            withAnimation(.easeInOut(duration: 0.45)) { base = face }
            return
        }
        withAnimation(.easeInOut(duration: 0.6)) {
            incoming = face
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

// MARK: - Couches

/// Contenu prêt à dessiner pour un morceau : pochette floutée + couleurs du maillage.
struct BackdropFace {
    let id: UUID
    let image: UIImage?
    /// 12 couleurs (3 colonnes × 4 lignes) : haut, milieu, bas de la pochette, puis bas assombri.
    let mesh: [Color]?

    var complete: Bool { image != nil && mesh != nil }

    static func cached(_ track: Track) -> BackdropFace? {
        let image = BlurredArtwork.cached(track)
        let mesh = BlurredArtwork.palette(track).flatMap(meshColors)
        guard image != nil || mesh != nil else { return nil }
        return BackdropFace(id: track.id, image: image, mesh: mesh)
    }

    /// Grille 3 × 3 de la pochette → 3 × 4 couleurs : la dernière ligne (bas de l'écran) reprend
    /// le bas de la pochette, assombri (lisibilité des commandes).
    static func meshColors(_ grid: [UIColor]) -> [Color]? {
        guard grid.count == 9 else { return nil }
        var colors = grid.map { Color(uiColor: $0) }
        colors.append(contentsOf: grid[6..<9].map { Color(uiColor: $0.darkened(0.42)) })
        return colors
    }
}

/// Lignes du maillage (fractions de la hauteur de l'écran) : milieu et bas de la pochette.
struct MeshRows {
    let middle: Float
    let bottom: Float

    init(focus: CGRect?, height: CGFloat) {
        guard let focus, height > 1 else {
            middle = 0.3
            bottom = 0.6
            return
        }
        let mid = Float(min(0.62, max(0.12, focus.midY / height)))
        middle = mid
        bottom = Float(min(0.9, max(CGFloat(mid) + 0.14, focus.maxY / height)))
    }
}

/// Valeurs d'animation d'une image du fond (dérive + pulsation), bornées pour ne JAMAIS
/// découvrir un bord.
struct BackdropMotion {
    let t: Double
    let imageScale: CGFloat
    let meshScale: CGFloat
    let dx: CGFloat
    let dy: CGFloat

    init(t: Double, date: Date, pulsing: Bool, bpm: Double?, size: CGSize) {
        // Une période = un temps du morceau (100 BPM si le tempo est inconnu).
        let beat: Double = 60 / max(60, min(180, bpm ?? 100))
        let phase = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: beat) / beat
        let pulse: Double = pulsing ? pow(max(0, cos(phase * 2 * .pi)), 3) : 0
        let scale: Double = 1.14 + 0.022 * pulse
        // Marge gagnée par l'agrandissement, de chaque côté : la dérive ne la dépasse jamais.
        let roomX = max(0, (scale - 1) * Double(size.width) / 2 - 1)
        let roomY = max(0, (scale - 1) * Double(size.height) / 2 - 1)
        self.t = t
        imageScale = CGFloat(scale)
        meshScale = CGFloat(1 + 0.018 * pulse)
        dx = CGFloat(max(-roomX, min(roomX, sin(t / 9) * 14)))
        dy = CGFloat(max(-roomY, min(roomY, cos(t / 12) * 10)))
    }
}

/// Une couche complète du fond (un morceau).
private struct BackdropLayer: View {
    let face: BackdropFace
    let size: CGSize
    let rows: MeshRows
    let motion: BackdropMotion

    var body: some View {
        ZStack {
            Theme.ink
            if #available(iOS 18.0, *) {
                MeshLayer(face: face, rows: rows, motion: motion, size: size)
            } else {
                BlurredLayer(image: face.image, size: size, motion: motion)
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

/// iOS 18+ : maillage de couleurs aligné sur la pochette + texture floutée par-dessus.
@available(iOS 18.0, *)
private struct MeshLayer: View {
    let face: BackdropFace
    let rows: MeshRows
    let motion: BackdropMotion
    let size: CGSize

    var body: some View {
        ZStack {
            if let colors = face.mesh, colors.count == 12 {
                CoverMesh(colors: colors, rows: rows, t: motion.t)
                    .scaleEffect(motion.meshScale)
                BlurredLayer(image: face.image, size: size, motion: motion)
                    .opacity(0.32)
            } else {
                BlurredLayer(image: face.image, size: size, motion: motion)
            }
        }
    }
}

/// Pochette floutée, agrandie (marge de dérive), qui dérive et pulse.
private struct BlurredLayer: View {
    let image: UIImage?
    let size: CGSize
    let motion: BackdropMotion

    var body: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: size.width, height: size.height)
                .scaleEffect(motion.imageScale)
                .offset(x: motion.dx, y: motion.dy)
        }
    }
}

/// Dégradé maillé 3 × 4 : les bords restent SUR les bords de l'écran (couverture totale), seuls
/// les points intérieurs et le long des bords ondulent lentement.
@available(iOS 18.0, *)
private struct CoverMesh: View {
    let colors: [Color]
    let rows: MeshRows
    let t: Double

    var body: some View {
        let a = Float(sin(t * 2 * .pi / 19))
        let b = Float(cos(t * 2 * .pi / 23))
        let c = Float(sin(t * 2 * .pi / 29 + 1.3))
        let d = Float(cos(t * 2 * .pi / 17 + 0.7))
        let middle: Float = rows.middle
        let bottom: Float = rows.bottom
        let topX: Float = 0.5 + 0.12 * a
        let lowX: Float = 0.5 - 0.12 * a
        let midX: Float = 0.5 + 0.1 * c
        let bottomX: Float = 0.5 - 0.1 * c
        let points: [SIMD2<Float>] = [
            SIMD2<Float>(0, 0), SIMD2<Float>(topX, 0), SIMD2<Float>(1, 0),
            SIMD2<Float>(0, middle + 0.03 * b), SIMD2<Float>(midX, middle + 0.04 * d), SIMD2<Float>(1, middle - 0.03 * b),
            SIMD2<Float>(0, bottom - 0.03 * d), SIMD2<Float>(bottomX, bottom + 0.04 * a), SIMD2<Float>(1, bottom + 0.03 * d),
            SIMD2<Float>(0, 1), SIMD2<Float>(lowX, 1), SIMD2<Float>(1, 1)
        ]
        MeshGradient(width: 3, height: 4, points: points, colors: colors)
    }
}

// MARK: - Préparation

/// Pochettes floutées et couleurs de zones, préparées une fois et gardées en mémoire.
enum BlurredArtwork {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 12
        return cache
    }()
    private static let palettes: NSCache<NSString, PaletteBox> = {
        let cache = NSCache<NSString, PaletteBox>()
        cache.countLimit = 40
        return cache
    }()
    private static let context = CIContext(options: [.useSoftwareRenderer: false])

    static func cached(_ track: Track) -> UIImage? {
        cache.object(forKey: track.id.uuidString as NSString)
    }

    /// Couleurs moyennes de la pochette, en 3 × 3 zones (haut → bas, gauche → droite).
    static func palette(_ track: Track) -> [UIColor]? {
        palettes.object(forKey: track.id.uuidString as NSString)?.colors
    }

    /// Prépare le flou ET les couleurs de zones (hors du fil principal), les met en cache et
    /// renvoie l'image floutée.
    static func make(_ track: Track) async -> UIImage? {
        guard let thumbnail = await ArtworkCache.shared.load(for: track, maxPixel: 260) else { return nil }
        let key = track.id.uuidString as NSString
        let blurred = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            blur(thumbnail)
        }.value
        let colors = await Task.detached(priority: .userInitiated) { () -> [UIColor]? in
            thumbnail.regionColors(columns: 3, rows: 3)?.map { $0.vivid(saturation: 1.25, maxBrightness: 0.88) }
        }.value
        if let blurred { cache.setObject(blurred, forKey: key) }
        if let colors { palettes.setObject(PaletteBox(colors), forKey: key) }
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

/// Boîte objet pour ranger un tableau de couleurs dans un `NSCache`.
final class PaletteBox: NSObject {
    let colors: [UIColor]
    init(_ colors: [UIColor]) { self.colors = colors }
}
