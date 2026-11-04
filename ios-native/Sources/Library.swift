import AVFoundation
import Foundation
import SwiftUI

/// Un morceau de la bibliothèque locale.
///
/// Les fichiers sont COPIES dans le dossier Documents de l'app : après import, ils vivent sur le
/// téléphone et se lisent hors-ligne, sans PC.
struct Track: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var title: String
    var artist: String
    var album: String
    var fileName: String        // nom du fichier dans Documents/Audio
    var artworkName: String?    // nom du PNG dans Documents/Artwork
    var duration: Double
    var addedAt: Date
    /// Identifiant du morceau sur le PC (nil pour un import local) : évite de récupérer deux fois
    /// le même titre.
    var remoteID: Int?

    var fileURL: URL { Library.audioDirectory.appendingPathComponent(fileName) }
    var artworkURL: URL? {
        guard let artworkName else { return nil }
        return Library.artworkDirectory.appendingPathComponent(artworkName)
    }
}

/// Bibliothèque : import depuis Fichiers / iCloud, récupération depuis le PC, métadonnées,
/// pochettes, persistance.
@MainActor
final class Library: ObservableObject {
    static let audioDirectory = documents.appendingPathComponent("Audio", isDirectory: true)
    static let artworkDirectory = documents.appendingPathComponent("Artwork", isDirectory: true)
    private static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    private static var indexURL: URL { documents.appendingPathComponent("library.json") }

    @Published private(set) var tracks: [Track] = [] {
        didSet { tracksChanged() }
    }
    @Published private(set) var importing = false
    @Published var lastError: String?
    private var saveTask: Task<Void, Never>?

    // Vues dérivées, calculées UNE fois par changement de la bibliothèque, hors du fil principal.
    // Avant, albums / artistes / titres étaient re-groupés et re-triés à CHAQUE rendu de l'écran
    // (donc à chaque play, pause, ouverture du lecteur…) : ~1000 morceaux triés en boucle.
    @Published private(set) var albums: [AlbumGroup] = []
    @Published private(set) var artists: [ArtistGroup] = []
    @Published private(set) var tracksByTitle: [Track] = []
    /// Accès direct par identifiant (playlists, favoris) au lieu d'une recherche linéaire.
    private(set) var byID: [UUID: Track] = [:]
    private var remoteIDs: Set<Int> = []
    private var derivedTask: Task<Void, Never>?

    init() {
        createDirectories()
        load()
    }

    private func refreshIndexes() {
        byID = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        remoteIDs = Set(tracks.compactMap(\.remoteID))
    }

    private func tracksChanged() {
        refreshIndexes()
        derivedTask?.cancel()
        let snapshot = tracks
        derivedTask = Task { [weak self] in
            // Regroupe les rafales (synchro de 1000 titres) : un seul calcul après la dernière.
            try? await Task.sleep(nanoseconds: 180_000_000)
            if Task.isCancelled { return }
            let derived = await Task.detached(priority: .userInitiated) { Library.derive(snapshot) }.value
            guard let self, !Task.isCancelled else { return }
            self.apply(derived)
        }
    }

    private func apply(_ derived: Derived) {
        albums = derived.albums
        artists = derived.artists
        tracksByTitle = derived.byTitle
    }

    struct Derived: Sendable {
        let albums: [AlbumGroup]
        let artists: [ArtistGroup]
        let byTitle: [Track]
    }

    /// Calcule albums, artistes et titres triés. Fonction pure, appelée hors du fil principal.
    nonisolated static func derive(_ tracks: [Track]) -> Derived {
        var buckets: [String: [Track]] = [:]
        for track in tracks {
            buckets["\(track.album)||\(track.artist)", default: []].append(track)
        }
        let albums: [AlbumGroup] = buckets.map { key, list in
            let sorted = list.sorted { $0.addedAt < $1.addedAt }
            let reference = sorted.first(where: { $0.artworkName != nil }) ?? sorted[0]
            return AlbumGroup(id: key, title: sorted[0].album, artist: sorted[0].artist, artworkTrack: reference, tracks: sorted)
        }
        .sorted { ($0.tracks.last?.addedAt ?? .distantPast) > ($1.tracks.last?.addedAt ?? .distantPast) }

        var byArtist: [String: [AlbumGroup]] = [:]
        for album in albums { byArtist[album.artist, default: []].append(album) }
        let artists: [ArtistGroup] = byArtist.map { name, list in
            let reference = list.first(where: { $0.artworkTrack.artworkName != nil })?.artworkTrack ?? list[0].artworkTrack
            return ArtistGroup(id: name, name: name, artworkTrack: reference, albums: list)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        let byTitle = tracks.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        return Derived(albums: albums, artists: artists, byTitle: byTitle)
    }

    private func createDirectories() {
        for directory in [Self.audioDirectory, Self.artworkDirectory] {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    // MARK: - Persistance

    private func load() {
        guard let data = try? Data(contentsOf: Self.indexURL) else { return }
        let loaded = ((try? JSONDecoder().decode([Track].self, from: data)) ?? []).sorted { $0.addedAt < $1.addedAt }
        tracks = loaded
        // Au lancement, on calcule tout de suite : la grille s'affiche pleine dès la 1re image.
        refreshIndexes()
        derivedTask?.cancel()
        apply(Self.derive(loaded))
    }

    /// Sauvegarde l'index — HORS du fil principal et REGROUPÉE : pendant une synchro de 1000
    /// morceaux, au lieu d'encoder+écrire à chaque titre (ce qui saccade), on attend 0,6 s après
    /// le dernier changement. Encodage et écriture se font sur un fil de fond.
    private func save() {
        saveTask?.cancel()
        let snapshot = tracks
        let url = Self.indexURL
        saveTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            guard let data = try? encoder.encode(snapshot) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    // MARK: - Import depuis Fichiers / iCloud

    /// Importe des fichiers choisis dans Fichiers / iCloud.
    func importFiles(_ urls: [URL]) async {
        importing = true
        defer { importing = false }

        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            let identifier = UUID()
            // On GARDE l'extension d'origine : AVFoundation s'en sert pour choisir le décodeur.
            let ext = url.pathExtension.isEmpty ? "m4a" : url.pathExtension
            let fileName = "\(identifier.uuidString).\(ext)"
            let destination = Self.audioDirectory.appendingPathComponent(fileName)

            do {
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.copyItem(at: url, to: destination)
            } catch {
                lastError = "copie impossible : \(error.localizedDescription)"
                continue
            }

            await register(
                fileName: fileName,
                identifier: identifier,
                remoteID: nil,
                fallbackTitle: url.deletingPathExtension().lastPathComponent
            )
        }
    }

    // MARK: - Récupération depuis le PC

    /// Adopte un fichier téléchargé depuis le PC.
    ///
    /// Le flux ne porte pas de nom : on écrit un fichier temporaire, on laisse AVFoundation
    /// identifier le format réel, puis on renomme avec la bonne extension.
    @discardableResult
    func adopt(data: Data, remote: Int, fallbackTitle: String, fallbackArtist: String) async -> UUID? {
        guard !remoteIDs.contains(remote) else { return nil }
        let identifier = UUID()
        let temporary = Self.audioDirectory.appendingPathComponent("\(identifier.uuidString).incoming")
        do {
            // Écriture du fichier audio (plusieurs Mo) HORS du fil principal → pas de saccade.
            try await Task.detached(priority: .utility) { try data.write(to: temporary, options: .atomic) }.value
        } catch {
            lastError = "écriture impossible : \(error.localizedDescription)"
            return nil
        }

        let ext = await Self.detectExtension(at: temporary)
        let fileName = "\(identifier.uuidString).\(ext)"
        let destination = Self.audioDirectory.appendingPathComponent(fileName)
        try? FileManager.default.moveItem(at: temporary, to: destination)

        await register(
            fileName: fileName,
            identifier: identifier,
            remoteID: remote,
            fallbackTitle: fallbackTitle,
            fallbackArtist: fallbackArtist
        )
        return identifier
    }

    /// Pose la pochette venue du PC sur un morceau déjà importé.
    ///
    /// Le PC garde ses pochettes dans un cache séparé (`art-cache`), pas dans les fichiers audio :
    /// sans cette étape, un morceau synchronisé affichait une tuile vide alors que le PC montre une
    /// pochette. On écrit le PNG à côté, sous le même identifiant que le morceau.
    func attachArtwork(trackID: UUID, data: Data) async {
        guard tracks.contains(where: { $0.id == trackID }) else { return }
        let name = "\(trackID.uuidString).png"
        let url = Self.artworkDirectory.appendingPathComponent(name)
        // Décodage + ré-encodage PNG + écriture HORS du fil principal (sinon saccade à la synchro).
        let ok = await Task.detached(priority: .utility) { () -> Bool in
            guard let image = UIImage(data: data), let png = image.pngData() else { return false }
            do { try png.write(to: url, options: .atomic); return true } catch { return false }
        }.value
        guard ok, let index = tracks.firstIndex(where: { $0.id == trackID }) else { return }
        tracks[index].artworkName = name
        // On oublie SEULEMENT cette pochette. Avant, tout le cache était vidé à chaque pochette
        // reçue : pendant une synchro, toutes les tuiles se rechargeaient en boucle (saccades).
        ArtworkCache.shared.forget(fileName: name)
        save()
    }

    /// Devine l'extension à partir du type réel du flux (mp3, m4a, flac…).
    private static func detectExtension(at url: URL) async -> String {
        let asset = AVURLAsset(url: url)
        guard let tracks = try? await asset.load(.tracks), let track = tracks.first,
              let formats = try? await track.load(.formatDescriptions),
              let format = formats.first
        else { return "m4a" }
        // Comparaison sur la valeur brute : mediaSubType est un MediaSubType, pas un AudioFormatID.
        switch format.mediaSubType.rawValue {
        case kAudioFormatMPEGLayer3: return "mp3"
        case kAudioFormatMPEG4AAC, kAudioFormatMPEG4AAC_HE, kAudioFormatAppleLossless: return "m4a"
        case kAudioFormatFLAC: return "flac"
        case kAudioFormatOpus: return "opus"
        default: return "m4a"
        }
    }

    /// Enregistre un fichier déjà présent dans Documents/Audio : métadonnées, pochette, index.
    private func register(
        fileName: String,
        identifier: UUID,
        remoteID: Int?,
        fallbackTitle: String,
        fallbackArtist: String = "Artiste inconnu"
    ) async {
        let url = Self.audioDirectory.appendingPathComponent(fileName)
        let asset = AVURLAsset(url: url)
        let seconds = (try? await asset.load(.duration)).map { CMTimeGetSeconds($0) } ?? 0
        let metadata = await Self.readMetadata(asset: asset)
        let artworkName = await Self.extractArtwork(asset: asset, identifier: identifier)

        tracks.append(
            Track(
                id: identifier,
                title: metadata.title ?? fallbackTitle,
                artist: metadata.artist ?? fallbackArtist,
                album: metadata.album ?? "Album inconnu",
                fileName: fileName,
                artworkName: artworkName,
                duration: seconds.isFinite ? max(0, seconds) : 0,
                addedAt: Date(),
                remoteID: remoteID
            )
        )
        save()
    }

    private struct Metadata {
        var title: String?
        var artist: String?
        var album: String?
    }

    private static func readMetadata(asset: AVURLAsset) async -> Metadata {
        var result = Metadata()
        guard let items = try? await asset.load(.commonMetadata) else { return result }
        for item in items {
            guard let key = item.commonKey else { continue }
            let value = try? await item.load(.stringValue)
            switch key {
            case .commonKeyTitle: result.title = value
            case .commonKeyArtist: result.artist = value
            case .commonKeyAlbumName: result.album = value
            default: break
            }
        }
        return result
    }

    /// Extrait la pochette embarquée et l'écrit en PNG. Renvoie `nil` s'il n'y en a pas.
    private static func extractArtwork(asset: AVURLAsset, identifier: UUID) async -> String? {
        guard let items = try? await asset.load(.commonMetadata) else { return nil }
        for item in items where item.commonKey == .commonKeyArtwork {
            guard
                let data = try? await item.load(.dataValue),
                let image = UIImage(data: data),
                let png = image.pngData()
            else { continue }
            let name = "\(identifier.uuidString).png"
            let url = artworkDirectory.appendingPathComponent(name)
            try? png.write(to: url, options: .atomic)
            return name
        }
        return nil
    }

    // MARK: - Suppression

    func delete(_ track: Track) {
        try? FileManager.default.removeItem(at: track.fileURL)
        if let artwork = track.artworkURL { try? FileManager.default.removeItem(at: artwork) }
        tracks.removeAll { $0.id == track.id }
        save()
    }

    func deleteAll() {
        for track in tracks {
            try? FileManager.default.removeItem(at: track.fileURL)
            if let artwork = track.artworkURL { try? FileManager.default.removeItem(at: artwork) }
        }
        tracks.removeAll()
        ArtworkCache.shared.invalidate()
        save()
    }

    func track(withID id: UUID) -> Track? { byID[id] }

    // MARK: - Regroupements

    /// Un album de la bibliothèque, avec sa pochette de référence et ses morceaux.
    struct AlbumGroup: Identifiable, Sendable {
        let id: String
        let title: String
        let artist: String
        let artworkTrack: Track
        let tracks: [Track]
    }

    /// Un artiste, avec ses albums et sa pochette de référence.
    struct ArtistGroup: Identifiable, Sendable {
        let id: String
        let name: String
        let artworkTrack: Track
        let albums: [AlbumGroup]
        var trackCount: Int { albums.reduce(0) { $0 + $1.tracks.count } }
    }
}




