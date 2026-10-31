import SwiftUI
import UniformTypeIdentifiers

/// Bibliothèque : l'accueil du bureau, adapté au format téléphone.
struct LibraryView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var favorites: FavoritesStore
    @State private var showImporter = false
    @State private var openAlbum: Library.AlbumGroup?
    @State private var openArtist: Library.ArtistGroup?
    @State private var mode: BrowseMode = .albums

    /// Trois façons de parcourir, comme les vues Albums / Artistes / Titres du PC.
    enum BrowseMode: String, CaseIterable { case albums = "Albums", artists = "Artistes", tracks = "Titres" }

    // Colonnes calculées d'après l'écran réel : 2 sur SE/mini, 3 sur les autres iPhone,
    // 4-5 sur iPad. Les pochettes gardent ainsi des proportions correctes partout.
    private let layout = DeviceLayout.current

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()

                if library.tracks.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            header

                            // Les trois vues du PC, dans le même écran.
                            switch mode {
                            case .albums:
                                LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 6) {
                                    ForEach(library.albums) { album in
                                        AlbumTileView(
                                            album: album,
                                            isPlaying: album.tracks.contains(where: { $0.id == player.current?.id })
                                        ) {
                                            player.play(album.tracks, startingAt: 0)
                                            player.showFullScreen = true
                                        } onOpen: {
                                            openAlbum = album
                                        }
                                    }
                                }

                            case .artists:
                                LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 6) {
                                    ForEach(library.artists) { artist in
                                        ArtistTileView(
                                            artist: artist,
                                            isPlaying: artist.albums.contains { album in
                                                album.tracks.contains(where: { $0.id == player.current?.id })
                                            }
                                        ) {
                                            // Appui : on lit tous les morceaux de l'artiste.
                                            let all = artist.albums.flatMap(\.tracks)
                                            player.play(all, startingAt: 0)
                                            player.showFullScreen = true
                                        } onOpen: {
                                            openArtist = artist
                                        }
                                    }
                                }

                            case .tracks:
                                VStack(spacing: 2) {
                                    ForEach(Array(library.tracksByTitle.enumerated()), id: \.element.id) { offset, track in
                                        TrackRow(
                                            track: track,
                                            isCurrent: player.current?.id == track.id,
                                            isFavorite: favorites.contains(track.id),
                                            onPlay: {
                                                player.play(library.tracksByTitle, startingAt: offset)
                                                player.showFullScreen = true
                                            },
                                            onToggleFavorite: { favorites.toggle(track.id) }
                                        )
                                        Divider().overlay(Theme.hairline)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, layout.pagePadding)
                        .padding(.bottom, 96)
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Theme.accentGradient)
                            .frame(width: 26, height: 26)
                            .shadow(color: Theme.accent.opacity(0.5), radius: 8)
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Benten")
                                .font(.system(size: 18, design: .serif))
                                .foregroundStyle(Theme.ivory)
                            Text("LECTURE LOCALE")
                                .font(.system(size: 8, weight: .semibold))
                                .tracking(1.6)
                                .foregroundStyle(Theme.dim)
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        // Accès direct à la recherche, même quand une musique joue.
                        Button {
                            Haptics.tap()
                            router.tab = .search
                        } label: {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 18))
                                .foregroundStyle(Theme.ivory.opacity(0.85))
                        }
                        Button {
                            Haptics.press()
                            showImporter = true
                        } label: {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 22))
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
            .sheet(item: $openAlbum) { album in
                AlbumDetailView(album: album)
            }
            .sheet(item: $openArtist) { artist in
                ArtistDetailView(artist: artist)
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

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("今宵 · ce soir")
                .font(.system(size: 11, weight: .medium))
                .tracking(2.2)
                .foregroundStyle(Theme.accent.opacity(0.75))
            Text("Ta bibliothèque,\nen local")
                .serifTitle(30)
            Text("\(library.tracks.count) morceau\(library.tracks.count > 1 ? "x" : "") · \(library.albums.count) album\(library.albums.count > 1 ? "s" : "") · sur cet iPhone")
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)

            // Les trois vues du PC, dans un sélecteur compact.
            Picker("Parcourir", selection: $mode) {
                ForEach(BrowseMode.allCases, id: \.self) { value in
                    Text(value.rawValue).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .padding(.top, 6)
        }
        .padding(.top, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Theme.accentGradient)
                    .frame(width: 78, height: 78)
                    .shadow(color: Theme.accent.opacity(0.35), radius: 22)
                Image(systemName: "music.note")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(Theme.ink)
            }
            Text("Aucune musique")
                .serifTitle(24)
            Text("Touche + pour choisir des fichiers dans Fichiers ou iCloud, ou récupère ta bibliothèque du PC depuis les Réglages.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 44)
        }
    }
}

/// Tuile d'album : pochette, halo de sa propre couleur, titre, artiste.
struct AlbumTile: View {
    let track: Track
    let playing: Bool
    let action: () -> Void
    @State private var pressed = false

    // Teinte mémorisée : la moyenne de l'image n'est calculée qu'une fois par pochette.
    private var glow: Color { ArtworkCache.shared.tint(for: track) }

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack {
                    CoverGlow(color: glow, intensity: playing ? 0.95 : 0.6)
                    ArtworkView(track: track)
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.tileRadius, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.tileRadius, style: .continuous)
                                .strokeBorder(Theme.hairline)
                        )
                        .overlay(alignment: .bottomTrailing) {
                            if playing {
                                Circle()
                                    .fill(Theme.accentGradient)
                                    .frame(width: 26, height: 26)
                                    .overlay(
                                        Image(systemName: "waveform")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundStyle(Theme.ink)
                                    )
                                    .padding(8)
                            }
                        }
                }
                Text(track.title)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(Theme.ivory)
                    .lineLimit(1)
                Text(track.artist)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
            }
            .scaleEffect(pressed ? 0.955 : 1)
            .animation(Motion.quick, value: pressed)
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in pressed = true }
                .onEnded { _ in pressed = false }
        )
    }
}

/// Pochette : image extraite du fichier, ou repli dessiné (dégradé or).
struct ArtworkView: View {
    let track: Track

    var body: some View {
        ZStack {
            // Cache : l'image est décodée UNE fois puis gardée en mémoire. Sans ça, chaque passage
            // dans la grille redécodait la pochette et faisait saccader le défilement.
            if let image = ArtworkCache.shared.image(for: track) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Theme.accentGradient
                    .overlay(
                        Image(systemName: "music.note")
                            .font(.system(size: 24, weight: .light))
                            .foregroundStyle(Theme.ink.opacity(0.6))
                    )
            }
        }
        .clipped()
    }
}

/// Barre de lecture réduite, au-dessus des onglets.
struct MiniPlayer: View {
    @EnvironmentObject private var player: Player

    var body: some View {
        if let track = player.current {
            HStack(spacing: 12) {
                ArtworkView(track: track)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(Theme.ivory)
                        .lineLimit(1)
                    Text(track.artist)
                        .font(.system(size: 11.5))
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)

                Button {
                    Haptics.press()
                    player.toggle()
                } label: {
                    ZStack {
                        Circle().fill(Theme.accentGradient)
                        Image(systemName: player.playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Theme.ink)
                    }
                    .frame(width: 38, height: 38)
                    .shadow(color: Theme.accent.opacity(0.45), radius: 10, y: 3)
                }
                Button {
                    Haptics.tap()
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.ivory.opacity(0.85))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Theme.ink2)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.hairline))
                    .shadow(color: .black.opacity(0.5), radius: 18, y: 8)
            )
            .padding(.horizontal, 10)
            .onTapGesture {
                Haptics.tap()
                player.showFullScreen = true
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// Vue plein écran : grand disque laqué, pochette centrée devant, transport doré.
///
/// Fermeture par le chevron OU en tirant vers le bas. Les commandes de boucle et d'aléatoire sont
/// ICI, comme sur le bureau, au lieu d'être cachées dans les réglages.
struct NowPlayingView: View {
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var favorites: FavoritesStore
    @EnvironmentObject private var playlists: PlaylistStore
    @EnvironmentObject private var clock: PlaybackClock
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        ZStack {
            AnimatedBackdrop()

            VStack(spacing: 18) {
                Capsule()
                    .fill(Color.white.opacity(0.28))
                    .frame(width: 44, height: 5)
                    .padding(.top, 10)

                Spacer(minLength: 4)

                if let track = player.current {
                    ZStack {
                        LacquerDisc(playing: player.playing)
                            .frame(width: min(UIScreen.main.bounds.width * 0.84, 340))
                        ArtworkView(track: track)
                            .frame(width: min(UIScreen.main.bounds.width * 0.56, 232))
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .shadow(color: .black.opacity(0.65), radius: 26, y: 14)
                    }

                    VStack(spacing: 5) {
                        Text(track.title)
                            .font(.system(size: 22, design: .serif))
                            .foregroundStyle(Theme.ivory)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                        Text(track.artist)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.dim)
                    }
                    .padding(.horizontal, 28)

                    VStack(spacing: 4) {
                        Slider(
                            value: Binding(get: { clock.position }, set: { player.seek(to: $0) }),
                            in: 0...max(1, clock.duration)
                        )
                        .tint(Theme.accent)

                        HStack {
                            Text(clock.formatted(clock.position))
                            Spacer()
                            Text(clock.formatted(clock.duration))
                        }
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.dim)
                    }
                    .padding(.horizontal, 28)

                    HStack(spacing: 36) {
                        Button {
                            Haptics.tap()
                            player.previous()
                        } label: {
                            Image(systemName: "backward.fill").font(.system(size: 20))
                        }
                        Button {
                            Haptics.press()
                            player.toggle()
                        } label: {
                            ZStack {
                                Circle().fill(Theme.accentGradient)
                                Image(systemName: player.playing ? "pause.fill" : "play.fill")
                                    .font(.system(size: 24, weight: .bold))
                                    .foregroundStyle(Theme.ink)
                            }
                            .frame(width: 68, height: 68)
                            .shadow(color: Theme.accent.opacity(0.45), radius: 18, y: 6)
                            .scaleEffect(player.playing && !reduceMotion ? 1.03 : 1)
                            .animation(reduceMotion ? nil : Motion.spring, value: player.playing)
                        }
                        Button {
                            Haptics.tap()
                            player.next()
                        } label: {
                            Image(systemName: "forward.fill").font(.system(size: 20))
                        }
                    }
                    .foregroundStyle(Theme.ivory)

                    // Boucle, aléatoire, cœur et ajout à une playlist : tout est ici.
                    HStack(spacing: 34) {
                        Button {
                            Haptics.choose()
                            player.shuffle.toggle()
                        } label: {
                            Image(systemName: "shuffle")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(player.shuffle ? Theme.accent : Theme.dim)
                        }
                        Button {
                            Haptics.choose()
                            switch player.repeatMode {
                            case .off: player.repeatMode = .all
                            case .all: player.repeatMode = .one
                            case .one: player.repeatMode = .off
                            }
                        } label: {
                            Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(player.repeatMode == .off ? Theme.dim : Theme.accent)
                        }
                        Button {
                            Haptics.choose()
                            favorites.toggle(track.id)
                        } label: {
                            Image(systemName: favorites.contains(track.id) ? "heart.fill" : "heart")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(favorites.contains(track.id) ? Theme.accent : Theme.dim)
                        }
                        Menu {
                            ForEach(playlists.items) { playlist in
                                Button(playlist.name) {
                                    Haptics.choose()
                                    playlists.add(track.id, to: playlist.id)
                                }
                            }
                            Button {
                                playlists.create(named: track.title, from: [track.id])
                            } label: {
                                Label("Nouvelle playlist", systemImage: "plus")
                            }
                        } label: {
                            Image(systemName: "text.badge.plus")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(Theme.dim)
                        }
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 34)
                }

                Spacer(minLength: 0)
            }
            .offset(y: max(0, dragOffset))
            .overlay(alignment: .topTrailing) {
                Button {
                    Haptics.tap()
                    player.showFullScreen = false
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.ivory.opacity(0.8))
                        .padding(16)
                }
            }
            .gesture(
                // Glissement vers le bas : referme le panneau (geste attendu sur iOS).
                DragGesture(minimumDistance: 24)
                    .onChanged { value in
                        dragOffset = max(0, value.translation.height)
                    }
                    .onEnded { value in
                        if value.translation.height > 90 {
                            player.showFullScreen = false
                        }
                        withAnimation(Motion.quick) { dragOffset = 0 }
                    }
            )
        }
    }
}



/// Tuile d'ALBUM : une pochette, un titre, un artiste, le nombre de morceaux.
///
/// Le PC présente la musique par album ; c'est aussi ce qui rend une bibliothèque lisible d'un coup
/// d'œil, au lieu d'une liste de titres répétés par leur pochette.
struct AlbumTileView: View {
    let album: Library.AlbumGroup
    let isPlaying: Bool
    let onPlay: () -> Void
    let onOpen: () -> Void
    @State private var pressed = false

    private var glow: Color { ArtworkCache.shared.tint(for: album.artworkTrack) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                Haptics.tap()
                onPlay()
            }) {
                ZStack {
                    CoverGlow(color: glow, intensity: isPlaying ? 0.95 : 0.6)
                    ArtworkView(track: album.artworkTrack)
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.tileRadius, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.tileRadius, style: .continuous)
                                .strokeBorder(Theme.hairline)
                        )
                        .overlay(alignment: .bottomTrailing) {
                            if isPlaying {
                                Circle()
                                    .fill(Theme.accentGradient)
                                    .frame(width: 26, height: 26)
                                    .overlay(
                                        Image(systemName: "waveform")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundStyle(Theme.ink)
                                    )
                                    .padding(8)
                            }
                        }
                }
                .scaleEffect(pressed ? 0.955 : 1)
                .animation(Motion.quick, value: pressed)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in pressed = true }
                    .onEnded { _ in pressed = false }
            )

            // Le titre ouvre l'album : appui court = lecture, appui sur le texte = liste des
            // morceaux. Deux intentions distinctes, deux zones distinctes.
            Button(action: {
                Haptics.choose()
                onOpen()
            }) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(album.title)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(Theme.ivory)
                        .lineLimit(1)
                    Text("\(album.artist) · \(album.tracks.count) titre\(album.tracks.count > 1 ? "s" : "")")
                        .font(.system(size: 11.5))
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
    }
}

/// Liste des morceaux d'un album.
struct AlbumDetailView: View {
    let album: Library.AlbumGroup
    @EnvironmentObject private var player: Player
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                ScrollView {
                    VStack(spacing: 16) {
                        ArtworkView(track: album.artworkTrack)
                            .frame(width: 180, height: 180)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .shadow(color: .black.opacity(0.6), radius: 20, y: 10)
                            .padding(.top, 12)

                        VStack(spacing: 3) {
                            Text(album.title)
                                .font(.system(size: 21, design: .serif))
                                .foregroundStyle(Theme.ivory)
                                .multilineTextAlignment(.center)
                            Text(album.artist)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.dim)
                        }

                        Button {
                            Haptics.press()
                            player.play(album.tracks, startingAt: 0)
                            dismiss()
                        } label: {
                            Label("Lire l'album", systemImage: "play.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Theme.ink)
                                .padding(.horizontal, 22)
                                .padding(.vertical, 11)
                                .background(Capsule().fill(Theme.accentGradient))
                        }

                        VStack(spacing: 0) {
                            ForEach(Array(album.tracks.enumerated()), id: \.element.id) { offset, track in
                                Button {
                                    Haptics.tap()
                                    player.play(album.tracks, startingAt: offset)
                                    dismiss()
                                } label: {
                                    HStack(spacing: 10) {
                                        Text("\(offset + 1)")
                                            .font(.system(size: 12, design: .monospaced))
                                            .foregroundStyle(Theme.dim)
                                            .frame(width: 22, alignment: .trailing)
                                        Text(track.title)
                                            .font(.system(size: 14))
                                            .foregroundStyle(player.current?.id == track.id ? Theme.accent : Theme.ivory)
                                            .lineLimit(1)
                                        Spacer(minLength: 6)
                                        Text(TimeFormatting.short(track.duration))
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(Theme.dim)
                                    }
                                    .padding(.vertical, 11)
                                    .padding(.horizontal, 14)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Divider().overlay(Theme.hairline)
                            }
                        }
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Theme.ink2.opacity(0.6))
                        )
                        .padding(.horizontal, 16)
                        .padding(.bottom, 30)
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fermer") { dismiss() }
                        .foregroundStyle(Theme.accent)
                }
            }
        }
    }
}

/// Formatage des durées, partagé.
enum TimeFormatting {
    static func short(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}




/// Tuile d'ARTISTE : sa pochette de référence, son nom, son nombre d'albums.
struct ArtistTileView: View {
    let artist: Library.ArtistGroup
    let isPlaying: Bool
    let onPlay: () -> Void
    let onOpen: () -> Void
    @State private var pressed = false

    private var glow: Color { ArtworkCache.shared.tint(for: artist.artworkTrack) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                Haptics.tap()
                onPlay()
            }) {
                ZStack {
                    CoverGlow(color: glow, intensity: isPlaying ? 0.95 : 0.6)
                    ArtworkView(track: artist.artworkTrack)
                        // Les artistes sont ronds sur Apple Music : même repère visuel ici.
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(Theme.hairline))
                }
                .scaleEffect(pressed ? 0.955 : 1)
                .animation(Motion.quick, value: pressed)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in pressed = true }
                    .onEnded { _ in pressed = false }
            )

            Button(action: {
                Haptics.choose()
                onOpen()
            }) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(artist.name)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(Theme.ivory)
                        .lineLimit(1)
                    Text("\(artist.albums.count) album\(artist.albums.count > 1 ? "s" : "") · \(artist.trackCount) titre\(artist.trackCount > 1 ? "s" : "")")
                        .font(.system(size: 11.5))
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
    }
}

/// Détail d'un artiste : ses albums, puis ses morceaux.
struct ArtistDetailView: View {
    let artist: Library.ArtistGroup
    @EnvironmentObject private var player: Player
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(spacing: 10) {
                            ArtworkView(track: artist.artworkTrack)
                                .frame(width: 150, height: 150)
                                .clipShape(Circle())
                                .shadow(color: .black.opacity(0.6), radius: 18, y: 8)
                            Text(artist.name)
                                .font(.system(size: 22, design: .serif))
                                .foregroundStyle(Theme.ivory)
                                .multilineTextAlignment(.center)
                            Button {
                                Haptics.press()
                                player.play(artist.albums.flatMap(\.tracks), startingAt: 0)
                                dismiss()
                            } label: {
                                Label("Tout lire", systemImage: "play.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.ink)
                                    .padding(.horizontal, 20)
                                    .padding(.vertical, 9)
                                    .background(Capsule().fill(Theme.accentGradient))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 10)

                        ForEach(artist.albums) { album in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 10) {
                                    ArtworkView(track: album.artworkTrack)
                                        .frame(width: 42, height: 42)
                                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(album.title)
                                            .font(.system(size: 14, weight: .medium))
                                            .foregroundStyle(Theme.ivory)
                                        Text("\(album.tracks.count) titre\(album.tracks.count > 1 ? "s" : "")")
                                            .font(.system(size: 11))
                                            .foregroundStyle(Theme.dim)
                                    }
                                    Spacer()
                                    Button {
                                        Haptics.tap()
                                        player.play(album.tracks, startingAt: 0)
                                        dismiss()
                                    } label: {
                                        Image(systemName: "play.circle.fill")
                                            .font(.system(size: 24))
                                            .foregroundStyle(Theme.accent)
                                    }
                                    .buttonStyle(.plain)
                                }
                                ForEach(Array(album.tracks.enumerated()), id: \.element.id) { offset, track in
                                    Button {
                                        Haptics.tap()
                                        player.play(album.tracks, startingAt: offset)
                                        dismiss()
                                    } label: {
                                        HStack(spacing: 8) {
                                            Text(track.title)
                                                .font(.system(size: 13))
                                                .foregroundStyle(player.current?.id == track.id ? Theme.accent : Theme.ivory)
                                                .lineLimit(1)
                                            Spacer()
                                            Text(TimeFormatting.short(track.duration))
                                                .font(.system(size: 10.5, design: .monospaced))
                                                .foregroundStyle(Theme.dim)
                                        }
                                        .contentShape(Rectangle())
                                        .padding(.leading, 52)
                                        .padding(.vertical, 5)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.bottom, 8)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 30)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fermer") { dismiss() }.foregroundStyle(Theme.accent)
                }
            }
        }
    }
}
