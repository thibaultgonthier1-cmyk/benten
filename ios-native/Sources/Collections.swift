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
    /// Accès par dictionnaire : avant, chaque identifiant était cherché dans toute la bibliothèque
    /// (336 × 1019 comparaisons à chaque rendu de l'onglet Playlists).
    func tracks(of playlist: Playlist, in library: Library) -> [Track] {
        playlist.trackIDs.compactMap { library.byID[$0] }
    }

    static let genrePlaylistName = "Phonk / Funk"

    /// Mots qui signent le genre dans un titre / artiste / album.
    private static let genreKeywords = [
        "phonk", "funk", "montagem", "mtg", "automotivo", "slowed", "sped up", "speed up",
        "drift", "brazil", "brasil", "bailão", "bailao", "tralala", "sigma", "aggressive",
    ]

    /// Artistes phonk / funk connus (classement fait sur la bibliothèque du PC).
    private static let genreArtists = [
        "kordhell", "dvrst", "interworld", "sxmpra", "ghostface playa", "pharmacist", "lxngvx",
        "mythrodak", "h6itam", "eternxlkz", "kaito shoma", "ncts", "hxvrmxn", "dj fku",
        "kxllswxtch", "phonkha", "sayfalse", "slowboy", "kslv", "freddie dredd", "playaphonk",
        "akiaura", "lufer", "vøj", "narvent", "scythermane", "mc gw", "mc pedrinho", "dj ronaldo",
        "flame runner", "ariis", "irokz", "zxkai", "brodex", "dj zk3", "dj xavier", "crxsade",
        "4mal", "trxshbxy", "nxght", "dxrk", "noixes", "sleepwalker", "plvtinum", "vxlious",
    ]

    /// Un morceau est-il du phonk / funk ? Liste préparée sur le PC OU signes dans ses métadonnées.
    static func isGenreTrack(_ track: Track, prepared: Set<Int>) -> Bool {
        if let remote = track.remoteID, prepared.contains(remote) { return true }
        let text = "\(track.title) \(track.artist) \(track.album)".lowercased()
        if genreKeywords.contains(where: { text.contains($0) }) { return true }
        let artist = track.artist.lowercased()
        return genreArtists.contains(where: { artist.contains($0) })
    }

    static let preparedGenreIDs: Set<Int> = {
        guard let url = Bundle.main.url(forResource: "smart-playlists", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let map = try? JSONDecoder().decode([String: [Int]].self, from: data) else { return [] }
        return Set(map.values.flatMap { $0 })
    }()

    /// Crée / complète AUTOMATIQUEMENT la playlist « Phonk / Funk » avec tous les morceaux du genre
    /// présents sur l'iPhone. Appelée au lancement et à chaque changement de bibliothèque (synchro,
    /// import) : la playlist se tient à jour toute seule. N'enlève jamais un titre ajouté à la main.
    /// Renvoie le nombre de morceaux ajoutés.
    @discardableResult
    func buildGenrePlaylists(library: Library) -> Int {
        let prepared = Self.preparedGenreIDs
        let ids = library.tracks.filter { Self.isGenreTrack($0, prepared: prepared) }.map(\.id)
        guard !ids.isEmpty else { return 0 }
        var added = 0
        if let index = items.firstIndex(where: { $0.name == Self.genrePlaylistName }) {
            let existing = Set(items[index].trackIDs)
            // Ajouts groupés : UNE publication (avant : une par morceau ajouté).
            let missing = ids.filter { !existing.contains($0) }
            if !missing.isEmpty {
                items[index].trackIDs.append(contentsOf: missing)
                added = missing.count
            }
        } else {
            items.insert(Playlist(name: Self.genrePlaylistName, trackIDs: ids), at: 0)
            added = ids.count
        }
        if added > 0 { save() }
        return added
    }

    func prune(keeping tracks: [Track]) {
        let alive = Set(tracks.map(\.id))
        // Travail sur une COPIE, publiée une seule fois et seulement si quelque chose a changé.
        // Avant, chaque `items[index]…` modifiait le tableau publié : une notification par
        // playlist à chaque lancement / synchro, même sans aucun changement — et autant de
        // recalculs des onglets qui l'observent.
        var updated = items
        var changed = false
        for index in updated.indices {
            let before = updated[index].trackIDs.count
            updated[index].trackIDs.removeAll { !alive.contains($0) }
            if updated[index].trackIDs.count != before { changed = true }
        }
        if changed {
            items = updated
            save()
        }
    }
}
