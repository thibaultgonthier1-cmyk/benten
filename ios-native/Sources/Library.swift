import AVFoundation
import Foundation
import SwiftUI

/// Un morceau de la bibliothèque locale.
///
/// Les fichiers sont COPIES dans le dossier Documents de l'app : après import, ils vivent sur le
/// téléphone et se lisent hors-ligne, sans PC.
struct Track: Identifiable, Codable, Equatable {
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

    @Published private(set) var tracks: [Track] = []
    @Published private(set) var importing = false
    @Published var lastError: String?

    init() {
        createDirectories()
        load()
    }

    private func createDirectories() {
        for directory in [Self.audioDirectory, Self.artworkDirectory] {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    // MARK: - Persistance

    private func load() {
        guard let data = try? Data(contentsOf: Self.indexURL) else { return }
        tracks = (try? JSONDecoder().decode([Track].self, from: data)) ?? []
        tracks.sort { $0.addedAt < $1.addedAt }
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        if let data = try? encoder.encode(tracks) {
            try? data.write(to: Self.indexURL, options: .atomic)
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
    func adopt(data: Data, remote: Int, fallbackTitle: String, fallbackArtist: String) async {
        guard !tracks.contains(where: { $0.remoteID == remote }) else { return }
        let identifier = UUID()
        let temporary = Self.audioDirectory.appendingPathComponent("\(identifier.uuidString).incoming")
        do {
            try data.write(to: temporary, options: .atomic)
        } catch {
            lastError = "écriture impossible : \(error.localizedDescription)"
            return
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
        save()
    }

    func track(withID id: UUID) -> Track? { tracks.first { $0.id == id } }

    // MARK: - Regroupement par album

    /// Un album de la bibliothèque, avec sa pochette de référence et ses morceaux.
    struct AlbumGroup: Identifiable {
        let id: String
        let title: String
        let artist: String
        let artworkTrack: Track
        let tracks: [Track]
    }

    /// Un artiste, avec ses albums et sa pochette de référence.
    struct ArtistGroup: Identifiable {
        let id: String
        let name: String
        let artworkTrack: Track
        let albums: [AlbumGroup]
        var trackCount: Int { albums.reduce(0) { $0 + $1.tracks.count } }
    }

    /// Artistes regroupés, triés par nom (comme la vue Artistes du PC).
    var artists: [ArtistGroup] {
        var buckets: [String: [AlbumGroup]] = [:]
        for album in albums {
            buckets[album.artist, default: []].append(album)
        }
        return buckets.map { name, list in
            let reference = list.first(where: { $0.artworkTrack.artworkURL != nil })?.artworkTrack ?? list[0].artworkTrack
            return ArtistGroup(id: name, name: name, artworkTrack: reference, albums: list)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Morceaux à plat, triés par titre (comme la vue Titres du PC).
    var tracksByTitle: [Track] {
        tracks.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    /// Albums groupés (album + artiste), triés par ajout le plus récent.
    var albums: [AlbumGroup] {
        var buckets: [String: [Track]] = [:]
        for track in tracks {
            let key = "\(track.album)||\(track.artist)"
            buckets[key, default: []].append(track)
        }
        return buckets.map { key, list in
            let sorted = list.sorted { $0.addedAt < $1.addedAt }
            let reference = sorted.first(where: { $0.artworkURL != nil }) ?? sorted[0]
            return AlbumGroup(
                id: key,
                title: sorted[0].album,
                artist: sorted[0].artist,
                artworkTrack: reference,
                tracks: sorted
            )
        }
        .sorted { ($0.tracks.last?.addedAt ?? .distantPast) > ($1.tracks.last?.addedAt ?? .distantPast) }
    }
}



