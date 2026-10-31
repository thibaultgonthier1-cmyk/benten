import SwiftUI
import UniformTypeIdentifiers

/// Bibliothèque : l'accueil du bureau, adapté au format téléphone.
///
/// Reprend l'en-tête du desktop (« 今宵 · ce soir » / « Ta bibliothèque, en local »), la grille de
/// pochettes avec halo coloré, et les mêmes micro-animations.
struct LibraryView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @State private var showImporter = false

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

                            LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 6) {
                                ForEach(Array(library.tracks.enumerated()), id: \.element.id) { offset, track in
                                    AlbumTile(track: track, playing: player.current?.id == track.id) {
                                        player.play(library.tracks, startingAt: offset)
                                        player.showFullScreen = true
                                    }
                                    .contextMenu {
                                        Button(role: .destructive) {
                                            library.delete(track)
                                        } label: {
                                            Label("Supprimer", systemImage: "trash")
                                        }
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
                            .fill(Theme.goldGradient)
                            .frame(width: 26, height: 26)
                            .shadow(color: Theme.gold.opacity(0.5), radius: 8)
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
                    Button {
                        showImporter = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.gold)
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

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("今宵 · ce soir")
                .font(.system(size: 11, weight: .medium))
                .tracking(2.2)
                .foregroundStyle(Theme.gold.opacity(0.75))
            Text("Ta bibliothèque,\nen local")
                .serifTitle(30)
            Text("\(library.tracks.count) morceau\(library.tracks.count > 1 ? "x" : "") · sur cet iPhone")
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)
        }
        .padding(.top, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Theme.goldGradient)
                    .frame(width: 78, height: 78)
                    .shadow(color: Theme.gold.opacity(0.35), radius: 22)
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

    private var glow: Color {
        if let url = track.artworkURL, let image = UIImage(contentsOfFile: url.path) {
            return Color(uiColor: image.dominantColor)
        }
        return Theme.gold
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack {
                    // Le halo reprend la teinte de la pochette : chaque tuile éclaire son coin.
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
                                // La pastille dorée signale la lecture en cours, comme le médaillon du bureau.
                                Circle()
                                    .fill(Theme.goldGradient)
                                    .frame(width: 26, height: 26)
                                    .overlay(Image(systemName: "waveform").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.ink))
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
            .scaleEffect(pressed ? 0.96 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: pressed)
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
            if let url = track.artworkURL, let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Theme.goldGradient
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
    @State private var appear = false

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

                // Médaillon doré du bureau : le bouton de lecture est le point focal.
                Button { player.toggle() } label: {
                    ZStack {
                        Circle().fill(Theme.goldGradient)
                        Image(systemName: player.playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Theme.ink)
                    }
                    .frame(width: 38, height: 38)
                    .shadow(color: Theme.gold.opacity(0.45), radius: 10, y: 3)
                }
                Button { player.next() } label: {
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
            .onTapGesture { player.showFullScreen = true }
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onAppear {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { appear = true }
            }
        }
    }
}

/// Vue plein écran : grand disque laqué, pochette centrée devant, transport doré.
struct NowPlayingView: View {
    @EnvironmentObject private var player: Player

    var body: some View {
        ZStack {
            AnimatedBackdrop()

            VStack(spacing: 20) {
                Capsule()
                    .fill(Color.white.opacity(0.22))
                    .frame(width: 36, height: 5)
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
                            value: Binding(get: { player.position }, set: { player.seek(to: $0) }),
                            in: 0...max(1, player.duration)
                        )
                        .tint(Theme.gold)

                        HStack {
                            Text(time(player.position))
                            Spacer()
                            Text(time(player.duration))
                        }
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.dim)
                    }
                    .padding(.horizontal, 28)

                    HStack(spacing: 36) {
                        Button { player.previous() } label: {
                            Image(systemName: "backward.fill").font(.system(size: 20))
                        }
                        Button { player.toggle() } label: {
                            ZStack {
                                Circle().fill(Theme.goldGradient)
                                Image(systemName: player.playing ? "pause.fill" : "play.fill")
                                    .font(.system(size: 24, weight: .bold))
                                    .foregroundStyle(Theme.ink)
                            }
                            .frame(width: 68, height: 68)
                            .shadow(color: Theme.gold.opacity(0.45), radius: 18, y: 6)
                        }
                        Button { player.next() } label: {
                            Image(systemName: "forward.fill").font(.system(size: 20))
                        }
                    }
                    .foregroundStyle(Theme.ivory)
                    .padding(.bottom, 30)
                }

                Spacer(minLength: 0)
            }
            .overlay(alignment: .topTrailing) {
                Button {
                    player.showFullScreen = false
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.ivory.opacity(0.8))
                        .padding(16)
                }
            }
        }
    }

    private func time(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}


