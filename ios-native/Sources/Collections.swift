import Foundation
import SwiftUI

/// Favoris : un ensemble d'identifiants de morceaux, persisté à part de la bibliothèque.
///
/// POURQUOI UN FICHIER SÉPARÉ
/// La bibliothèque est un tableau JSON ; y ajouter des champs aurait obligé à migrer un fichier
/// existant chez l'utilisateur. Un fichier distinct (`favorites.json`) ne casse rien : s'il est
/// absent, on démarre simplement sans favori.
@MainActor
final class FavoritesStore: ObservableObject {
    @Published private(set) var ids: Set<UUID> = []

    private static var url: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("favorites.json")
    }

    init() { load() }

    private func load() {
        guard let data = try? Data(contentsOf: Self.url),
              let list = try? JSONDecoder().decode([UUID].self, from: data) else { return }
        ids = Set(list)
    }

    private func save() {
        if let data = try? JSONEncoder().encode(Array(ids)) {
            try? data.write(to: Self.url, options: .atomic)
        }
    }

    func contains(_ id: UUID) -> Bool { ids.contains(id) }

    func toggle(_ id: UUID) {
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
        save()
    }

    /// Retire les identifiants de morceaux qui n'existent plus (suppression, vidage).
    func prune(keeping tracks: [Track]) {
        let alive = Set(tracks.map(\.id))
        let cleaned = ids.intersection(alive)
        if cleaned != ids {
            ids = cleaned
            save()
        }
    }
}

/// Une playlist : un nom et une suite de morceaux, dans l'ordre voulu.
struct Playlist: Identifiable, Codable, Equatable {
    var id: UUID = UUID()
    var name: String
    var trackIDs: [UUID] = []
    var createdAt: Date = Date()
}

/// Playlists de l'utilisateur, persistées à part.
@MainActor
final class PlaylistStore: ObservableObject {
    @Published private(set) var items: [Playlist] = []

    private static var url: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("playlists.json")
    }

    init() { load() }

    private func load() {
        guard let data = try? Data(contentsOf: Self.url),
              let list = try? JSONDecoder().decode([Playlist].self, from: data) else { return }
        items = list
    }

    private func save() {
        if let data = try? JSONEncoder().encode(items) {
            try? data.write(to: Self.url, options: .atomic)
        }
    }

    @discardableResult
    func create(named name: String, from tracks: [UUID] = []) -> Playlist {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let playlist = Playlist(name: trimmed.isEmpty ? "Nouvelle playlist" : trimmed, trackIDs: tracks)
        items.append(playlist)
        save()
        return playlist
    }

    func add(_ trackID: UUID, to playlistID: UUID) {
        guard let index = items.firstIndex(where: { $0.id == playlistID }) else { return }
        guard !items[index].trackIDs.contains(trackID) else { return }
        items[index].trackIDs.append(trackID)
        save()
    }

    func remove(_ trackID: UUID, from playlistID: UUID) {
        guard let index = items.firstIndex(where: { $0.id == playlistID }) else { return }
        items[index].trackIDs.removeAll { $0 == trackID }
        save()
    }

    func delete(_ playlistID: UUID) {
        items.removeAll { $0.id == playlistID }
        save()
    }

    func rename(_ playlistID: UUID, to name: String) {
        guard let index = items.firstIndex(where: { $0.id == playlistID }) else { return }
        items[index].name = name
        save()
    }

    /// Morceaux réels d'une playlist, dans l'ordre, en ignorant les identifiants disparus.
    func tracks(of playlist: Playlist, in library: Library) -> [Track] {
        playlist.trackIDs.compactMap { id in library.tracks.first { $0.id == id } }
    }

    /// Crée/complète les playlists par genre depuis la liste préparée `smart-playlists.json`
    /// (classement phonk / funk / montagem fait en amont). On associe par l'identifiant PC
    /// (`remoteID`) et on n'ajoute QUE les morceaux réellement présents sur l'appareil.
    /// Renvoie le nombre de morceaux ajoutés.
    @discardableResult
    func buildGenrePlaylists(library: Library) -> Int {
        guard let url = Bundle.main.url(forResource: "smart-playlists", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let map = try? JSONDecoder().decode([String: [Int]].self, from: data) else { return 0 }
        var total = 0
        for (name, remoteIDs) in map {
            let want = Set(remoteIDs)
            let ids = library.tracks.filter { $0.remoteID.map(want.contains) ?? false }.map(\.id)
            guard !ids.isEmpty else { continue }
            if let index = items.firstIndex(where: { $0.name == name }) {
                for id in ids where !items[index].trackIDs.contains(id) {
                    items[index].trackIDs.append(id)
                    total += 1
                }
            } else {
                items.append(Playlist(name: name, trackIDs: ids))
                total += ids.count
            }
        }
        if total > 0 { save() }
        return total
    }

    func prune(keeping tracks: [Track]) {
        let alive = Set(tracks.map(\.id))
        var changed = false
        for index in items.indices {
            let before = items[index].trackIDs.count
            items[index].trackIDs.removeAll { !alive.contains($0) }
            if items[index].trackIDs.count != before { changed = true }
        }
        if changed { save() }
    }
}
