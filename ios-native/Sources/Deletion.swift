import SwiftUI

/// Suppression de morceaux de l'iPhone (fichiers effacés, place libérée).
///
/// Le lecteur est prévenu AVANT : si le morceau en cours est supprimé, il passe proprement au
/// suivant. Favoris et playlists se nettoient ensuite tout seuls.
@MainActor
enum TrackDeletion {
    static func delete(_ ids: Set<UUID>, library: Library, player: Player?) {
        guard !ids.isEmpty else { return }
        Haptics.press()
        player?.removeTracks(ids)
        withAnimation(Motion.spring) { library.delete(ids: ids) }
    }
}

/// Une demande de suppression en attente de confirmation.
struct DeletionRequest: Identifiable {
    let id = UUID()
    let ids: Set<UUID>
    let title: String

    init(ids: Set<UUID>, title: String) {
        self.ids = ids
        self.title = title
    }

    init(track: Track) {
        self.init(ids: [track.id], title: "Supprimer « \(track.title) » de l'iPhone ?")
    }

    init(tracks: [Track], name: String) {
        let count = Set(tracks.map(\.id)).count
        self.init(
            ids: Set(tracks.map(\.id)),
            title: "Supprimer \(count) morceau\(count > 1 ? "x" : "") de « \(name) » de l'iPhone ?"
        )
    }
}

/// Feuille de confirmation : rappelle la place libérée et ce qui sera touché.
struct DeletionConfirmation: ViewModifier {
    @Binding var request: DeletionRequest?
    var onDone: () -> Void
    // Pas d'abonnement au lecteur : ce modificateur est posé sur chaque page ; il était
    // réévalué à chaque changement du lecteur. Le lecteur n'est lu qu'au moment de supprimer.
    @EnvironmentObject private var library: Library

    func body(content: Content) -> some View {
        content.confirmationDialog(
            request?.title ?? "",
            isPresented: Binding(get: { request != nil }, set: { if !$0 { request = nil } }),
            titleVisibility: .visible,
            presenting: request
        ) { pending in
            Button("Supprimer de l'iPhone", role: .destructive) {
                TrackDeletion.delete(pending.ids, library: library, player: NowPlayingState.shared.player)
                request = nil
                onDone()
            }
            Button("Annuler", role: .cancel) { request = nil }
        } message: { pending in
            let size = ByteCountFormatter.string(fromByteCount: library.size(of: pending.ids), countStyle: .file)
            Text("\(size) libérés. Ils disparaîtront aussi de tes playlists et de tes favoris. Tu pourras toujours les récupérer depuis le PC.")
        }
    }
}

extension View {
    func deletionConfirmation(_ request: Binding<DeletionRequest?>, onDone: @escaping () -> Void = {}) -> some View {
        modifier(DeletionConfirmation(request: request, onDone: onDone))
    }
}

/// Entrée de menu « Supprimer de l'iPhone », réutilisable dans tous les menus contextuels.
struct DeleteFromDeviceButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String = "Supprimer de l'iPhone", action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(role: .destructive, action: action) {
            Label(title, systemImage: "trash")
        }
    }
}
