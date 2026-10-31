import Foundation
import SwiftUI

/// Récupération des morceaux depuis le PC, sur le réseau local.
///
/// Le PC expose deux routes (voir l'app de bureau) :
///   `GET /api/library?token=…`      → liste JSON des morceaux
///   `GET /api/audio/<id>?token=…`   → flux du fichier audio
///
/// Le jeton est obligatoire : sans lui, n'importe qui sur le Wi-Fi pourrait aspirer la
/// bibliothèque. Il est affiché dans les Réglages de l'app PC.
@MainActor
final class SyncService: ObservableObject {
    @Published var running = false
    @Published var status = ""
    @Published var progress: Double = 0

    /// Morceau tel que le PC le décrit.
    private struct RemoteTrack: Decodable {
        let id: Int
        let title: String
        let artist: String
        let album: String
        let durationSec: Double
        let sizeBytes: Int?
        let audio: String
    }

    private struct RemoteLibrary: Decodable {
        let tracks: [RemoteTrack]
    }

    private struct ServerError: Decodable {
        let error: String
    }

    /// Normalise l'adresse saisie : sans schéma, on suppose `http://` (le PC sert en clair sur le
    /// réseau local). Un slash final est retiré pour ne pas doubler les séparateurs.
    static func normalize(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            text = "http://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        return URL(string: text) == nil ? nil : text
    }

    func run(base rawBase: String, token: String, limit: Int, library: Library) async {
        guard !running else { return }
        guard let base = Self.normalize(rawBase) else {
            status = "adresse invalide — exemple : http://192.168.1.10:4321"
            return
        }
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanToken.isEmpty else {
            status = "jeton manquant : il est affiché dans les Réglages du PC"
            return
        }

        running = true
        progress = 0
        defer { running = false }

        do {
            status = "connexion au PC…"
            let remote = try await fetchLibrary(base: base, token: cleanToken)
            let known = Set(library.tracks.compactMap { $0.remoteID })
            let pending = remote.filter { !known.contains($0.id) }
            if pending.isEmpty {
                status = "rien de nouveau sur le PC (\(remote.count) morceaux déjà connus)"
                return
            }
            let selection = Array(pending.prefix(max(1, limit)))
            status = "\(selection.count) morceau(x) à récupérer…"

            var added = 0
            for (offset, item) in selection.enumerated() {
                status = "récupération \(offset + 1)/\(selection.count) — \(item.title)"
                progress = Double(offset) / Double(selection.count)
                do {
                    let data = try await fetchAudio(base: base, token: cleanToken, path: item.audio)
                    await library.adopt(data: data, remote: item.id, fallbackTitle: item.title, fallbackArtist: item.artist)
                    added += 1
                } catch {
                    // Un morceau en échec ne doit pas arrêter les suivants.
                    continue
                }
            }
            progress = 1
            status = added == 0 ? "aucun morceau récupéré" : "\(added) morceau(x) récupéré(s)"
        } catch {
            status = Self.describe(error)
            progress = 0
        }
    }

    private func fetchLibrary(base: String, token: String) async throws -> [RemoteTrack] {
        guard let url = URL(string: "\(base)/api/library?token=\(token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token)") else {
            throw URLError(.badURL)
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 403 {
            throw NSError(domain: "benten", code: 403, userInfo: [NSLocalizedDescriptionKey: "jeton refusé par le PC (403)"])
        }
        guard http.statusCode == 200 else {
            throw NSError(domain: "benten", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "le PC a répondu \(http.statusCode)"])
        }
        return try JSONDecoder().decode(RemoteLibrary.self, from: data).tracks
    }

    private func fetchAudio(base: String, token: String, path: String) async throws -> Data {
        let separator = path.contains("?") ? "" : "?token=\(token)"
        guard let url = URL(string: "\(base)\(path)\(separator)") else { throw URLError(.badURL) }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    /// Traduit les erreurs réseau d'iOS en consigne utile : « Load failed » ne dit rien.
    static func describe(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorNetworkConnectionLost,
                 NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet:
                return "PC injoignable. Vérifie qu'il est allumé, sur le même Wi-Fi, et que Réglages ▸ Benten ▸ Réseau local est autorisé."
            case NSURLErrorAppTransportSecurityRequiresSecureConnection:
                return "iOS a bloqué la connexion non chiffrée (ATS)."
            default:
                break
            }
        }
        return error.localizedDescription
    }
}
