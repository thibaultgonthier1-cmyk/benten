import AVKit
import MediaPlayer
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Lecteur plein écran

/// Vue lecture, à la manière d'Apple Music : pochette qui grossit en lecture et rétrécit en pause,
/// titre à gauche, barre de progression qui s'épaissit sous le doigt, transport, volume système
/// réel, AirPlay, AutoMix. Se referme au trait du haut ou en tirant vers le bas.
///
/// MISE EN PAGE : tout est calculé d'après la taille RÉELLE de la fenêtre (GeometryReader) et ses
/// vraies marges de sécurité — jamais d'après `UIScreen` (faux sur iPad en écran partagé). Les
/// commandes sont ancrées en bas ; la pochette prend la place restante sans JAMAIS les chevaucher
/// (iPhone SE compris : elle devient alors une carte).
struct NowPlayingView: View {
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var favorites: FavoritesStore
    @EnvironmentObject private var playlists: PlaylistStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("visualizer") private var visualizerOn = true
    @AppStorage("livingArtwork") private var livingArtwork = true
    @State private var dragOffset: CGFloat = 0
    /// Suivi horizontal du doigt sur la pochette animée (retour visuel du swipe).
    @State private var artSwipe: CGFloat = 0
    @State private var previousTaps = 0
    @State private var nextTaps = 0
    /// Couleur du morceau en cours (tirée de la pochette).
    @State private var tint: Color = Theme.accent
    /// Format (largeur / hauteur) de la pochette affichée, remonté par la pochette animée.
    @State private var artAspect: CGFloat?
    /// Fermeture en cours (évite un double déclenchement : geste de la pochette + geste global).
    @State private var dismissing = false

    var body: some View {
        GeometryReader { geo in
            let layout = PlayerLayout(
                size: geo.size,
                safeTop: max(geo.safeAreaInsets.top, DeviceLayout.windowSafeInsets.top),
                safeBottom: max(geo.safeAreaInsets.bottom, DeviceLayout.windowSafeInsets.bottom),
                aspect: artAspect ?? LivingArtwork.cachedAspect(player.current) ?? 1,
                living: living,
                spectrum: visualizerOn
            )
            panel(layout)
        }
        // Coins arrondis seulement pendant qu'on tire le panneau (comme une feuille iOS) ; à
        // l'arrêt, les coins de l'écran font le travail.
        .clipShape(RoundedRectangle(cornerRadius: dragOffset > 0.5 ? 44 : 0, style: .continuous))
        .offset(y: dragOffset)
        .gesture(
            DragGesture(minimumDistance: 14, coordinateSpace: .global)
                .onChanged { value in
                    let dy = value.translation.height
                    guard !dismissing, dy > 0, abs(dy) > abs(value.translation.width) else { return }
                    dragOffset = dy
                }
                .onEnded { value in
                    guard !dismissing, dragOffset > 0 else { return }
                    release(translation: value.translation.height,
                            predicted: value.predictedEndTranslation.height,
                            velocity: value.velocity.height)
                }
        )
        .ignoresSafeArea()
        // Couleur du morceau, tirée de sa pochette (halo, visualiseur, boutons actifs).
        .task(id: player.current?.id) {
            guard let track = player.current else { return }
            if let ready = ArtworkCache.shared.cachedVividTint(for: track) {
                withAnimation(.easeInOut(duration: 0.6)) { tint = ready }
                return
            }
            _ = await ArtworkCache.shared.load(for: track, maxPixel: 1000)
            let resolved = ArtworkCache.shared.cachedVividTint(for: track) ?? Theme.accent
            withAnimation(.easeInOut(duration: 0.6)) { tint = resolved }
        }
        // Visualiseur branché seulement quand on le voit (vue ouverte + app au premier plan),
        // et APRÈS l'animation d'ouverture (0,5 s) : l'ouverture reste fluide.
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if player.showFullScreen && visualizerOn { player.setVisualizer(active: true) }
            }
        }
        .onDisappear { player.setVisualizer(active: false) }
        .onChange(of: scenePhase) { _, phase in
            player.setVisualizer(active: visualizerOn && phase == .active)
        }
        .onChange(of: visualizerOn) { _, on in
            player.setVisualizer(active: on)
        }
    }

    /// Le panneau complet, à la taille exacte de la fenêtre.
    private func panel(_ layout: PlayerLayout) -> some View {
        ZStack(alignment: .top) {
            background(layout)

            // Pochette ANIMÉE : bord à bord en haut de l'écran (ou carte sur petit écran),
            // holographique, qui respire. Purement visuelle : le geste est porté par l'emplacement
            // transparent des commandes, juste dessous.
            if living, let track = player.current {
                livingArtwork(track, layout)
            }

            controls(layout)
        }
        .frame(width: layout.size.width, height: layout.size.height)
        .animation(.easeInOut(duration: 0.6), value: player.current?.id)
    }

    @ViewBuilder private func background(_ layout: PlayerLayout) -> some View {
        if Theme.appleStyle {
            CoverBackdrop(track: player.current, playing: player.playing, bpm: player.currentBPM,
                          focus: layout.art)
        } else {
            AnimatedBackdrop()
        }
    }

    /// Pochette animée active (style Apple Music + réglage « Pochette animée »).
    private var living: Bool { livingArtwork && Theme.appleStyle && !reduceMotion }

    @ViewBuilder private func livingArtwork(_ track: Track, _ layout: PlayerLayout) -> some View {
        let swipeFade = 1 - min(0.4, Double(abs(artSwipe)) / 400)
        if layout.fullBleed {
            LivingArtwork(track: track, playing: player.playing, bpm: player.currentBPM,
                          size: layout.art.size, fullBleed: true, topBleed: layout.art.minY,
                          aspect: $artAspect)
                .offset(x: artSwipe)
                .opacity(swipeFade)
                .allowsHitTesting(false)
        } else {
            LivingArtwork(track: track, playing: player.playing, bpm: player.currentBPM,
                          size: layout.art.size, fullBleed: false, cornerRadius: 12,
                          aspect: $artAspect)
                // Ombre portée par une forme FIXE derrière la carte : elle n'est pas recalculée
                // à chaque image de l'animation.
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.black)
                        .shadow(color: .black.opacity(player.playing ? 0.45 : 0.3),
                                radius: player.playing ? 26 : 14, y: player.playing ? 16 : 8)
                )
                // Apple Music : la pochette rétrécit en pause et reprend sa taille en lecture.
                .scaleEffect(player.playing ? 1 : 0.8)
                .animation(Motion.artwork, value: player.playing)
                .offset(x: artSwipe)
                .opacity(swipeFade)
                .padding(.top, layout.art.minY)
                .allowsHitTesting(false)
        }
    }

    private func controls(_ layout: PlayerLayout) -> some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.4))
                .frame(width: 40, height: 5)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { close() }

            if let track = player.current {
                artworkSlot(track, layout)
                    .frame(height: layout.slotHeight, alignment: .bottom)
                    // Glisser la pochette : gauche = suivant, droite = précédent, bas = fermer.
                    .trackSwipe(
                        onNext: { player.next() },
                        onPrevious: { player.previous(force: true) },
                        onDrag: { translation in
                            guard !dismissing else { return }
                            if translation.height > 0, translation.height > abs(translation.width) {
                                dragOffset = translation.height
                            } else if abs(translation.width) > abs(translation.height) {
                                artSwipe = translation.width / (1 + abs(translation.width) / 260)
                            }
                        },
                        onRelease: { translation, projected in
                            if !dismissing, dragOffset > 0,
                               translation.height > 0, translation.height > abs(translation.width) {
                                // Vitesse estimée d'après la projection de fin de geste.
                                release(translation: translation.height, predicted: projected.height,
                                        velocity: (projected.height - translation.height) * 2)
                            }
                            withAnimation(Motion.spring) { artSwipe = 0 }
                        }
                    )

                Spacer(minLength: 8)
                if visualizerOn {
                    SpectrumBars(tint: tint)
                        .frame(height: PlayerLayout.spectrumHeight)
                        .padding(.horizontal, 32)
                        .transition(.opacity)
                    Spacer(minLength: 8)
                }

                VStack(spacing: 0) {
                    titleRow(track)
                        .padding(.horizontal, 28)
                    ScrubBar { player.seek(to: $0) }
                        .padding(.horizontal, 28)
                        .padding(.top, 16)
                    transport
                        .padding(.top, 10)
                    volumeRow
                        .padding(.horizontal, 28)
                        .padding(.top, 14)
                    bottomRow
                        .padding(.horizontal, 36)
                        .padding(.top, 14)
                        .padding(.bottom, 8)
                }
                // iPad : commandes à une largeur confortable, centrées.
                .frame(maxWidth: PlayerLayout.maxContentWidth)
            } else {
                Spacer(minLength: 0)
            }
        }
        .padding(.top, layout.top)
        .padding(.bottom, layout.bottom)
        .frame(width: layout.size.width, height: layout.size.height, alignment: .top)
        .animation(Motion.spring, value: player.current?.id)
    }

    /// Emplacement de la pochette : la carte classique, ou un espace vide (touchable pour le
    /// swipe) quand la pochette animée est dessinée par-dessous.
    @ViewBuilder private func artworkSlot(_ track: Track, _ layout: PlayerLayout) -> some View {
        if living {
            Color.clear
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
        } else {
            artwork(track, side: layout.art.width)
                .frame(maxWidth: .infinity)
        }
    }

    private func artwork(_ track: Track, side: CGFloat) -> some View {
        ZStack {
            if !Theme.appleStyle {
                LacquerDisc(playing: player.playing)
                    .frame(width: side * 1.04, height: side * 1.04)
            }
            ArtworkView(track: track, maxPixel: 1000)
                .frame(width: Theme.appleStyle ? side : side * 0.68, height: Theme.appleStyle ? side : side * 0.68)
                .clipShape(RoundedRectangle(cornerRadius: Theme.appleStyle ? 12 : 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.appleStyle ? 12 : 18, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08))
                )
                // Halo DE LA COULEUR du morceau sous la pochette (Apple : ombre noire neutre).
                .shadow(
                    color: tint.opacity(player.playing ? 0.55 : 0.22),
                    radius: player.playing ? 38 : 14,
                    y: player.playing ? 20 : 6
                )
                // Apple Music : la pochette rétrécit en pause et reprend sa taille en lecture.
                .scaleEffect(player.playing || reduceMotion ? 1 : 0.8)
                .animation(reduceMotion ? nil : Motion.artwork, value: player.playing)
                .id(track.id)
                .transition(.asymmetric(
                    insertion: .scale(scale: 0.9).combined(with: .opacity),
                    removal: .opacity
                ))
        }
        .frame(height: side)
    }

    private func titleRow(_ track: Track) -> some View {
        let isFavorite = favorites.contains(track.id)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(track.title)
                    .font(.system(size: 21, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(track.artist)
                    .font(.system(size: 18))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                // Infos de DJ : tempo et tonalité (Camelot). Apple ne les montre pas.
                if let bpm = player.currentBPM {
                    HStack(spacing: 6) {
                        Text("\(Int(bpm.rounded())) BPM")
                        if let key = AudioMath.camelotLabel(player.currentKey) {
                            Text("·")
                            Text(key)
                        }
                    }
                    .font(.system(size: 11, weight: .bold).monospacedDigit())
                    .foregroundStyle(tint)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(tint.opacity(0.16)))
                    .padding(.top, 4)
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                }
            }
            .id(track.id)
            .transition(.opacity)
            .animation(Motion.quick, value: player.currentBPM)
            Spacer(minLength: 8)

            Button {
                Haptics.choose()
                favorites.toggle(track.id)
            } label: {
                Image(systemName: isFavorite ? "heart.fill" : "heart")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(isFavorite ? tint : .white)
                    .symbolEffect(.bounce, value: isFavorite)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Color.white.opacity(0.14)))
            }
            .buttonStyle(PressableStyle(scale: 0.85))

            Menu {
                Section("Ajouter à une playlist") {
                    ForEach(playlists.items) { playlist in
                        Button {
                            Haptics.choose()
                            playlists.add(track.id, to: playlist.id)
                        } label: {
                            Label(playlist.name, systemImage: "music.note.list")
                        }
                    }
                    Button {
                        Haptics.choose()
                        playlists.create(named: track.title, from: [track.id])
                    } label: {
                        Label("Nouvelle playlist", systemImage: "plus")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Color.white.opacity(0.14)))
            }
        }
    }

    private var transport: some View {
        HStack {
            Spacer()
            Button {
                Haptics.tap()
                previousTaps += 1
                player.previous()
            } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 32))
                    .symbolEffect(.bounce, value: previousTaps)
                    .frame(width: 64, height: 64)
                    .contentShape(Rectangle())
            }
            .buttonStyle(TransportStyle(haloSize: 72))
            Spacer()
            Button {
                Haptics.press()
                player.toggle()
            } label: {
                ZStack {
                    if !Theme.appleStyle {
                        Circle()
                            .fill(Theme.accentGradient)
                            .frame(width: 76, height: 76)
                            .shadow(color: Theme.accent.opacity(0.45), radius: 16, y: 6)
                    }
                    Image(systemName: player.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: Theme.appleStyle ? 46 : 30, weight: .bold))
                        .foregroundStyle(Theme.appleStyle ? Color.white : Theme.ink)
                        .contentTransition(.symbolEffect(.replace))
                }
                .frame(width: 80, height: 80)
                .contentShape(Rectangle())
            }
            .buttonStyle(TransportStyle(haloSize: 84))
            .animation(Motion.quick, value: player.playing)
            Spacer()
            Button {
                Haptics.tap()
                nextTaps += 1
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 32))
                    .symbolEffect(.bounce, value: nextTaps)
                    .frame(width: 64, height: 64)
                    .contentShape(Rectangle())
            }
            .buttonStyle(TransportStyle(haloSize: 72))
            Spacer()
        }
        .foregroundStyle(.white)
    }

    private var volumeRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "speaker.fill")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.6))
            SystemVolumeSlider()
                .frame(height: 30)
            Image(systemName: "speaker.wave.3.fill")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.6))
        }
    }

    private var bottomRow: some View {
        HStack {
            Button {
                Haptics.choose()
                player.shuffle.toggle()
            } label: {
                Image(systemName: "shuffle")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(player.shuffle ? tint : .white.opacity(0.65))
                    .symbolEffect(.bounce, value: player.shuffle)
                    .frame(width: 40, height: 36)
            }
            .buttonStyle(PressableStyle(scale: 0.85))

            Spacer()

            Button {
                Haptics.choose()
                withAnimation(Motion.quick) { player.setAutomix(!player.automixEnabled) }
            } label: {
                HStack(spacing: 6) {
                    if let next = player.mixingInto {
                        // Pendant la transition : on montre vers quoi on mixe, ondes animées.
                        Image(systemName: "waveform")
                            .symbolEffect(.variableColor.iterative, isActive: true)
                        Text(next.id == player.current?.id ? "Mix en boucle" : "Mix → \(next.title)")
                            .lineLimit(1)
                            .frame(maxWidth: 130)
                    } else {
                        Image(systemName: "dial.high.fill")
                            .symbolEffect(.bounce, value: player.automixEnabled)
                        Text("AutoMix")
                    }
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(player.automixEnabled ? Color.black.opacity(0.85) : .white.opacity(0.75))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(player.automixEnabled ? AnyShapeStyle(tint) : AnyShapeStyle(Color.white.opacity(0.12)))
                )
                .animation(Motion.spring, value: player.mixingInto?.id)
            }
            .buttonStyle(PressableStyle(scale: 0.9))

            Spacer()

            RoutePicker()
                .frame(width: 36, height: 36)

            Spacer()

            Button {
                Haptics.choose()
                switch player.repeatMode {
                case .off: player.repeatMode = .all
                case .all: player.repeatMode = .one
                case .one: player.repeatMode = .off
                }
            } label: {
                Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(player.repeatMode == .off ? .white.opacity(0.65) : tint)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 40, height: 36)
            }
            .buttonStyle(PressableStyle(scale: 0.85))
            .animation(Motion.quick, value: player.repeatMode)
        }
    }

    private func close() {
        Haptics.tap()
        withAnimation(Motion.sheet) { player.showFullScreen = false }
    }

    /// Fin du glissé vers le bas : on ferme si le geste est assez long ou assez rapide, sinon le
    /// panneau revient en place. Dans les deux cas le ressort PART À LA VITESSE DU DOIGT
    /// (continuité physique : aucun arrêt net au relâcher).
    private func release(translation: CGFloat, predicted: CGFloat, velocity: CGFloat) {
        if translation > 130 || predicted > 420 {
            dismissFromDrag(velocity: velocity)
        } else {
            withAnimation(Self.spring(from: dragOffset, to: 0, velocity: velocity, bounce: 0)) {
                dragOffset = 0
            }
        }
    }

    /// Fermeture au glissé : le panneau continue sa course vers le bas à la vitesse du doigt
    /// (ressort amorti à 80 %, comme Apple Music), PUIS disparaît (sans saut).
    private func dismissFromDrag(velocity: CGFloat) {
        guard !dismissing else { return }
        dismissing = true
        Haptics.tap()
        let target = DeviceLayout.windowSize.height + 40
        withAnimation(Self.spring(from: dragOffset, to: target, velocity: max(0, velocity), bounce: 0.2)) {
            dragOffset = target
        } completion: {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { player.showFullScreen = false }
            dragOffset = 0
            dismissing = false
        }
    }

    /// Ressort qui démarre avec la vitesse du geste (pt/s), convertie en vitesse RELATIVE au trajet
    /// restant (unité attendue par SwiftUI).
    private static func spring(from current: CGFloat, to target: CGFloat, velocity: CGFloat, bounce: Double) -> Animation {
        let distance = Double(target - current)
        let relative = abs(distance) > 1 ? Double(velocity) / distance : 0
        return .interpolatingSpring(duration: 0.42, bounce: bounce, initialVelocity: max(-12, min(12, relative)))
    }
}

// MARK: - Géométrie du lecteur

/// Mise en page du lecteur, calculée d'après la fenêtre réelle.
///
/// Hauteurs fixes (polices de taille fixe, sans Dynamic Type) : poignée 17 pt ; bloc de commandes
/// 328 pt au maximum (titre + artiste + pastille BPM 76, barre 60, transport 90, volume 44,
/// rangée du bas 58) ; visualiseur 30 pt.
///
/// - Pochette BORD À BORD (style Apple Music animé) si elle tient : pleine largeur, juste sous la
///   barre d'état, hauteur selon son format (carré → largeur, 16:9 → largeur × 9/16). Son bas
///   (fondu) peut glisser sous le visualiseur, jamais sous le titre.
/// - Sinon CARTE carrée centrée (24–28 pt de marge comme Apple Music), réduite si l'écran est
///   court (iPhone SE) pour que rien ne se chevauche.
struct PlayerLayout {
    static let handleHeight: CGFloat = 17
    static let controlsHeight: CGFloat = 328
    static let spectrumHeight: CGFloat = 30
    static let maxContentWidth: CGFloat = 560

    let size: CGSize
    /// Marge haute (barre d'état / Dynamic Island).
    let top: CGFloat
    /// Marge basse (barre d'accueil, 12 pt minimum).
    let bottom: CGFloat
    /// Cadre de la pochette, en coordonnées plein écran.
    let art: CGRect
    let fullBleed: Bool
    /// Hauteur de l'emplacement de la pochette sous la poignée (zone de swipe).
    let slotHeight: CGFloat

    init(size: CGSize, safeTop: CGFloat, safeBottom: CGFloat, aspect: CGFloat, living: Bool, spectrum: Bool) {
        let width = max(1, size.width)
        let height = max(1, size.height)
        self.size = CGSize(width: width, height: height)
        top = safeTop
        bottom = max(safeBottom, 12)

        let controlsTop = height - bottom - Self.controlsHeight
        // Visualiseur + ses deux espaces minimum (8 + 8), ou un seul espace sans visualiseur.
        let spectrumBlock: CGFloat = spectrum ? Self.spectrumHeight + 16 : 8
        let slotTop = safeTop + Self.handleHeight
        let room = max(120, controlsTop - spectrumBlock - slotTop)

        // 1) Bord à bord : pleine largeur, format de la pochette (carré à 2:1).
        let ratio = min(2, max(1, aspect.isFinite ? aspect : 1))
        let bleedTop = safeTop + 2
        let bleedHeight = (width / ratio).rounded()
        let fitsUnderControls = bleedTop + bleedHeight <= controlsTop - 4
        let opaqueClearsSpectrum = bleedTop + bleedHeight * 0.88 <= controlsTop - spectrumBlock
        if living && width <= 600 && fitsUnderControls && opaqueClearsSpectrum {
            fullBleed = true
            art = CGRect(x: 0, y: bleedTop, width: width, height: bleedHeight)
            slotHeight = min(max(0, bleedTop + bleedHeight - slotTop), room)
        } else {
            // 2) Carte centrée.
            fullBleed = false
            let margin: CGFloat = width >= 400 ? 28 : 24
            let side = max(140, min(width - 2 * margin, Self.maxContentWidth, room - 20)).rounded()
            art = CGRect(x: ((width - side) / 2).rounded(), y: slotTop + 20, width: side, height: side)
            slotHeight = side + 20
        }
    }
}

/// Visualiseur audio en temps réel (spectre de ce qui sort vraiment des haut-parleurs), aux
/// couleurs du morceau. Apple Music n'en a pas. Ne coûte rien quand la vue lecture est fermée.
struct SpectrumBars: View {
    @EnvironmentObject private var spectrum: SpectrumModel
    let tint: Color

    var body: some View {
        let bands = spectrum.bands
        Canvas { context, size in
            let count = bands.count
            guard count > 0 else { return }
            let gap: CGFloat = 3
            let width = max(1, (size.width - gap * CGFloat(count - 1)) / CGFloat(count))
            for (index, value) in bands.enumerated() {
                let level = CGFloat(min(1, max(0, value)))
                let height = max(3, level * size.height)
                let rect = CGRect(
                    x: CGFloat(index) * (width + gap),
                    y: (size.height - height) / 2,
                    width: width,
                    height: height
                )
                context.fill(
                    Path(roundedRect: rect, cornerRadius: width / 2),
                    with: .color(tint.opacity(0.3 + 0.7 * Double(level)))
                )
            }
        }
        .allowsHitTesting(false)
    }
}

/// Barre de progression façon Apple Music : fine au repos, épaisse sous le doigt, glissé
/// RELATIF (pas de saut au toucher), et le seek n'est envoyé QU'AU RELÂCHEMENT. Avant, chaque
/// millimètre relançait l'audio et le curseur se battait avec le doigt.
struct ScrubBar: View {
    @EnvironmentObject private var clock: PlaybackClock
    let onSeek: (Double) -> Void
    @State private var dragging = false
    @State private var dragValue: Double = 0
    @State private var dragStart: Double = 0

    var body: some View {
        VStack(spacing: 7) {
            GeometryReader { geo in
                let total = max(1, clock.duration)
                let value = dragging ? dragValue : clock.position
                let fraction = CGFloat(min(1, max(0, value / total)))
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.22))
                    Capsule()
                        .fill(Color.white.opacity(dragging ? 1 : 0.78))
                        .frame(width: max(0, geo.size.width * fraction))
                        // Entre deux ticks (0,2 s), la barre glisse au lieu de sauter.
                        .animation(dragging ? nil : .linear(duration: 0.2), value: fraction)
                }
                .frame(height: dragging ? 11 : 6)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { gesture in
                            if !dragging {
                                dragStart = clock.position
                                dragValue = clock.position
                                withAnimation(Motion.quick) { dragging = true }
                                Haptics.tap()
                            }
                            let delta = Double(gesture.translation.width / max(1, geo.size.width)) * total
                            dragValue = min(total, max(0, dragStart + delta))
                        }
                        .onEnded { gesture in
                            if abs(gesture.translation.width) > 2 {
                                onSeek(dragValue)
                            }
                            withAnimation(Motion.quick) { dragging = false }
                        }
                )
            }
            .frame(height: 22)

            HStack {
                Text(clock.formatted(dragging ? dragValue : clock.position))
                Spacer()
                Text("-" + clock.formatted(max(0, clock.duration - (dragging ? dragValue : clock.position))))
            }
            .font(.system(size: 12, weight: .medium).monospacedDigit())
            .foregroundStyle(.white.opacity(dragging ? 0.95 : 0.55))
        }
    }
}

/// Curseur de VOLUME SYSTÈME réel (celui des boutons du téléphone). L'ancien curseur ne
/// pilotait rien.
struct SystemVolumeSlider: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        view.showsRouteButton = false
        view.tintColor = .white
        let size: CGFloat = 14
        let thumb = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { ctx in
            UIColor.white.setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: size, height: size))
        }
        view.setVolumeThumbImage(thumb, for: .normal)
        for case let slider as UISlider in view.subviews {
            slider.minimumTrackTintColor = .white
            slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.22)
        }
        return view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}

/// Bouton AirPlay / sortie audio (AirPods, enceintes, voiture).
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = UIColor.white.withAlphaComponent(0.7)
        view.activeTintColor = UIColor(Theme.accent)
        view.prioritizesVideoDevices = false
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
