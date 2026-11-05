import SwiftUI
import Observation

/// État du thème, OBSERVÉ : chaque vue qui lit une couleur d'accent (même via `Theme.accent`)
/// est redessinée toute seule quand la palette change — sans reconstruire l'interface, donc sans
/// perdre la position de défilement, l'onglet ou l'écran ouvert.
@Observable
final class ThemeState {
    var palette: Palette
    var appleStyle: Bool

    init() {
        let defaults = UserDefaults.standard
        palette = Palette(rawValue: defaults.string(forKey: "palette") ?? "") ?? .or
        appleStyle = (defaults.string(forKey: "design") ?? "apple") == "apple"
    }
}

/// Identité visuelle de Benten, portée telle quelle du desktop.
///
/// Rien n'est approximé : les teintes sont les mêmes valeurs que les variables CSS du bureau
/// (`--ink`, `--gold`, `--gold-light`, `--ivory`), la typographie reprend la sérif des titres,
/// les rayons et les halos suivent la grille du bureau.
///
/// L'ACCENT est variable : il suit la palette choisie dans les Réglages (six thèmes, comme sur le
/// PC). Le laque, l'encre et l'ivoire, eux, ne changent jamais.
enum Theme {
    static let ink = Color(red: 0.039, green: 0.035, blue: 0.031)        // #0A0908
    static let ink2 = Color(red: 0.078, green: 0.067, blue: 0.063)
    static let ink3 = Color(red: 0.110, green: 0.098, blue: 0.090)
    static let ivory = Color(red: 0.953, green: 0.937, blue: 0.910)      // #F3EFE8
    static let dim = Color(red: 0.953, green: 0.937, blue: 0.910).opacity(0.62)
    static let hairline = Color.white.opacity(0.10)

    /// Palette active, choisie dans les Réglages. La valeur est aussi persistée par `@AppStorage`.
    nonisolated(unsafe) static let state = ThemeState()

    static var active: Palette {
        get { state.palette }
        set { if state.palette != newValue { state.palette = newValue } }
    }

    /// Style d'interface : l'identité Benten (sérif, halos, disque) ou les conventions
    /// d'Apple Music (SF Pro, tuiles nettes, pochette plein écran, volume).
    ///
    /// Les deux sont proposés parce qu'ils ne servent pas la même chose : Benten pour l'ambiance,
    /// Apple Music pour l'ergonomie qu'on a déjà dans les doigts.
    static var appleStyle: Bool {
        get { state.appleStyle }
        set { if state.appleStyle != newValue { state.appleStyle = newValue } }
    }

    /// Rayon des pochettes : 14 (Benten) ou 7 (Apple Music, qui reste très serré).
    static var coverRadius: CGFloat { appleStyle ? 7 : tileRadius }

    /// En style Apple Music, l'accent suit la palette choisie ; si l'utilisateur n'a jamais
    /// touché aux palettes, le rose d'Apple est le bon défaut visuel.
    static var accent: Color { active.accent }
    static var accentLight: Color { active.accentLight }
    static var accentDeep: Color { active.accentDeep }

    /// Dégradé du médaillon et de la pastille de lecture.
    static var accentGradient: LinearGradient { active.gradient }

    static let tileRadius: CGFloat = 14

    /// Applique une palette et prévient l'interface.
    ///
    /// Sans `objectWillChange` d'un objet observable, un simple changement de variable statique ne
    /// redessinerait rien : la racine porte donc un `.id(palette)` qui force la reconstruction.
    static func apply(_ palette: Palette) {
        active = palette
    }
}

/// Titre en sérif, comme les en-têtes du bureau (« Ta bibliothèque, en local »).
struct SerifTitle: ViewModifier {
    var size: CGFloat = 28
    func body(content: Content) -> some View {
        content
            // Style Apple Music : SF Pro en gras, comme tous ses titres. Benten : sérif.
            .font(Theme.appleStyle
                  ? .system(size: size * 0.92, weight: .bold)
                  : .system(size: size, weight: .regular, design: .serif))
            .foregroundStyle(Theme.ivory)
    }
}

extension View {
    func serifTitle(_ size: CGFloat = 28) -> some View { modifier(SerifTitle(size: size)) }
}

/// Fond de Benten : laque noir + deux halos dorés, FIXES.
///
/// Avant, les deux halos « respiraient » via une animation en boucle infinie (`repeatForever`) :
/// SwiftUI re-rastérisait deux dégradés radiaux plein écran à chaque image, DERRIÈRE chaque onglet,
/// en permanence — même app à l'arrêt. C'était un gouffre à fluidité pour un mouvement qu'on ne
/// remarque même pas. Le fond est maintenant statique : rendu une fois, zéro coût ensuite, et visuel
/// identique au repos.
struct AnimatedBackdrop: View {
    var body: some View {
        ZStack {
            Theme.ink
            RadialGradient(
                colors: [Theme.accent.opacity(0.20), .clear],
                center: UnitPoint(x: 0.5, y: 0.02),
                startRadius: 0,
                endRadius: 420
            )
            RadialGradient(
                colors: [Theme.accentLight.opacity(0.10), .clear],
                center: UnitPoint(x: 0.9, y: 0.95),
                startRadius: 0,
                endRadius: 380
            )
        }
        .ignoresSafeArea()
    }
}

/// Halo coloré derrière une pochette : reprend sa teinte dominante (comme le bureau).
///
/// Sans `.blur` : un dégradé radial qui s'éteint en transparent est DÉJÀ flou. Le `.blur(10)`
/// d'avant ajoutait une passe de rendu hors écran par tuile, à chaque image du défilement de la
/// grille (style Benten) ; le rendu est le même sans.
struct CoverGlow: View {
    let color: Color
    var intensity: Double = 0.55

    var body: some View {
        // Dégradé ELLIPTIQUE relatif au cadre : il s'éteint exactement au bord, quelle que soit la
        // taille de la tuile (aucune arête visible).
        Rectangle()
            .fill(
                EllipticalGradient(
                    colors: [color.opacity(0.55 * intensity), color.opacity(0.22 * intensity), .clear],
                    center: .center,
                    startRadiusFraction: 0.04,
                    endRadiusFraction: 0.5
                )
            )
            .scaleEffect(1.32)
            .allowsHitTesting(false)
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
                ForEach(0..<14, id: \.self) { ring in
                    Circle()
                        .stroke(Color.white.opacity(0.028), lineWidth: 1)
                        .padding(CGFloat(ring) * 7)
                }
                Circle()
                    .strokeBorder(Theme.accent.opacity(0.22), lineWidth: 1)
            }
            .rotationEffect(.degrees(angle))
        }
    }
}


