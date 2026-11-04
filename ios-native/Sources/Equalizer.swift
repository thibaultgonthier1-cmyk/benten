import SwiftUI

/// Égaliseur 10 bandes, plein écran.
///
/// - 10 curseurs verticaux à glisser au doigt (cran à 0 dB avec retour haptique) ;
/// - courbe de réponse dessinée en direct ;
/// - préréglages intégrés (Phonk, Bass boost, Hip-hop…) + préréglages PERSO enregistrés ;
/// - préampli et anti-saturation (évite que les basses grésillent quand on pousse fort).
/// Tout est sauvegardé : on retrouve son réglage au prochain lancement.
struct EqualizerView: View {
    @EnvironmentObject private var player: Player
    @State private var naming = false
    @State private var newName = ""
    /// Vrai pendant qu'on fait glisser une bande : la page ne défile pas sous le doigt.
    @State private var bandDragging = false

    private static let labels = ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"]

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    EQCurve(gains: player.eqGains, enabled: player.eqEnabled)
                        .frame(height: 110)
                        .padding(.horizontal, 6)
                    bands
                    presets
                    preamp
                    actions
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDisabled(bandDragging)
        }
        .navigationTitle("Égaliseur")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Enregistrer ce réglage", isPresented: $naming) {
            TextField("Nom du réglage", text: $newName)
            Button("Enregistrer") {
                player.saveCustomPreset(named: newName)
                newName = ""
                Haptics.press()
            }
            Button("Annuler", role: .cancel) { newName = "" }
        } message: {
            Text("Il apparaîtra dans tes préréglages.")
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text(player.eqEnabled ? player.eqPresetName : "Désactivé")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Theme.ivory)
                    .contentTransition(.opacity)
                Text("Égaliseur 10 bandes")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.dim)
            }
            Spacer()
            Toggle("", isOn: $player.eqEnabled.animation(Motion.quick))
                .labelsHidden()
                .tint(Theme.accent)
        }
    }

    private var bands: some View {
        HStack(spacing: 0) {
            ForEach(Player.equalizerFrequencies.indices, id: \.self) { index in
                EQBandSlider(
                    value: player.eqGains[index],
                    label: Self.labels[index],
                    enabled: player.eqEnabled,
                    onDragging: { bandDragging = $0 }
                ) { value in
                    if !player.eqEnabled { player.eqEnabled = true }
                    player.setGain(value, at: index)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 230)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Theme.ink2.opacity(0.75))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.hairline))
        )
    }

    private var presets: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PRÉRÉGLAGES")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.4)
                .foregroundStyle(Theme.dim)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(player.allPresetNames, id: \.self) { name in
                        let selected = player.eqEnabled && player.eqPresetName == name
                        Button {
                            Haptics.choose()
                            withAnimation(Motion.quick) { player.applyPreset(name) }
                        } label: {
                            HStack(spacing: 5) {
                                if player.customPresets[name] != nil {
                                    Image(systemName: "person.fill").font(.system(size: 9))
                                }
                                Text(name)
                            }
                            .font(.system(size: 13, weight: selected ? .semibold : .medium))
                            .foregroundStyle(selected ? Theme.ink : Theme.ivory)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(
                                Capsule().fill(selected ? AnyShapeStyle(Theme.accentGradient) : AnyShapeStyle(Color.white.opacity(0.08)))
                            )
                        }
                        .buttonStyle(PressableStyle(scale: 0.92))
                        .contextMenu {
                            if player.customPresets[name] != nil {
                                Button(role: .destructive) {
                                    player.deleteCustomPreset(named: name)
                                } label: {
                                    Label("Supprimer ce réglage", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var preamp: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Préampli", systemImage: "dial.medium")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.ivory)
                Spacer()
                Text(String(format: "%+.1f dB", player.eqPreamp))
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Theme.accent)
            }
            Slider(value: $player.eqPreamp, in: -12...6, step: 0.5)
                .tint(Theme.accent)
            Toggle(isOn: $player.eqAutoHeadroom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Anti-saturation")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.ivory)
                    Text("Baisse le volume global quand tu pousses les basses, pour éviter que ça grésille.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.dim)
                }
            }
            .tint(Theme.accent)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.ink2.opacity(0.75))
        )
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                Haptics.tap()
                naming = true
            } label: {
                Label("Enregistrer", systemImage: "square.and.arrow.down")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Capsule().fill(Theme.accentGradient))
            }
            .buttonStyle(PressableStyle())

            Button {
                Haptics.press()
                withAnimation(Motion.spring) { player.resetEqualizer() }
            } label: {
                Label("Réinitialiser", systemImage: "arrow.counterclockwise")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.ivory)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
            }
            .buttonStyle(PressableStyle())
        }
        .padding(.bottom, 30)
    }
}

/// Curseur vertical d'une bande (−12 … +12 dB), glissé au doigt, cran haptique à 0.
struct EQBandSlider: View {
    let value: Double
    let label: String
    let enabled: Bool
    var onDragging: (Bool) -> Void = { _ in }
    let onChange: (Double) -> Void
    @State private var dragging = false

    var body: some View {
        VStack(spacing: 8) {
            Text(value == 0 ? "0" : String(format: "%+.0f", value))
                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                .foregroundStyle(dragging ? Theme.accent : Theme.dim)

            GeometryReader { geo in
                let height = geo.size.height
                let knob: CGFloat = dragging ? 24 : 18
                let y = CGFloat((12 - value) / 24) * height
                let mid = height / 2
                ZStack(alignment: .top) {
                    Capsule()
                        .fill(Color.white.opacity(0.10))
                        .frame(width: 5, height: height)
                    Rectangle()
                        .fill(Color.white.opacity(0.18))
                        .frame(width: 12, height: 1)
                        .offset(y: mid)
                    Capsule()
                        .fill(enabled ? AnyShapeStyle(Theme.accentGradient) : AnyShapeStyle(Color.white.opacity(0.25)))
                        .frame(width: 5, height: max(0, abs(y - mid)))
                        .offset(y: min(y, mid))
                    Circle()
                        .fill(Color.white)
                        .frame(width: knob, height: knob)
                        .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
                        .offset(y: y - knob / 2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { gesture in
                            if !dragging {
                                withAnimation(Motion.quick) { dragging = true }
                                onDragging(true)
                                Haptics.tap()
                            }
                            let ratio = min(1, max(0, gesture.location.y / max(1, height)))
                            let raw = 12 - Double(ratio) * 24
                            let snapped = abs(raw) < 0.75 ? 0 : (raw * 2).rounded() / 2
                            guard snapped != value else { return }
                            if Int(snapped) != Int(value) || snapped == 0 { Haptics.choose() }
                            onChange(snapped)
                        }
                        .onEnded { _ in
                            withAnimation(Motion.quick) { dragging = false }
                            onDragging(false)
                        }
                )
            }

            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.dim)
        }
    }
}

/// Courbe de réponse de l'égaliseur, lissée.
struct EQCurve: View {
    let gains: [Double]
    let enabled: Bool

    var body: some View {
        GeometryReader { geo in
            let points = Self.points(gains, in: geo.size)
            ZStack {
                Path { path in
                    path.move(to: CGPoint(x: 0, y: geo.size.height / 2))
                    path.addLine(to: CGPoint(x: geo.size.width, y: geo.size.height / 2))
                }
                .stroke(Color.white.opacity(0.14), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))

                Self.smooth(points, closingAt: geo.size.height)
                    .fill(LinearGradient(
                        colors: [Theme.accent.opacity(enabled ? 0.38 : 0.10), Theme.accent.opacity(0)],
                        startPoint: .top,
                        endPoint: .bottom
                    ))

                Self.smooth(points, closingAt: nil)
                    .stroke(
                        enabled ? AnyShapeStyle(Theme.accentGradient) : AnyShapeStyle(Color.white.opacity(0.3)),
                        style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round)
                    )
            }
        }
    }

    private static func points(_ gains: [Double], in size: CGSize) -> [CGPoint] {
        guard gains.count > 1 else { return [] }
        let usable = size.height / 2 - 6
        return gains.enumerated().map { index, gain in
            CGPoint(
                x: size.width * CGFloat(index) / CGFloat(gains.count - 1),
                y: size.height / 2 - CGFloat(gain / 12) * usable
            )
        }
    }

    private static func smooth(_ points: [CGPoint], closingAt bottom: CGFloat?) -> Path {
        Path { path in
            guard let first = points.first, let last = points.last else { return }
            path.move(to: first)
            for index in 1..<points.count {
                let previous = points[index - 1]
                let current = points[index]
                let middle = CGPoint(x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2)
                path.addQuadCurve(to: middle, control: previous)
            }
            path.addLine(to: last)
            if let bottom {
                path.addLine(to: CGPoint(x: last.x, y: bottom))
                path.addLine(to: CGPoint(x: first.x, y: bottom))
                path.closeSubpath()
            }
        }
    }
}
