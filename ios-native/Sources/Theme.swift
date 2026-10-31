import SwiftUI

/// Identité visuelle de Benten, portée telle quelle du desktop.
///
/// Rien n'est approximé : les teintes sont les mêmes valeurs que les variables CSS du bureau
/// (`--ink`, `--gold`, `--gold-light`, `--ivory`), la typographie reprend la sérif des titres,
/// les rayons et les halos suivent la grille du bureau.

enum Theme {
    static let ink = Color(red: 0.039, green: 0.035, blue: 0.031)        // #0A0908
    static let ink2 = Color(red: 0.078, green: 0.067, blue: 0.063)       // surfaces
    static let ink3 = Color(red: 0.110, green: 0.098, blue: 0.090)
    static let gold = Color(red: 0.831, green: 0.667, blue: 0.314)       // #D4AA50
    static let goldLight = Color(red: 0.941, green: 0.827, blue: 0.541)  // #F0D38A
    static let goldDeep = Color(red: 0.541, green: 0.392, blue: 0.125)
    static let ivory = Color(red: 0.953, green: 0.937, blue: 0.910)      // #F3EFE8
    static let dim = Color(red: 0.953, green: 0.937, blue: 0.910).opacity(0.62)
    static let hairline = Color.white.opacity(0.10)

    /// Dégradé du médaillon doré et de la pastille de lecture.
    static let goldGradient = LinearGradient(
        colors: [goldLight, gold, goldDeep],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let tileRadius: CGFloat = 14
}

/// Titre en sérif, comme les en-têtes du bureau (« Ta bibliothèque, en local »).
struct SerifTitle: ViewModifier {
    var size: CGFloat = 28
    func body(content: Content) -> some View {
        content
            .font(.system(size: size, weight: .regular, design: .serif))
            .foregroundStyle(Theme.ivory)
    }
}

extension View {
    func serifTitle(_ size: CGFloat = 28) -> some View { modifier(SerifTitle(size: size)) }
}

/// Fond animé : laque noir + deux halos dorés qui respirent lentement.
///
/// C'est l'équivalent des scènes de fond du bureau, en version légère : aucun décodage vidéo, juste
/// deux dégradés dont l'opacité et l'échelle bougent en boucle — donc aucun coût GPU notable et
/// aucun fichier à embarquer.
struct AnimatedBackdrop: View {
    @State private var phase: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Theme.ink
            RadialGradient(
                colors: [Theme.gold.opacity(0.22 * (1 + 0.35 * sin(phase))), .clear],
                center: UnitPoint(x: 0.5 + 0.08 * sin(phase * 0.7), y: 0.02),
                startRadius: 0,
                endRadius: 420
            )
            RadialGradient(
                colors: [Theme.goldLight.opacity(0.10 * (1 + 0.4 * cos(phase * 0.8))), .clear],
                center: UnitPoint(x: 0.9 + 0.05 * cos(phase), y: 0.95),
                startRadius: 0,
                endRadius: 380
            )
        }
        .ignoresSafeArea()
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 14).repeatForever(autoreverses: true)) {
                phase = .pi
            }
        }
    }
}

/// Halo coloré derrière une pochette : reprend sa teinte dominante (comme le bureau).
struct CoverGlow: View {
    let color: Color
    var intensity: Double = 0.55

    var body: some View {
        RoundedRectangle(cornerRadius: Theme.tileRadius, style: .continuous)
            .fill(
                RadialGradient(
                    colors: [color.opacity(0.55 * intensity), color.opacity(0.18 * intensity), .clear],
                    center: .center,
                    startRadius: 8,
                    endRadius: 110
                )
            )
            .blur(radius: 10)
            .scaleEffect(1.18)
    }
}

/// Disque laqué derrière la pochette, qui tourne quand la musique joue.
struct LacquerDisc: View {
    let playing: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: playing ? 1.0 / 30.0 : 3600, paused: !playing)) { context in
            let angle = playing ? context.date.timeIntervalSinceReferenceDate * 12 : 0
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Color(white: 0.10), .black],
                            center: .center,
                            startRadius: 12,
                            endRadius: 220
                        )
                    )
                // Sillons : de fines lignes concentriques, comme un vinyle.
                ForEach(0..<14, id: \.self) { ring in
                    Circle()
                        .stroke(Color.white.opacity(0.028), lineWidth: 1)
                        .padding(CGFloat(ring) * 7)
                }
                Circle()
                    .strokeBorder(Theme.gold.opacity(0.22), lineWidth: 1)
            }
            .rotationEffect(.degrees(angle))
        }
    }
}
