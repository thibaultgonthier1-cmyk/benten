import SwiftUI
import UniformTypeIdentifiers

/// Bibliothèque : grille de pochettes, comme l'onglet d'accueil d'une app de musique.
struct LibraryView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @State private var showImporter = false

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 14)]

    var body: some View {
        NavigationStack {
            Group {
                if library.tracks.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 18) {
                            ForEach(Array(library.tracks.enumerated()), id: \.element.id) { offset, track in
                                Button {
                                    player.play(library.tracks, startingAt: offset)
                                    player.showFullScreen = true
                                } label: {
                                    trackCell(track)
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button(role: .destructive) {
                                        library.delete(track)
                                    } label: {
                                        Label("Supprimer", systemImage: "trash")
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 90)
                    }
                }
            }
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("Bibliothèque")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showImporter = true
                    } label: {
                        Label("Importer", systemImage: "plus.circle.fill")
                    }
                }
            }
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

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "music.note.house")
                .font(.system(size: 46))
                .foregroundStyle(Palette.gold)
            Text("Aucune musique")
                .font(.title3.weight(.medium))
            Text("Touche + pour choisir des fichiers dans Fichiers ou iCloud.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func trackCell(_ track: Track) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ArtworkView(track: track)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06))
                )
            Text(track.title)
                .font(.callout.weight(.medium))
                .lineLimit(1)
            Text(track.artist)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

/// Pochette : image extraite du fichier, ou repli dessiné (dégradé stable par titre).
struct ArtworkView: View {
    let track: Track

    var body: some View {
        ZStack {
            if let url = track.artworkURL, let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                LinearGradient(
                    colors: [Palette.goldLight.opacity(0.85), Palette.gold.opacity(0.55)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .overlay(
                    Image(systemName: "music.note")
                        .font(.system(size: 26, weight: .light))
                        .foregroundStyle(Palette.ink.opacity(0.65))
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
                    .frame(width: 42, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 1) {
                    Text(track.title).font(.callout).lineLimit(1)
                    Text(track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }

                Spacer()

                Button { player.toggle() } label: {
                    Image(systemName: player.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 20))
                }
                Button { player.next() } label: {
                    Image(systemName: "forward.fill").font(.system(size: 16))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
            .onTapGesture { player.showFullScreen = true }
        }
    }
}

/// Vue plein écran : grande pochette, disque, progression, transport.
struct NowPlayingView: View {
    @EnvironmentObject private var player: Player

    var body: some View {
        ZStack {
            LinearGradient(colors: [Palette.ink, .black], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 22) {
                Capsule()
                    .fill(Color.white.opacity(0.25))
                    .frame(width: 36, height: 5)
                    .padding(.top, 8)

                Spacer(minLength: 8)

                if let track = player.current {
                    ZStack {
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [Color(white: 0.12), .black],
                                    center: .center,
                                    startRadius: 20,
                                    endRadius: 220
                                )
                            )
                            .frame(width: min(UIScreen.main.bounds.width * 0.82, 340))

                        ArtworkView(track: track)
                            .frame(width: min(UIScreen.main.bounds.width * 0.58, 240))
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .shadow(color: .black.opacity(0.6), radius: 24, y: 12)
                    }

                    VStack(spacing: 4) {
                        Text(track.title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                        Text(track.artist).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 28)

                    VStack(spacing: 6) {
                        Slider(
                            value: Binding(
                                get: { player.position },
                                set: { player.seek(to: $0) }
                            ),
                            in: 0...max(1, player.duration)
                        )
                        .tint(Palette.gold)

                        HStack {
                            Text(time(player.position))
                            Spacer()
                            Text(time(player.duration))
                        }
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 28)

                    HStack(spacing: 34) {
                        Button { player.previous() } label: {
                            Image(systemName: "backward.fill").font(.system(size: 22))
                        }
                        Button { player.toggle() } label: {
                            Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                                .font(.system(size: 64))
                                .foregroundStyle(Palette.gold)
                        }
                        Button { player.next() } label: {
                            Image(systemName: "forward.fill").font(.system(size: 22))
                        }
                    }
                    .foregroundStyle(Palette.ivory)
                    .padding(.bottom, 26)
                }

                Spacer(minLength: 0)
            }
            .overlay(alignment: .topTrailing) {
                Button {
                    player.showFullScreen = false
                } label: {
                    Image(systemName: "chevron.down").font(.system(size: 18, weight: .semibold))
                        .padding(14)
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
