import SwiftUI

/// Onglet Favoris : les morceaux marqués d'un cœur, prêts à être lus.
struct FavoritesView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var favorites: FavoritesStore

    private var tracks: [Track] {
        library.tracks.filter { favorites.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()

                if tracks.isEmpty {
                    empty
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            header
                            ForEach(Array(tracks.enumerated()), id: \.element.id) { offset, track in
                                TrackRow(
                                    track: track,
                                    isCurrent: player.current?.id == track.id,
                                    isFavorite: true,
                                    onPlay: {
                                        player.play(tracks, startingAt: offset)
                                        player.showFullScreen = true
                                    },
                                    onToggleFavorite: { favorites.toggle(track.id) }
                                )
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 96)
                    }
                }
            }
            .navigationTitle("Favoris")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.ink, for: .navigationBar)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("♥ · tes morceaux")
                .font(.system(size: 11, weight: .medium))
                .tracking(2.0)
                .foregroundStyle(Theme.accent.opacity(0.75))
            Text("Favoris")
                .serifTitle(28)
            Button {
                Haptics.press()
                player.play(tracks, startingAt: 0)
                player.showFullScreen = true
            } label: {
                Label("Tout lire", systemImage: "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(Theme.accentGradient))
            }
            .padding(.top, 2)
        }
        .padding(.top, 10)
        .padding(.bottom, 6)
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "heart")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.accent)
            Text("Aucun favori")
                .serifTitle(22)
            Text("Touche le cœur dans la vue lecture ou dans un album.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}

/// Une ligne de morceau, réutilisable (favoris, playlists, albums).
struct TrackRow: View {
    let track: Track
    let isCurrent: Bool
    let isFavorite: Bool
    let onPlay: () -> Void
    let onToggleFavorite: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onPlay) {
                HStack(spacing: 12) {
                    ArtworkView(track: track)
                        .frame(width: 46, height: 46)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(isCurrent ? Theme.accent : Theme.ivory)
                            .lineLimit(1)
                        Text("\(track.artist) · \(TimeFormatting.short(track.duration))")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Theme.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                Haptics.choose()
                onToggleFavorite()
            } label: {
                Image(systemName: isFavorite ? "heart.fill" : "heart")
                    .font(.system(size: 17))
                    .foregroundStyle(isFavorite ? Theme.accent : Theme.dim)
                    .padding(8)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }
}
