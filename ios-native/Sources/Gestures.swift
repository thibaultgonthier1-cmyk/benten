import SwiftUI
import UIKit

// MARK: - Swipe sur le morceau (mini-lecteur, pochette plein écran)

/// Glisser à gauche → morceau suivant, à droite → précédent (comme le mini-lecteur d'Apple
/// Music). Optionnel : glisser vers le haut → ouvrir le lecteur. Le contenu suit le doigt
/// (avec résistance), puis revient en ressort.
struct TrackSwipe: ViewModifier {
    let onNext: () -> Void
    let onPrevious: () -> Void
    var onUp: (() -> Void)?
    /// Suivi du doigt (translation) et relâchement (translation, projection) : permet au lecteur
    /// plein écran de garder « tirer vers le bas pour fermer » sur la pochette.
    var onDrag: ((CGSize) -> Void)?
    var onRelease: ((CGSize, CGSize) -> Void)?
    @State private var offset: CGFloat = 0
    /// Axe VERROUILLÉ dès que le doigt a parcouru 10 pt (WWDC18 « Designing Fluid Interfaces ») :
    /// un glissé horizontal qui dérive un peu vers le haut ne bascule plus en « ouvrir le
    /// lecteur », et inversement. `nil` tant qu'aucun glissé n'est en cours.
    @State private var axis: Axis?

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .opacity(Double(1 - min(CGFloat(0.45), abs(offset) / CGFloat(300))))
            .simultaneousGesture(
                // 10 pt (au lieu de 14) : le contenu colle au doigt plus tôt.
                DragGesture(minimumDistance: 10)
                    .onChanged { value in
                        onDrag?(value.translation)
                        let dx = value.translation.width
                        let dy = value.translation.height
                        if axis == nil { axis = abs(dx) > abs(dy) ? .horizontal : .vertical }
                        guard axis == .horizontal else { return }
                        // Résistance : plus on tire, moins ça suit (sensation élastique).
                        offset = dx / (1 + abs(dx) / CGFloat(260))
                    }
                    .onEnded { value in
                        let dx = value.translation.width
                        let dy = value.translation.height
                        let projected = value.predictedEndTranslation.width
                        let horizontal = (axis ?? (abs(dx) > abs(dy) ? .horizontal : .vertical)) == .horizontal
                        axis = nil
                        if horizontal, dx < -56 || projected < -170 {
                            // Changement de morceau : « sélection » sèche, comme le mini-lecteur
                            // d'Apple Music (iOS 26.1).
                            Haptics.choose()
                            onNext()
                        } else if horizontal, dx > 56 || projected > 170 {
                            Haptics.choose()
                            onPrevious()
                        } else if let onUp, !horizontal, dy < -22 {
                            Haptics.tap()
                            onUp()
                        }
                        onRelease?(value.translation, value.predictedEndTranslation)
                        // Retour en ressort qui PART à la vitesse du doigt (pas d'arrêt net puis
                        // redémarrage) : continuité de vitesse = mouvement « physique ».
                        withAnimation(Self.settle(from: offset, velocity: value.velocity.width)) { offset = 0 }
                    }
            )
    }

    /// Ressort de retour à 0, sans dépassement visible (amorti ≈ 0,9, réponse ≈ 0,31 s), lancé avec
    /// la vitesse du geste. `initialVelocity` est RELATIVE à la distance à parcourir.
    private static func settle(from offset: CGFloat, velocity: CGFloat) -> Animation {
        guard abs(offset) > 0.5 else { return Motion.quick }
        let relative = Double(max(-30, min(30, -velocity / offset)))
        return .interpolatingSpring(mass: 1, stiffness: 400, damping: 36, initialVelocity: relative)
    }
}

extension View {
    func trackSwipe(onNext: @escaping () -> Void, onPrevious: @escaping () -> Void, onUp: (() -> Void)? = nil,
                    onDrag: ((CGSize) -> Void)? = nil, onRelease: ((CGSize, CGSize) -> Void)? = nil) -> some View {
        modifier(TrackSwipe(onNext: onNext, onPrevious: onPrevious, onUp: onUp, onDrag: onDrag, onRelease: onRelease))
    }

    /// Retour par glissement depuis N'IMPORTE OÙ dans l'écran (iOS 26), et toujours actif depuis
    /// le bord (iOS 17–18), même sur les écrans à barre personnalisée.
    func swipeBackEverywhere() -> some View {
        background(BackSwipeEnabler().frame(width: 0, height: 0))
    }
}

// MARK: - Retour par glissement partout

struct BackSwipeEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) {
        Task { @MainActor in controller.install() }
    }

    final class Controller: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            install()
        }

        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            Task { @MainActor [weak self] in self?.install() }
        }

        func install() {
            var candidate: UIViewController? = self
            while let current = candidate {
                if let navigation = current as? UINavigationController ?? current.navigationController {
                    BackSwipe.enable(on: navigation)
                    return
                }
                candidate = current.parent
            }
        }
    }
}

enum BackSwipe {
    @MainActor static func enable(on navigation: UINavigationController) {
        navigation.interactivePopGestureRecognizer?.isEnabled = true
        // iOS 26 : geste « retour » depuis tout le contenu (pas seulement le bord). Lu par
        // sélecteur : aucune dépendance de compilation, aucun risque sur les iOS plus anciens.
        let selector = NSSelectorFromString("interactiveContentPopGestureRecognizer")
        if navigation.responds(to: selector),
           let gesture = navigation.perform(selector)?.takeUnretainedValue() as? UIGestureRecognizer {
            gesture.isEnabled = true
        }
    }
}

// MARK: - Index alphabétique (comme la liste des titres d'Apple Music)

/// Colonne de lettres sur le bord droit : on glisse le doigt dessus pour sauter directement à
/// une lettre (retour haptique à chaque lettre).
struct AlphabetIndex: View {
    let letters: [String]
    let onSelect: (String) -> Void
    @State private var active: String?

    var body: some View {
        GeometryReader { proxy in
            let step = proxy.size.height / CGFloat(max(1, letters.count))
            VStack(spacing: 0) {
                ForEach(letters, id: \.self) { letter in
                    Text(letter)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(active == letter ? Theme.ink : Theme.accent)
                        .frame(width: 18, height: step)
                        .background(Circle().fill(active == letter ? Theme.accent : .clear).frame(width: 16, height: 16))
                }
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let index = Int((value.location.y / max(1, step)).rounded(.down))
                        guard letters.indices.contains(index) else { return }
                        let letter = letters[index]
                        if letter != active {
                            active = letter
                            Haptics.choose()
                            onSelect(letter)
                        }
                    }
                    .onEnded { _ in withAnimation(Motion.quick) { active = nil } }
            )
        }
        .frame(width: 22)
    }

    /// Lettre d'index d'un titre : A–Z (accents retirés), « # » pour le reste.
    /// `nonisolated` : appelée par la bibliothèque HORS du fil principal (ancres pré-calculées).
    nonisolated static func letter(for title: String) -> String {
        let folded = title.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        guard let first = folded.unicodeScalars.first(where: { !CharacterSet.whitespaces.contains($0) }) else { return "#" }
        let upper = String(first).uppercased()
        return upper.count == 1 && ("A"..."Z").contains(upper) ? upper : "#"
    }
}

// MARK: - Changement de couleur d'accent : « courant » animé

/// Quand on change de couleur d'accent, un COURANT de couleur traverse l'écran de gauche à
/// droite : l'ancienne interface (capturée) s'efface derrière une vague qui passe du dégradé
/// de l'ancienne couleur à celui de la nouvelle, et révèle l'interface déjà recolorée.
///
/// Mécanique : capture de l'écran → la nouvelle couleur est appliquée dessous → un masque en
/// forme de vague (bord sinusoïdal qui ondule) découvre la nouvelle interface, porté par une
/// bande lumineuse aux couleurs des deux palettes. 0,95 s, départ franc (ease-out), 120 Hz,
/// cadencée sur l'instant d'affichage de chaque image (`targetTimestamp`).
@MainActor
enum ThemeSweep {
    private static var running: SweepAnimator?
    private static var busy = false

    static func run(from old: Palette, to new: Palette, apply: @escaping () -> Void) {
        guard !busy, running == nil,
              let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap(\.windows)
                .first(where: \.isKeyWindow),
              let snapshot = window.snapshotView(afterScreenUpdates: false) else {
            apply()
            return
        }
        let bounds = window.bounds
        let width = bounds.width
        let height = bounds.height


        let container = UIView(frame: bounds)
        container.isUserInteractionEnabled = true   // pas de toucher pendant la vague
        snapshot.frame = bounds
        container.addSubview(snapshot)

        let reveal = CAShapeLayer()
        reveal.frame = bounds
        snapshot.layer.mask = reveal

        let band = UIColor(new.accent)
        let bandLight = UIColor(new.accentLight)
        let bandDeep = UIColor(new.accentDeep)
        let oldColor = UIColor(old.accent)
        let oldLight = UIColor(old.accentLight)

        let glow = CAGradientLayer()
        glow.startPoint = CGPoint(x: 0, y: 0.5)
        glow.endPoint = CGPoint(x: 1, y: 0.5)
        glow.colors = [bandDeep.withAlphaComponent(0).cgColor, bandDeep.withAlphaComponent(0.35).cgColor,
                       band.withAlphaComponent(0.45).cgColor, oldColor.withAlphaComponent(0.25).cgColor,
                       oldColor.withAlphaComponent(0).cgColor]
        let glowMask = CAShapeLayer()
        glow.mask = glowMask

        let core = CAGradientLayer()
        core.startPoint = CGPoint(x: 0, y: 0.5)
        core.endPoint = CGPoint(x: 1, y: 0.5)
        core.colors = [bandDeep.withAlphaComponent(0).cgColor, bandDeep.withAlphaComponent(0.85).cgColor,
                       band.cgColor, bandLight.cgColor, oldLight.withAlphaComponent(0.9).cgColor,
                       oldColor.withAlphaComponent(0.55).cgColor, oldColor.withAlphaComponent(0).cgColor]
        core.locations = [0, 0.18, 0.42, 0.6, 0.74, 0.88, 1]
        let coreMask = CAShapeLayer()
        core.mask = coreMask

        container.layer.addSublayer(glow)
        container.layer.addSublayer(core)
        window.addSubview(container)

        // Géométrie de la vague.
        let amplitude = width * 0.06
        let wavelength = height * 0.55
        let coreWidth = width * 0.34
        let glowWidth = width * 0.62
        let travel = width + glowWidth + amplitude * 2

        func edge(_ y: CGFloat, _ base: CGFloat, _ t: Double) -> CGFloat {
            // Bord ondulant : la vague « coule » vers le bas pendant qu'elle avance.
            base + amplitude * sin(2 * .pi * y / wavelength + CGFloat(t) * 2 * .pi * 1.15)
                 + amplitude * 0.35 * sin(2 * .pi * y / (wavelength * 0.37) - CGFloat(t) * 2 * .pi * 0.8)
        }
        func strip(base: CGFloat, thickness: CGFloat, t: Double, origin: CGFloat) -> CGPath {
            let path = UIBezierPath()
            let step: CGFloat = 12
            var y: CGFloat = -step
            path.move(to: CGPoint(x: edge(y, base, t) - thickness - origin, y: y))
            while y <= height + step {
                path.addLine(to: CGPoint(x: edge(y, base, t) - origin, y: y))
                y += step
            }
            while y >= -step {
                y -= step
                path.addLine(to: CGPoint(x: edge(y, base, t) - thickness - origin, y: y))
            }
            path.close()
            return path.cgPath
        }

        func render(_ t: Double) {
            // Départ FRANC, arrivée en douceur (courbe « ease-out », comme un ressort amorti).
            // L'ancienne ease-in-out cubique ne bougeait quasiment pas pendant ~150 ms : le
            // toucher semblait ne rien déclencher. Ici la vague entre dès la première image.
            let p = 1 - pow(1 - t, 2.6)
            let base = -amplitude + CGFloat(p) * travel
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            // Ancienne interface : visible seulement À DROITE de la vague.
            let mask = UIBezierPath()
            let step: CGFloat = 12
            var y: CGFloat = -step
            mask.move(to: CGPoint(x: width + glowWidth, y: -step))
            mask.addLine(to: CGPoint(x: edge(y, base - coreWidth * 0.35, t), y: y))
            while y <= height + step {
                y += step
                mask.addLine(to: CGPoint(x: edge(y, base - coreWidth * 0.35, t), y: y))
            }
            mask.addLine(to: CGPoint(x: width + glowWidth, y: height + step))
            mask.close()
            reveal.path = mask.cgPath

            let glowOrigin = base - glowWidth
            glow.frame = CGRect(x: glowOrigin, y: 0, width: glowWidth + amplitude * 2, height: height)
            glowMask.path = strip(base: base + amplitude, thickness: glowWidth, t: t, origin: glowOrigin)
            let coreOrigin = base - coreWidth
            core.frame = CGRect(x: coreOrigin, y: 0, width: coreWidth + amplitude * 2, height: height)
            coreMask.path = strip(base: base + amplitude * 0.5, thickness: coreWidth, t: t, origin: coreOrigin)
            // La bande s'estompe dans les tout derniers instants.
            let fade = Float(min(1, (1 - t) / 0.12))
            core.opacity = fade
            glow.opacity = fade
            CATransaction.commit()
        }

        busy = true
        render(0)
        Haptics.choose()
        apply()
        // SwiftUI recolore l'interface SUR PLACE, sous la capture, à la fin de CE tour de boucle
        // (rien ne bouge à l'écran). La vague part au tour SUIVANT — donc juste après ce recalcul,
        // au lieu d'une attente fixe de 80 ms — et son horloge démarre à sa PREMIÈRE image : même
        // si le recoloriage a pris du temps, la vague ne « saute » jamais une partie du trajet.
        Task { @MainActor in
            let animator = SweepAnimator(duration: 0.95, step: render) {
                container.removeFromSuperview()
                running = nil
                busy = false
                Haptics.press()
            }
            running = animator
            animator.begin()
        }
    }
}

private final class SweepAnimator: NSObject {
    private let duration: Double
    private let step: (Double) -> Void
    private let done: () -> Void
    /// Instant d'AFFICHAGE de la première image (nil avant le premier rappel).
    private var start: CFTimeInterval?
    private var link: CADisplayLink?

    init(duration: Double, step: @escaping (Double) -> Void, done: @escaping () -> Void) {
        self.duration = duration
        self.step = step
        self.done = done
    }

    func begin() {
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        // 80–120 Hz : on demande la cadence ProMotion maximale (Info.plist :
        // CADisableMinimumFrameDurationOnPhone).
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func frame(_ link: CADisplayLink) {
        // On calcule l'état pour l'instant où l'image SERA affichée (`targetTimestamp`), pas pour
        // l'instant du rappel (qui varie selon la charge du fil principal) : pas régulier à
        // chaque image, donc mouvement parfaitement lisse à 120 Hz.
        let origin = start ?? link.timestamp
        if start == nil { start = origin }
        let t = min(1, max(0, (link.targetTimestamp - origin) / duration))
        step(t)
        if t >= 1 {
            link?.invalidate()
            link = nil
            done()
        }
    }
}
