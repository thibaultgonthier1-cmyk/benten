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
    @State private var offset: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .opacity(1 - min(0.45, abs(offset) / 300))
            .simultaneousGesture(
                DragGesture(minimumDistance: 14)
                    .onChanged { value in
                        let dx = value.translation.width
                        guard abs(dx) > abs(value.translation.height) else { return }
                        // Résistance : plus on tire, moins ça suit (sensation élastique).
                        offset = dx / (1 + abs(dx) / 260)
                    }
                    .onEnded { value in
                        let dx = value.translation.width
                        let dy = value.translation.height
                        let projected = value.predictedEndTranslation.width
                        let horizontal = abs(dx) > abs(dy)
                        if horizontal, dx < -56 || projected < -170 {
                            Haptics.tap()
                            onNext()
                        } else if horizontal, dx > 56 || projected > 170 {
                            Haptics.tap()
                            onPrevious()
                        } else if let onUp, !horizontal, dy < -22 {
                            Haptics.tap()
                            onUp()
                        }
                        withAnimation(Motion.spring) { offset = 0 }
                    }
            )
    }
}

extension View {
    func trackSwipe(onNext: @escaping () -> Void, onPrevious: @escaping () -> Void, onUp: (() -> Void)? = nil) -> some View {
        modifier(TrackSwipe(onNext: onNext, onPrevious: onPrevious, onUp: onUp))
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
    static func letter(for title: String) -> String {
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
/// bande lumineuse aux couleurs des deux palettes. 1,05 s, courbe ease-in-out cubique, 120 Hz.
@MainActor
enum ThemeSweep {
    private static var running: SweepAnimator?

    static func run(from old: Palette, to new: Palette, apply: @escaping () -> Void) {
        guard running == nil,
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

        // Position de défilement de l'écran en cours : la reconstruction de l'interface (nouvelle
        // couleur) la remet à zéro ; on la restaure AVANT de découvrir l'écran → aucun saut.
        let savedOffset = ScrollMemory.capture(in: window)

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
            // Ease-in-out cubique : départ et arrivée en douceur, traversée franche.
            let p = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
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

        render(0)
        Haptics.choose()
        apply()
        // On laisse SwiftUI reconstruire l'interface (sous la capture), on restaure le défilement,
        // puis la vague part.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 80_000_000)
            ScrollMemory.restore(savedOffset, in: window)
            let animator = SweepAnimator(duration: 1.05, step: render) {
                container.removeFromSuperview()
                running = nil
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
    private var start: CFTimeInterval = 0
    private var link: CADisplayLink?

    init(duration: Double, step: @escaping (Double) -> Void, done: @escaping () -> Void) {
        self.duration = duration
        self.step = step
        self.done = done
    }

    func begin() {
        start = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(frame))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func frame() {
        let t = min(1, (CACurrentMediaTime() - start) / duration)
        step(t)
        if t >= 1 {
            link?.invalidate()
            link = nil
            done()
        }
    }
}

/// Mémorise la position de défilement de l'écran visible (la plus grande liste verticale) et la
/// remet après une reconstruction de l'interface.
@MainActor
enum ScrollMemory {
    static func capture(in window: UIWindow) -> CGPoint? {
        largestScrollView(in: window).map(\.contentOffset)
    }

    static func restore(_ offset: CGPoint?, in window: UIWindow) {
        guard let offset, let scroll = largestScrollView(in: window) else { return }
        scroll.layoutIfNeeded()
        let maxY = max(-scroll.adjustedContentInset.top,
                       scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
        scroll.setContentOffset(CGPoint(x: offset.x, y: min(offset.y, maxY)), animated: false)
    }

    private static func largestScrollView(in view: UIView) -> UIScrollView? {
        var best: UIScrollView?
        var bestArea: CGFloat = 0
        func visit(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01, view.window != nil else { return }
            if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height {
                let frame = scroll.convert(scroll.bounds, to: nil)
                let visible = frame.intersection(view.window?.bounds ?? .zero)
                let area = visible.width * visible.height
                if area > bestArea {
                    bestArea = area
                    best = scroll
                }
            }
            for child in view.subviews { visit(child) }
        }
        visit(view)
        return best
    }
}
