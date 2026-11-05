import SwiftUI

/// Onglet Favoris : les morceaux marqués d'un cœur, prêts à être lus.
struct FavoritesView: View {
    // Pas d'abonnement au lecteur : l'onglet ne se recalcule plus à chaque play/pause.
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var favorites: FavoritesStore
    @State private var deletion: DeletionRequest?

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                let tracks = library.tracks.filter { favorites.contains($0.id) }.reversed().map { $0 }

                if tracks.isEmpty {
                    empty
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            header(tracks)
                            ForEach(tracks) { track in
                                TrackRow(
                                    track: track,
                                    isFavorite: true,
                                    onPlay: { NowPlayingState.shared.play(tracks, from: track) },
                                    onToggleFavorite: {
                                        withAnimation(Motion.spring) { favorites.toggle(track.id) }
                                    }
                                )
                                .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .leading).combined(with: .opacity)))
                                .contextMenu {
                                    DeleteFromDeviceButton { deletion = DeletionRequest(track: track) }
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 20)
                    }
                }
            }
            .swipeBackEverywhere()
            .navigationTitle("Favoris")
            .navigationBarTitleDisplayMode(.large)
            .deletionConfirmation($deletion)
            .toolbarBackground(Theme.ink, for: .navigationBar)
        }
    }

    private func header(_ tracks: [Track]) -> some View {
        HStack(spacing: 10) {
            Button {
                Haptics.press()
                NowPlayingState.shared.play(tracks, startingAt: 0)
            } label: {
                Label("Lecture", systemImage: "play.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.08)))
            }
            .buttonStyle(PressableStyle())
            Button {
                Haptics.press()
                NowPlayingState.shared.playShuffled(tracks)
            } label: {
                Label("Aléatoire", systemImage: "shuffle")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.08)))
            }
            .buttonStyle(PressableStyle())
        }
        .padding(.vertical, 10)
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "heart")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.accent)
                .symbolEffect(.pulse)
            Text("Aucun favori")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Theme.ivory)
            Text("Touche le cœur dans la vue lecture pour retrouver tes morceaux ici.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}

/// Une ligne de morceau, réutilisable (favoris, playlists, recherche, titres).
///
/// Le morceau en cours affiche des barres animées à la place de la pochette, comme Apple Music.
///
/// La ligne lit ELLE-MÊME « en cours » (`NowPlayingState`) : quand le morceau change, seules les
/// deux lignes concernées (l'ancienne et la nouvelle) se redessinent — plus la liste entière.
struct TrackRow: View {
    let track: Track
    /// `nil` : pas de bouton cœur.
    var isFavorite: Bool? = nil
    let onPlay: () -> Void
    var onToggleFavorite: () -> Void = {}

    var body: some View {
        let isCurrent = NowPlayingState.shared.currentID == track.id
        HStack(spacing: 12) {
            Button {
                Haptics.tap()
                onPlay()
            } label: {
                HStack(spacing: 12) {
                    ZStack {
                        ArtworkView(track: track, maxPixel: 180)
                            .frame(width: 48, height: 48)
                            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        if isCurrent {
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(Color.black.opacity(0.45))
                                .frame(width: 48, height: 48)
                            LiveNowPlayingBars()
                                .frame(width: 18, height: 16)
                        }
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(track.title)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(isCurrent ? Theme.accent : Theme.ivory)
                            .lineLimit(1)
                        Text(track.artist)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                }
                .padding(.vertical, 5)
                .frame(height: 58)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(scale: 0.98))

            if let isFavorite {
                Button {
                    Haptics.choose()
                    onToggleFavorite()
                } label: {
                    Image(systemName: isFavorite ? "heart.fill" : "heart")
                        .font(.system(size: 17))
                        .foregroundStyle(isFavorite ? Theme.accent : Theme.dim)
                        .symbolEffect(.bounce, value: isFavorite)
                        .padding(8)
                }
                .buttonStyle(PressableStyle(scale: 0.8))
            }
        }
    }
}

/// Barres d'égaliseur animées « en lecture » (comme Apple Music). Figées en pause.
struct NowPlayingBars: View {
    let animating: Bool
    var color: Color = .white

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: !animating)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(0..<4, id: \.self) { index in
                    let phase = time * (5.5 + Double(index) * 1.7) + Double(index) * 1.3
                    let level = animating ? 0.3 + 0.7 * abs(sin(phase)) : 0.3
                    Capsule()
                        .fill(color)
                        .frame(height: max(2, CGFloat(level) * 16))
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
    }
}
