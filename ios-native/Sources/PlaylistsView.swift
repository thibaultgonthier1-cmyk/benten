import SwiftUI

/// Onglet Playlists : création, contenu, lecture. « Phonk / Funk » se remplit toute seule.
struct PlaylistsView: View {
    // Pas d'abonnement au lecteur (voir `NowPlayingState`).
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var playlists: PlaylistStore
    @State private var newName = ""
    @State private var creating = false
    @State private var deletion: DeletionRequest?
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                AnimatedBackdrop()

                if playlists.items.isEmpty {
                    empty
                } else {
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(playlists.items) { playlist in
                                NavigationLink(value: playlist.id) {
                                    PlaylistRow(
                                        playlist: playlist,
                                        tracks: playlists.tracks(of: playlist, in: library),
                                        isAuto: playlist.name == PlaylistStore.genrePlaylistName
                                    )
                                }
                                .buttonStyle(PressableStyle(scale: 0.98))
                                .contextMenu {
                                    Button {
                                        NowPlayingState.shared.play(playlists.tracks(of: playlist, in: library), startingAt: 0)
                                    } label: { Label("Lire", systemImage: "play.fill") }
                                    Button {
                                        NowPlayingState.shared.playShuffled(playlists.tracks(of: playlist, in: library))
                                    } label: { Label("Aléatoire", systemImage: "shuffle") }
                                    Button(role: .destructive) {
                                        withAnimation(Motion.spring) { playlists.delete(playlist.id) }
                                    } label: { Label("Supprimer la playlist", systemImage: "minus.circle") }
                                    DeleteFromDeviceButton("Supprimer ses morceaux de l'iPhone") {
                                        deletion = DeletionRequest(tracks: playlists.tracks(of: playlist, in: library), name: playlist.name)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                    }
                }
            }
            .swipeBackEverywhere()
            .navigationTitle("Playlists")
            .navigationBarTitleDisplayMode(.large)
            .deletionConfirmation($deletion)
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .navigationDestination(for: UUID.self) { id in
                PlaylistDetailView(playlistID: id)
            }
            #if DEBUG
            .task(id: playlists.items.count) {
                if DemoMode.value("demoScreen") == "playlist", path.isEmpty,
                   let demo = playlists.items.first(where: { $0.name == "Test mosaïque" }) {
                    path.append(demo.id)
                }
            }
            #endif
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Haptics.press()
                        creating = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.accent)
                            .symbolRenderingMode(.hierarchical)
                    }
                }
            }
            .alert("Nouvelle playlist", isPresented: $creating) {
                TextField("Nom", text: $newName)
                Button("Créer") {
                    withAnimation(Motion.spring) { _ = playlists.create(named: newName) }
                    newName = ""
                }
                Button("Annuler", role: .cancel) { newName = "" }
            } message: {
                Text("Ajoute ensuite des morceaux depuis la vue lecture (bouton …).")
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "music.note.list")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.accent)
                .symbolEffect(.pulse)
            Text("Aucune playlist")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Theme.ivory)
            Text("Touche + pour en créer une. « Phonk / Funk » apparaîtra toute seule dès que tu as des morceaux du genre.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}

private struct PlaylistRow: View {
    let playlist: Playlist
    let tracks: [Track]
    let isAuto: Bool

    var body: some View {
        HStack(spacing: 14) {
            PlaylistMosaicView(tracks: tracks, cornerRadius: 10)
                .frame(width: 64, height: 64)
                .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(playlist.name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .lineLimit(1)
                    if isAuto {
                        Image(systemName: "sparkles")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                    }
                }
                Text("\(isAuto ? "Automatique · " : "")\(tracks.count) titre\(tracks.count > 1 ? "s" : "")")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.dim)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.dim.opacity(0.7))
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

/// Contenu d'une playlist : en-tête mosaïque, Lecture / Aléatoire, morceaux.
struct PlaylistDetailView: View {
    let playlistID: UUID
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var playlists: PlaylistStore
    @Environment(\.dismiss) private var dismiss
    @State private var deletion: DeletionRequest?
    /// Après « supprimer la playlist ET ses morceaux », on supprime aussi la playlist.
    @State private var deletePlaylistAfter = false

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            if let playlist = playlists.items.first(where: { $0.id == playlistID }) {
                let tracks = playlists.tracks(of: playlist, in: library)
                ScrollView {
                    LazyVStack(spacing: 2) {
                        VStack(spacing: 14) {
                            PlaylistMosaicView(tracks: tracks, cornerRadius: 14, maxPixel: 560)
                                .frame(width: 230, height: 230)
                                .holographic()
                                .shadow(color: .black.opacity(0.5), radius: 22, y: 12)
                                .padding(.top, 8)
                            VStack(spacing: 4) {
                                Text(playlist.name)
                                    .font(.system(size: 22, weight: .bold))
                                    .foregroundStyle(Theme.ivory)
                                Text("\(tracks.count) titre\(tracks.count > 1 ? "s" : "")")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.dim)
                            }
                            HStack(spacing: 10) {
                                bigButton("Lecture", icon: "play.fill") { NowPlayingState.shared.play(tracks, startingAt: 0) }
                                bigButton("Aléatoire", icon: "shuffle") { NowPlayingState.shared.playShuffled(tracks) }
                            }
                            .disabled(tracks.isEmpty)
                        }
                        .padding(.bottom, 12)

                        if tracks.isEmpty {
                            Text("Playlist vide. Ajoute des morceaux depuis la vue lecture (bouton …).")
                                .font(.footnote)
                                .foregroundStyle(Theme.dim)
                                .multilineTextAlignment(.center)
                                .padding(.top, 20)
                        }

                        ForEach(tracks) { track in
                            TrackRow(track: track, onPlay: { NowPlayingState.shared.play(tracks, from: track) })
                                .contextMenu {
                                    Button {
                                        withAnimation(Motion.spring) { playlists.remove(track.id, from: playlist.id) }
                                    } label: {
                                        Label("Retirer de la playlist", systemImage: "minus.circle")
                                    }
                                    DeleteFromDeviceButton {
                                        deletePlaylistAfter = false
                                        deletion = DeletionRequest(track: track)
                                    }
                                }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 24)
                }
            } else {
                Text("Playlist introuvable").foregroundStyle(Theme.dim)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .deletionConfirmation($deletion) {
            if deletePlaylistAfter {
                deletePlaylistAfter = false
                playlists.delete(playlistID)
                dismiss()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let playlist = playlists.items.first(where: { $0.id == playlistID }) {
                        let tracks = playlists.tracks(of: playlist, in: library)
                        Section("Libérer de la place") {
                            DeleteFromDeviceButton("Supprimer ses \(tracks.count) morceaux de l'iPhone") {
                                deletePlaylistAfter = false
                                deletion = DeletionRequest(tracks: tracks, name: playlist.name)
                            }
                            .disabled(tracks.isEmpty)
                            DeleteFromDeviceButton("Supprimer la playlist ET ses morceaux") {
                                deletePlaylistAfter = true
                                deletion = DeletionRequest(tracks: tracks, name: playlist.name)
                            }
                            .disabled(tracks.isEmpty)
                        }
                    }
                    Button(role: .destructive) {
                        playlists.delete(playlistID)
                        dismiss()
                    } label: {
                        Label("Supprimer la playlist (garder les morceaux)", systemImage: "minus.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Theme.accent)
                }
            }
        }
    }

    private func bigButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
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
