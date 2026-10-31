import SwiftUI

/// Onglet Playlists : création, contenu, lecture.
struct PlaylistsView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var playlists: PlaylistStore
    @State private var newName = ""
    @State private var creating = false

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()

                if playlists.items.isEmpty {
                    empty
                } else {
                    List {
                        ForEach(playlists.items) { playlist in
                            NavigationLink {
                                PlaylistDetailView(playlist: playlist)
                            } label: {
                                HStack(spacing: 12) {
                                    // Vignette : la pochette du premier morceau de la liste.
                                    if let first = playlists.tracks(of: playlist, in: library).first {
                                        ArtworkView(track: first)
                                            .frame(width: 46, height: 46)
                                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                    } else {
                                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                                            .fill(Theme.ink3)
                                            .frame(width: 46, height: 46)
                                            .overlay(Image(systemName: "music.note.list").foregroundStyle(Theme.dim))
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(playlist.name)
                                            .font(.system(size: 14, weight: .medium))
                                            .foregroundStyle(Theme.ivory)
                                            .lineLimit(1)
                                        Text("\(playlist.trackIDs.count) titre\(playlist.trackIDs.count > 1 ? "s" : "")")
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(Theme.dim)
                                    }
                                }
                            }
                            .listRowBackground(Theme.ink2)
                        }
                        .onDelete { offsets in
                            for index in offsets { playlists.delete(playlists.items[index].id) }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Playlists")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Haptics.press()
                        creating = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.accent)
                    }
                }
            }
            .alert("Nouvelle playlist", isPresented: $creating) {
                TextField("Nom", text: $newName)
                Button("Créer") {
                    let created = playlists.create(named: newName)
                    newName = ""
                    _ = created
                }
                Button("Annuler", role: .cancel) { newName = "" }
            } message: {
                Text("Tu pourras y ajouter des morceaux depuis un album ou les favoris.")
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "music.note.list")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.accent)
            Text("Aucune playlist")
                .serifTitle(22)
            Text("Touche + pour en créer une, puis ajoute des morceaux par appui long.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}

/// Contenu d'une playlist : lecture, retrait d'un morceau, suppression de la liste.
struct PlaylistDetailView: View {
    let playlist: Playlist
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var playlists: PlaylistStore
    @Environment(\.dismiss) private var dismiss

    /// Recalculé à chaque rendu : la playlist peut avoir changé (ajout/retrait).
    private var current: Playlist? { playlists.items.first { $0.id == playlist.id } }
    private var tracks: [Track] { current.map { playlists.tracks(of: $0, in: library) } ?? [] }

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            if tracks.isEmpty {
                VStack(spacing: 10) {
                    Text("Playlist vide").serifTitle(20)
                    Text("Ajoute des morceaux par appui long sur un titre.")
                        .font(.footnote)
                        .foregroundStyle(Theme.dim)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Button {
                            Haptics.press()
                            player.play(tracks, startingAt: 0)
                            player.showFullScreen = true
                        } label: {
                            Label("Lire la playlist", systemImage: "play.fill")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Theme.ink)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 9)
                                .background(Capsule().fill(Theme.accentGradient))
                        }
                        .padding(.top, 8)

                        ForEach(Array(tracks.enumerated()), id: \.element.id) { offset, track in
                            TrackRow(
                                track: track,
                                isCurrent: player.current?.id == track.id,
                                isFavorite: false,
                                onPlay: {
                                    player.play(tracks, startingAt: offset)
                                    player.showFullScreen = true
                                },
                                onToggleFavorite: {}
                            )
                            .contextMenu {
                                Button(role: .destructive) {
                                    playlists.remove(track.id, from: playlist.id)
                                } label: {
                                    Label("Retirer de la playlist", systemImage: "minus.circle")
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 40)
                }
            }
        }
        .navigationTitle(current?.name ?? "Playlist")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(role: .destructive) {
                        playlists.delete(playlist.id)
                        dismiss()
                    } label: {
                        Label("Supprimer la playlist", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Theme.accent)
                }
            }
        }
    }
}
