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

    var fileURL: URL { Library.audioDirectory.appendingPathComponent(fileName) }
    var artworkURL: URL? {
        guard let artworkName else { return nil }
        return Library.artworkDirectory.appendingPathComponent(artworkName)
    }
}

/// Bibliothèque : import depuis Fichiers / iCloud, métadonnées, pochettes, persistance.
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

    // MARK: - Import

    /// Importe des fichiers choisis dans Fichiers / iCloud.
    ///
    /// Chaque fichier est copié, ses métadonnées lues (titre, artiste, album, pochette), puis il est
    /// ajouté à la bibliothèque. Un fichier illisible est ignoré sans interrompre les autres.
    func importFiles(_ urls: [URL]) async {
        importing = true
        defer { importing = false }

        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            let identifier = UUID()
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

            let asset = AVURLAsset(url: destination)
            let duration = (try? await asset.load(.duration)).map { CMTimeGetSeconds($0) } ?? 0
            let metadata = await Self.readMetadata(asset: asset)
            let artworkName = await Self.extractArtwork(asset: asset, identifier: identifier)

            tracks.append(
                Track(
                    id: identifier,
                    title: metadata.title ?? url.deletingPathExtension().lastPathComponent,
                    artist: metadata.artist ?? "Artiste inconnu",
                    album: metadata.album ?? "Album inconnu",
                    fileName: fileName,
                    artworkName: artworkName,
                    duration: duration.isFinite ? duration : 0,
                    addedAt: Date()
                )
            )
            save()
        }
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
}
