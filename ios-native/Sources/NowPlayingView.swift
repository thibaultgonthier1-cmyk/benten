import AVKit
import MediaPlayer
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Lecteur plein écran

/// Vue lecture, à la manière d'Apple Music : pochette qui grossit en lecture et rétrécit en pause,
/// titre à gauche, barre de progression qui s'épaissit sous le doigt, transport, volume système
/// réel, AirPlay, AutoMix. Se referme au chevron ou en tirant vers le bas.
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

    private var screen: CGSize { UIScreen.main.bounds.size }

    /// Marges réelles de l'écran (Dynamic Island, barre d'accueil) : le panneau couvre TOUT
    /// l'écran (pour pouvoir arrondir ses coins quand on le tire), le contenu reste dans la zone sûre.
    private var insets: UIEdgeInsets {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.safeAreaInsets ?? .zero
    }

    var body: some View {
        ZStack(alignment: .top) {
            background

            // Pochette ANIMÉE : bord à bord en haut de l'écran, holographique, qui respire.
            if living, let track = player.current {
                // Carrée, pleine largeur, juste sous la barre d'état : la pochette ENTIÈRE est
                // visible, bord à bord ; le fond (pochette floutée) la prolonge tout autour.
                LivingArtwork(track: track, playing: player.playing, bpm: player.currentBPM,
                              height: screen.width)
                    .padding(.top, insets.top + 2)
                    .offset(x: artSwipe)
                    .opacity(1 - min(0.4, Double(abs(artSwipe)) / 400))
                    .id(track.id)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }

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
                    Spacer(minLength: 10)
                    artworkSlot(track)
                        // Glisser la pochette : gauche = suivant, droite = précédent.
                        .trackSwipe(
                            onNext: { player.next() },
                            onPrevious: { player.previous(force: true) },
                            onDrag: { translation in
                                if translation.height > 0, translation.height > abs(translation.width) {
                                    dragOffset = translation.height
                                } else if abs(translation.width) > abs(translation.height) {
                                    artSwipe = translation.width / (1 + abs(translation.width) / 260)
                                }
                            },
                            onRelease: { translation, projected in
                                if translation.height > 0, translation.height > abs(translation.width) {
                                    if translation.height > 130 || projected.height > 420 {
                                        dismissFromDrag()
                                    } else {
                                        withAnimation(Motion.sheet) { dragOffset = 0 }
                                    }
                                }
                                withAnimation(Motion.spring) { artSwipe = 0 }
                            }
                        )
                    if visualizerOn {
                        SpectrumBars(tint: tint)
                            .frame(height: 30)
                            .padding(.horizontal, 32)
                            .padding(.top, 14)
                            .transition(.opacity)
                    }
                    Spacer(minLength: 12)
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
            }
            .padding(.top, insets.top)
            .padding(.bottom, max(insets.bottom, 12))
            .animation(Motion.spring, value: player.current?.id)
        }
        .animation(.easeInOut(duration: 0.6), value: player.current?.id)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: dragOffset > 1 ? 44 : 0, style: .continuous))
        .offset(y: dragOffset)
        .gesture(
            DragGesture(minimumDistance: 14, coordinateSpace: .global)
                .onChanged { value in
                    let dy = value.translation.height
                    guard dy > 0, abs(dy) > abs(value.translation.width) else { return }
                    dragOffset = dy
                }
                .onEnded { value in
                    let dy = value.translation.height
                    if dy > 130 || value.predictedEndTranslation.height > 420 {
                        dismissFromDrag()
                    } else {
                        withAnimation(Motion.sheet) { dragOffset = 0 }
                    }
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
        // Visualiseur branché seulement quand on le voit (vue ouverte + app au premier plan).
        // Visualiseur branché APRÈS l'animation d'ouverture (0,5 s) : l'ouverture reste fluide.
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

    @ViewBuilder private var background: some View {
        if Theme.appleStyle {
            CoverBackdrop(track: player.current, playing: player.playing, bpm: player.currentBPM)
        } else {
            AnimatedBackdrop()
        }
    }

    /// Pochette animée active (style Apple Music + réglage « Pochette animée »).
    private var living: Bool { livingArtwork && Theme.appleStyle && !reduceMotion }

    /// Emplacement de la pochette : la carte classique, ou un espace vide (touchable pour le
    /// swipe) quand la pochette animée occupe tout le haut de l'écran.
    @ViewBuilder private func artworkSlot(_ track: Track) -> some View {
        if living {
            Color.clear
                .frame(height: min(screen.width - 56, 390))
                .contentShape(Rectangle())
        } else {
            artwork(track)
        }
    }

    private func artwork(_ track: Track) -> some View {
        let side = min(screen.width - 56, 390)
        return ZStack {
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

    /// Fermeture au glissé : le panneau continue sa course vers le bas, PUIS disparaît (sans saut).
    private func dismissFromDrag() {
        Haptics.tap()
        withAnimation(Motion.sheet) { dragOffset = screen.height }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { player.showFullScreen = false }
            dragOffset = 0
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
