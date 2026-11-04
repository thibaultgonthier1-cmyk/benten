import AVKit
import MediaPlayer
import SwiftUI
import UniformTypeIdentifiers

/// Destinations de navigation de la bibliothèque (pages poussées, comme Apple Music).
enum LibraryRoute: Hashable {
    case album(String)
    case artist(String)
}

// MARK: - Bibliothèque

struct LibraryView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var favorites: FavoritesStore
    @State private var showImporter = false
    @State private var mode: BrowseMode = .albums

    enum BrowseMode: String, CaseIterable {
        case albums = "Albums", artists = "Artistes", tracks = "Titres"
        var icon: String {
            switch self {
            case .albums: return "square.stack.fill"
            case .artists: return "music.mic"
            case .tracks: return "music.note"
            }
        }
    }

    private let layout = DeviceLayout.current

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()

                if library.tracks.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !Theme.appleStyle { header }
                            modePicker
                            content
                        }
                        .padding(.horizontal, layout.pagePadding)
                        .padding(.bottom, 20)
                    }
                }
            }
            .navigationTitle(Theme.appleStyle ? "Bibliothèque" : "")
            .navigationBarTitleDisplayMode(Theme.appleStyle ? .large : .inline)
            .navigationDestination(for: LibraryRoute.self) { route in
                switch route {
                case .album(let id): AlbumDetailView(albumID: id)
                case .artist(let id): ArtistDetailView(artistID: id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .fill(Theme.accentGradient)
                                .frame(width: 28, height: 28)
                                .shadow(color: Theme.accent.opacity(0.45), radius: 6)
                            Text("B")
                                .font(.system(size: 15, weight: .bold, design: .serif))
                                .foregroundStyle(Theme.ink)
                        }
                        if !Theme.appleStyle {
                            Text("Benten")
                                .font(.system(size: 18, design: .serif))
                                .foregroundStyle(Theme.ivory)
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        Button {
                            Haptics.tap()
                            router.tab = .search
                        } label: {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(Theme.ivory.opacity(0.9))
                        }
                        Button {
                            Haptics.press()
                            showImporter = true
                        } label: {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 22))
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
            }
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav, .aiff],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case .success(let urls):
                    Task { await library.importFiles(urls) }
                case .failure(let error):
                    library.lastError = error.localizedDescription
                }
            }
            .alert("Impossible", isPresented: Binding(
                get: { library.lastError != nil },
                set: { if !$0 { library.lastError = nil } }
            )) {
                Button("OK", role: .cancel) { library.lastError = nil }
            } message: {
                Text(library.lastError ?? "")
            }
        }
    }

    @ViewBuilder private var content: some View {
        let currentID = player.current?.id
        switch mode {
        case .albums:
            LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 8) {
                ForEach(library.albums) { album in
                    let isCurrent = currentID.map { id in album.tracks.contains { $0.id == id } } ?? false
                    NavigationLink(value: LibraryRoute.album(album.id)) {
                        AlbumTileView(album: album, isCurrent: isCurrent, isPlaying: player.playing)
                    }
                    .buttonStyle(PressableStyle())
                    .contextMenu {
                        Button { player.play(album.tracks, startingAt: 0) } label: { Label("Lire", systemImage: "play.fill") }
                        Button { player.playShuffled(album.tracks) } label: { Label("Aléatoire", systemImage: "shuffle") }
                    }
                }
            }
            .transition(.opacity)

        case .artists:
            LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 8) {
                ForEach(library.artists) { artist in
                    NavigationLink(value: LibraryRoute.artist(artist.id)) {
                        ArtistTileView(artist: artist)
                    }
                    .buttonStyle(PressableStyle())
                    .contextMenu {
                        let all = artist.albums.flatMap(\.tracks)
                        Button { player.play(all, startingAt: 0) } label: { Label("Tout lire", systemImage: "play.fill") }
                        Button { player.playShuffled(all) } label: { Label("Aléatoire", systemImage: "shuffle") }
                    }
                }
            }
            .transition(.opacity)

        case .tracks:
            // LazyVStack : seules les lignes visibles sont construites (fluide avec 1000+ titres).
            LazyVStack(spacing: 2) {
                let list = library.tracksByTitle
                ForEach(Array(list.enumerated()), id: \.element.id) { offset, track in
                    TrackRow(
                        track: track,
                        isCurrent: currentID == track.id,
                        isPlaying: player.playing,
                        isFavorite: favorites.contains(track.id),
                        onPlay: { player.play(list, startingAt: offset) },
                        onToggleFavorite: { favorites.toggle(track.id) }
                    )
                }
            }
            .transition(.opacity)
        }
    }

    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ForEach(BrowseMode.allCases, id: \.self) { value in
                    let selected = mode == value
                    Button {
                        Haptics.choose()
                        withAnimation(Motion.quick) { mode = value }
                    } label: {
                        Label(value.rawValue, systemImage: value.icon)
                            .font(.system(size: 13.5, weight: selected ? .semibold : .medium))
                            .foregroundStyle(selected ? Theme.ink : Theme.ivory.opacity(0.9))
                            .padding(.horizontal, 13)
                            .padding(.vertical, 8)
                            .background(
                                Capsule().fill(selected ? AnyShapeStyle(Theme.accentGradient) : AnyShapeStyle(Color.white.opacity(0.08)))
                            )
                    }
                    .buttonStyle(PressableStyle(scale: 0.92))
                }
            }
            Text("\(library.tracks.count) morceaux · \(library.albums.count) albums · v\(Bundle.main.appVersion)")
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundStyle(Theme.dim)
        }
        .padding(.top, Theme.appleStyle ? 0 : 4)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("今宵 · ce soir")
                .font(.system(size: 11, weight: .medium))
                .tracking(2.2)
                .foregroundStyle(Theme.accent.opacity(0.75))
            Text("Ta bibliothèque,\nen local")
                .serifTitle(30)
        }
        .padding(.top, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Theme.accentGradient)
                    .frame(width: 84, height: 84)
                    .shadow(color: Theme.accent.opacity(0.35), radius: 22)
                Image(systemName: "music.note")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(Theme.ink)
                    .symbolEffect(.pulse)
            }
            Text("Aucune musique")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(Theme.ivory)
            Text("Touche + pour choisir des fichiers, ou récupère ta bibliothèque du PC depuis les Réglages.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 44)
        }
    }
}

// MARK: - Tuiles

/// Tuile d'album (contenu seul : la navigation est portée par le `NavigationLink` parent).
struct AlbumTileView: View {
    let album: Library.AlbumGroup
    let isCurrent: Bool
    let isPlaying: Bool

    private var glow: Color {
        Theme.appleStyle ? .clear : (ArtworkCache.shared.cachedTint(for: album.artworkTrack) ?? Theme.accent)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                if !Theme.appleStyle {
                    CoverGlow(color: glow, intensity: isCurrent ? 0.95 : 0.6)
                }
                ArtworkView(track: album.artworkTrack, maxPixel: 560)
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.coverRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.coverRadius, style: .continuous)
                            .strokeBorder(Theme.hairline)
                    )
                if isCurrent {
                    NowPlayingBars(animating: isPlaying, color: Theme.ink)
                        .frame(width: 15, height: 13)
                        .padding(8)
                        .background(Circle().fill(Theme.accentGradient))
                        .padding(8)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(album.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.ivory)
                    .lineLimit(1)
                Text(album.artist)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }
}

/// Tuile d'artiste : photo ronde, comme Apple Music.
struct ArtistTileView: View {
    let artist: Library.ArtistGroup

    var body: some View {
        VStack(spacing: 8) {
            ArtworkView(track: artist.artworkTrack, maxPixel: 560)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.hairline))
            Text(artist.name)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.ivory)
                .lineLimit(1)
            Text("\(artist.trackCount) titre\(artist.trackCount > 1 ? "s" : "")")
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)
        }
        .contentShape(Rectangle())
    }
}

/// Pochette : image extraite du fichier, ou repli dessiné (dégradé de l'accent).
///
/// Décodage + redimensionnement HORS du fil principal (`ArtworkCache.load`). Le fil principal ne
/// décode jamais d'image : le défilement reste lisse. `maxPixel` : 180 (lignes, mini-lecteur),
/// 560 (tuiles, en-têtes), 1000 (lecteur plein écran).
struct ArtworkView: View {
    let track: Track
    var maxPixel: CGFloat = 560
    @State private var loaded: UIImage?

    var body: some View {
        ZStack {
            if let image = loaded ?? ArtworkCache.shared.cached(for: track, maxPixel: maxPixel) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                Theme.accentGradient
                    .overlay(
                        Image(systemName: "music.note")
                            .font(.system(size: 22, weight: .light))
                            .foregroundStyle(Theme.ink.opacity(0.55))
                    )
            }
        }
        .clipped()
        .task(id: "\(track.id)@\(Int(maxPixel))") {
            if let hit = ArtworkCache.shared.cached(for: track, maxPixel: maxPixel) {
                loaded = hit
                return
            }
            loaded = nil
            let image = await ArtworkCache.shared.load(for: track, maxPixel: maxPixel)
            if !Task.isCancelled {
                withAnimation(.easeOut(duration: 0.18)) { loaded = image }
            }
        }
    }
}

// MARK: - Mini-lecteur

/// Barre de lecture réduite, posée JUSTE AU-DESSUS des onglets (dans chaque onglet).
struct MiniPlayer: View {
    @EnvironmentObject private var player: Player
    @State private var nextTaps = 0

    var body: some View {
        if let track = player.current {
            HStack(spacing: 12) {
                ArtworkView(track: track, maxPixel: 180)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .shadow(color: .black.opacity(0.3), radius: 4, y: 2)

                VStack(alignment: .leading, spacing: 1) {
                    Text(track.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .lineLimit(1)
                    Text(track.artist)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                }
                .id(track.id)
                .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))

                Spacer(minLength: 6)

                Button {
                    Haptics.press()
                    player.toggle()
                } label: {
                    Image(systemName: player.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(TransportStyle(haloSize: 42))

                Button {
                    Haptics.tap()
                    nextTaps += 1
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .symbolEffect(.bounce, value: nextTaps)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(TransportStyle(haloSize: 42))
            }
            .animation(Motion.spring, value: track.id)
            .animation(Motion.quick, value: player.playing)
            .padding(.leading, 8)
            .padding(.trailing, 6)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.ink2.opacity(0.55)))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.hairline))
                    .shadow(color: .black.opacity(0.45), radius: 16, y: 6)
            )
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
            .onTapGesture {
                Haptics.tap()
                withAnimation(Motion.sheet) { player.showFullScreen = true }
            }
            .gesture(
                DragGesture(minimumDistance: 12).onEnded { value in
                    if value.translation.height < -20 {
                        Haptics.tap()
                        withAnimation(Motion.sheet) { player.showFullScreen = true }
                    }
                }
            )
        }
    }
}

/// Pose le mini-lecteur au-dessus de la barre d'onglets. Appliqué à CHAQUE onglet : un
/// `safeAreaInset` sur la TabView entière le faisait passer PAR-DESSUS les onglets (plus d'accès
/// aux réglages pendant la lecture).
struct MiniPlayerInset: ViewModifier {
    @EnvironmentObject private var player: Player

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            if player.current != nil {
                MiniPlayer()
                    .padding(.bottom, 6)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Motion.spring, value: player.current == nil)
    }
}

extension View {
    func miniPlayerInset() -> some View { modifier(MiniPlayerInset()) }
}

// MARK: - Lecteur plein écran

/// Vue lecture, à la manière d'Apple Music : pochette qui grossit en lecture et rétrécit en pause,
/// titre à gauche, barre de progression qui s'épaissit sous le doigt, transport, volume système
/// réel, AirPlay, AutoMix. Se referme au chevron ou en tirant vers le bas.
struct NowPlayingView: View {
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var favorites: FavoritesStore
    @EnvironmentObject private var playlists: PlaylistStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0
    @State private var previousTaps = 0
    @State private var nextTaps = 0

    private var screen: CGSize { UIScreen.main.bounds.size }

    /// Marges réelles de l'écran (Dynamic Island, barre d'accueil) : le panneau couvre TOUT
    /// l'écran (pour pouvoir arrondir ses coins quand on le tire), le contenu reste dans la zone sûre.
    private var insets: UIEdgeInsets {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.safeAreaInsets ?? .zero
    }

    var body: some View {
        ZStack {
            background

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
                    artwork(track)
                    Spacer(minLength: 16)
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
    }

    @ViewBuilder private var background: some View {
        if Theme.appleStyle {
            CoverBackdrop(track: player.current, playing: player.playing, bpm: player.currentBPM)
        } else {
            AnimatedBackdrop()
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
                .shadow(
                    color: .black.opacity(player.playing ? 0.5 : 0.28),
                    radius: player.playing ? 30 : 12,
                    y: player.playing ? 18 : 6
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
            }
            .id(track.id)
            .transition(.opacity)
            Spacer(minLength: 8)

            Button {
                Haptics.choose()
                favorites.toggle(track.id)
            } label: {
                Image(systemName: isFavorite ? "heart.fill" : "heart")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(isFavorite ? Theme.accent : .white)
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
                    .foregroundStyle(player.shuffle ? Theme.accent : .white.opacity(0.65))
                    .symbolEffect(.bounce, value: player.shuffle)
                    .frame(width: 40, height: 36)
            }
            .buttonStyle(PressableStyle(scale: 0.85))

            Spacer()

            Button {
                Haptics.choose()
                withAnimation(Motion.quick) { player.setAutomix(!player.automixEnabled) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "dial.high.fill")
                        .symbolEffect(.bounce, value: player.automixEnabled)
                    Text("AutoMix")
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(player.automixEnabled ? Theme.ink : .white.opacity(0.75))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(player.automixEnabled ? AnyShapeStyle(Theme.accentGradient) : AnyShapeStyle(Color.white.opacity(0.12)))
                )
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
                    .foregroundStyle(player.repeatMode == .off ? .white.opacity(0.65) : Theme.accent)
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

// MARK: - Pages album et artiste

struct AlbumDetailView: View {
    let albumID: String
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            if let album = library.albums.first(where: { $0.id == albumID }) {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        VStack(spacing: 12) {
                            ArtworkView(track: album.artworkTrack, maxPixel: 560)
                                .frame(width: 250, height: 250)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .shadow(color: .black.opacity(0.55), radius: 24, y: 12)
                                .padding(.top, 8)
                            VStack(spacing: 3) {
                                Text(album.title)
                                    .font(.system(size: 22, weight: .bold))
                                    .foregroundStyle(Theme.ivory)
                                    .multilineTextAlignment(.center)
                                Text(album.artist)
                                    .font(.system(size: 18))
                                    .foregroundStyle(Theme.accent)
                                Text("\(album.tracks.count) titre\(album.tracks.count > 1 ? "s" : "") · \(TimeFormatting.minutes(album.tracks.reduce(0) { $0 + $1.duration }))")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.dim)
                                    .padding(.top, 2)
                            }
                            .padding(.horizontal, 20)
                            PlayShuffleButtons(tracks: album.tracks)
                        }
                        .padding(.bottom, 14)

                        ForEach(Array(album.tracks.enumerated()), id: \.element.id) { offset, track in
                            NumberedTrackRow(
                                number: offset + 1,
                                track: track,
                                isCurrent: player.current?.id == track.id,
                                isPlaying: player.playing
                            ) {
                                player.play(album.tracks, startingAt: offset)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            } else {
                Text("Album introuvable").foregroundStyle(Theme.dim)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.ink, for: .navigationBar)
    }
}

struct ArtistDetailView: View {
    let artistID: String
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            if let artist = library.artists.first(where: { $0.id == artistID }) {
                let all = artist.albums.flatMap(\.tracks)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(spacing: 10) {
                            ArtworkView(track: artist.artworkTrack, maxPixel: 560)
                                .frame(width: 170, height: 170)
                                .clipShape(Circle())
                                .shadow(color: .black.opacity(0.55), radius: 20, y: 10)
                            Text(artist.name)
                                .font(.system(size: 26, weight: .bold))
                                .foregroundStyle(Theme.ivory)
                                .multilineTextAlignment(.center)
                            PlayShuffleButtons(tracks: all)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)

                        Text("Albums")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(Theme.ivory)
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 14) {
                                ForEach(artist.albums) { album in
                                    NavigationLink(value: LibraryRoute.album(album.id)) {
                                        AlbumTileView(
                                            album: album,
                                            isCurrent: album.tracks.contains { $0.id == player.current?.id },
                                            isPlaying: player.playing
                                        )
                                        .frame(width: 150)
                                    }
                                    .buttonStyle(PressableStyle())
                                }
                            }
                        }

                        Text("Titres")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(Theme.ivory)
                        LazyVStack(spacing: 2) {
                            ForEach(Array(all.enumerated()), id: \.element.id) { offset, track in
                                TrackRow(
                                    track: track,
                                    isCurrent: player.current?.id == track.id,
                                    isPlaying: player.playing,
                                    onPlay: { player.play(all, startingAt: offset) }
                                )
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            } else {
                Text("Artiste introuvable").foregroundStyle(Theme.dim)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.ink, for: .navigationBar)
    }
}

/// Boutons « Lecture » / « Aléatoire » des pages album, artiste.
struct PlayShuffleButtons: View {
    let tracks: [Track]
    @EnvironmentObject private var player: Player

    var body: some View {
        HStack(spacing: 10) {
            button("Lecture", icon: "play.fill") { player.play(tracks, startingAt: 0) }
            button("Aléatoire", icon: "shuffle") { player.playShuffled(tracks) }
        }
        .disabled(tracks.isEmpty)
    }

    private func button(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.press()
            action()
        } label: {
            Label(title, systemImage: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.08)))
        }
        .buttonStyle(PressableStyle())
    }
}

/// Ligne numérotée d'un album ; le morceau en cours montre des barres animées à la place du n°.
struct NumberedTrackRow: View {
    let number: Int
    let track: Track
    let isCurrent: Bool
    let isPlaying: Bool
    let onPlay: () -> Void

    var body: some View {
        Button {
            Haptics.tap()
            onPlay()
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    ZStack {
                        if isCurrent {
                            NowPlayingBars(animating: isPlaying, color: Theme.accent)
                                .frame(width: 15, height: 13)
                        } else {
                            Text("\(number)")
                                .font(.system(size: 14).monospacedDigit())
                                .foregroundStyle(Theme.dim)
                        }
                    }
                    .frame(width: 26)
                    Text(track.title)
                        .font(.system(size: 15.5))
                        .foregroundStyle(isCurrent ? Theme.accent : Theme.ivory)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(TimeFormatting.short(track.duration))
                        .font(.system(size: 12.5).monospacedDigit())
                        .foregroundStyle(Theme.dim)
                }
                .padding(.vertical, 12)
                Divider().overlay(Theme.hairline).padding(.leading, 38)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.98))
    }
}

/// Formatage des durées, partagé.
enum TimeFormatting {
    static func short(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func minutes(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0 min" }
        let minutes = Int((seconds / 60).rounded())
        return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(minutes) min"
    }
}
