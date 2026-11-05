#if DEBUG
import AVFoundation
import SwiftUI
import UIKit

/// MODE DÉMO DE TEST — compilé UNIQUEMENT en Debug (jamais dans l'IPA installée).
///
/// Sert aux tests automatiques sur simulateur (GitHub Actions) : bibliothèque synthétique
/// (BPM connus, structure intro / cœur / outro, pochettes carrée, à bandes noires, large,
/// sombre), écrans ouverts automatiquement pour les captures, et enregistrement séparé des deux
/// platines pendant un vrai mix pour mesurer le calage des temps.
///
/// Arguments : -BentenDemo, -demoScreen=player|tracks|albums|playlists|playlist|settings|sweep,
/// -demoTrack=0…3, -demoMix.
enum DemoMode {
    static var arguments: [String] { ProcessInfo.processInfo.arguments }
    static var active: Bool { arguments.contains("-BentenDemo") }
    static func value(_ key: String) -> String? {
        arguments.first { $0.hasPrefix("-\(key)=") }.map { String($0.dropFirst(key.count + 2)) }
    }

    static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    // MARK: Bibliothèque synthétique

    struct Spec {
        let title: String
        let artist: String
        let album: String
        let bpm: Double
        let seconds: Double
        let introBars: Int
        let outroBars: Int
        let art: ArtKind
    }

    enum ArtKind { case square(UIColor, UIColor), letterbox(UIColor, UIColor), wide(UIColor, UIColor), dark, none }

    static let specs: [Spec] = [
        Spec(title: "Démo Nuit 124", artist: "Benten Test", album: "Album A", bpm: 124, seconds: 70, introBars: 8, outroBars: 6,
             art: .square(UIColor(red: 0.95, green: 0.2, blue: 0.4, alpha: 1), UIColor(red: 0.2, green: 0.1, blue: 0.6, alpha: 1))),
        Spec(title: "Démo Phonk 128", artist: "Drift Test", album: "Album B", bpm: 128, seconds: 70, introBars: 8, outroBars: 6,
             art: .letterbox(UIColor(red: 0.1, green: 0.8, blue: 0.7, alpha: 1), UIColor(red: 0.05, green: 0.2, blue: 0.3, alpha: 1))),
        Spec(title: "Démo Large 120", artist: "Wide Test", album: "Album C", bpm: 120, seconds: 40, introBars: 4, outroBars: 4,
             art: .wide(UIColor(red: 1, green: 0.7, blue: 0.2, alpha: 1), UIColor(red: 0.6, green: 0.1, blue: 0.1, alpha: 1))),
        Spec(title: "Démo Sombre 140", artist: "Dark Test", album: "Album D", bpm: 140, seconds: 40, introBars: 4, outroBars: 4,
             art: .dark),
    ]

    /// Crée (une fois par lancement) les fichiers audio et pochettes de démo, et renvoie les morceaux.
    @MainActor static func makeTracks() -> [Track] {
        let audio = Library.audioDirectory
        let artwork = Library.artworkDirectory
        try? FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: artwork, withIntermediateDirectories: true)
        var result: [Track] = []
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        for (index, spec) in specs.enumerated() {
            let id = UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", index + 1))!
            let fileName = "demo-\(index).caf"
            let url = audio.appendingPathComponent(fileName)
            if !FileManager.default.fileExists(atPath: url.path) { writeTrack(spec, to: url) }
            var artName: String?
            if let image = makeArt(spec.art, title: spec.title) {
                let name = "demo-\(index).png"
                try? image.pngData()?.write(to: artwork.appendingPathComponent(name))
                artName = name
            }
            result.append(Track(id: id, title: spec.title, artist: spec.artist, album: spec.album, fileName: fileName,
                                artworkName: artName, duration: spec.seconds, addedAt: base.addingTimeInterval(Double(index)), remoteID: nil))
        }
        // Remplissage A–Z (index alphabétique) : 1 s de silence chacun.
        let silence = audio.appendingPathComponent("demo-silence.caf")
        if !FileManager.default.fileExists(atPath: silence.path) {
            writeSamples([Float](repeating: 0, count: 44_100), to: silence)
        }
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        for (index, letter) in letters.enumerated() {
            for copy in 0..<2 {
                let id = UUID(uuidString: String(format: "00000000-0000-0000-0001-%012d", index * 2 + copy))!
                result.append(Track(id: id, title: "\(letter)\(copy == 0 ? "lpha" : "uxe") test", artist: "Index", album: "Index",
                                    fileName: "demo-silence.caf", artworkName: nil, duration: 1,
                                    addedAt: base.addingTimeInterval(-Double(index * 2 + copy)), remoteID: nil))
            }
        }
        return result
    }

    /// Morceau synthétique : charleston sur les contretemps partout ; grosse caisse (avec clic)
    /// + basse dans le cœur ; nappe d'accord en continu. Intro et outro sans grosse caisse ni
    /// basse (énergie basse), comme un vrai morceau.
    private static func writeTrack(_ spec: Spec, to url: URL) {
        let rate = 44_100.0
        let count = Int(spec.seconds * rate)
        var samples = [Float](repeating: 0, count: count)
        let beat = 60 / spec.bpm
        let totalBeats = Int(spec.seconds / beat)
        let coreStart = spec.introBars * 4
        let coreEnd = totalBeats - spec.outroBars * 4
        var noise: UInt32 = 12345
        func random() -> Float {
            noise = noise &* 1_664_525 &+ 1_013_904_223
            return Float(noise >> 8) / Float(1 << 24) * 2 - 1
        }
        for index in 0..<totalBeats {
            let onset = Int(Double(index) * beat * rate)
            let core = index >= coreStart && index < coreEnd
            if core {
                // Grosse caisse 55 Hz (chute de hauteur) + clic à 3 kHz.
                for n in 0..<Int(0.18 * rate) where onset + n < count {
                    let t = Double(n) / rate
                    let env = Float(exp(-t * 22))
                    let freq = 55 + 70 * exp(-t * 40)
                    samples[onset + n] += 0.7 * env * Float(sin(2 * .pi * freq * t))
                    if n < Int(0.004 * rate) { samples[onset + n] += 0.35 * Float(sin(2 * .pi * 3000 * t)) }
                }
                // Basse 110 Hz sur le temps.
                for n in 0..<Int(beat * 0.8 * rate) where onset + n < count {
                    let t = Double(n) / rate
                    samples[onset + n] += 0.22 * Float(sin(2 * .pi * 110 * t)) * Float(min(1, t * 80))
                }
            }
            // Charleston sur le contretemps (bruit bref).
            let hat = onset + Int(beat * 0.5 * rate)
            for n in 0..<Int(0.03 * rate) where hat + n < count {
                let t = Double(n) / rate
                samples[hat + n] += (core ? 0.22 : 0.16) * Float(exp(-t * 160)) * random()
            }
        }
        // Nappe (la mineur) en continu.
        for n in 0..<count {
            let t = Double(n) / rate
            let pad = sin(2 * .pi * 220 * t) + sin(2 * .pi * 261.63 * t) + sin(2 * .pi * 329.63 * t)
            samples[n] += Float(0.035 * pad)
        }
        writeSamples(samples, to: url)
    }

    private static func writeSamples(_ samples: [Float], to url: URL) {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let file = try? AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count)
        }
        try? file.write(from: buffer)
    }

    private static func makeArt(_ kind: ArtKind, title: String) -> UIImage? {
        func cover(_ size: CGSize, _ a: UIColor, _ b: UIColor, in context: CGContext, rect: CGRect) {
            let colors = [a.cgColor, b.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                context.saveGState()
                context.clip(to: rect)
                context.drawLinearGradient(gradient, start: rect.origin, end: CGPoint(x: rect.maxX, y: rect.maxY), options: [])
                context.restoreGState()
            }
            UIColor.white.withAlphaComponent(0.85).setFill()
            context.fillEllipse(in: rect.insetBy(dx: rect.width * 0.3, dy: rect.height * 0.3))
            let text = title as NSString
            text.draw(at: CGPoint(x: rect.minX + rect.width * 0.06, y: rect.minY + rect.height * 0.06),
                      withAttributes: [.font: UIFont.boldSystemFont(ofSize: rect.width * 0.07), .foregroundColor: UIColor.white])
            // Repères de bord : un cadre fin pour voir si quelque chose est coupé.
            UIColor.yellow.setStroke()
            context.setLineWidth(rect.width * 0.012)
            context.stroke(rect.insetBy(dx: rect.width * 0.006, dy: rect.width * 0.006))
        }
        switch kind {
        case .none:
            return nil
        case .square(let a, let b):
            let size = CGSize(width: 1000, height: 1000)
            return UIGraphicsImageRenderer(size: size, format: format()).image { cover(size, a, b, in: $0.cgContext, rect: CGRect(origin: .zero, size: size)) }
        case .letterbox(let a, let b):
            // Miniature vidéo 16:9 : pochette carrée au centre, bandes NOIRES à gauche et à droite.
            let size = CGSize(width: 1280, height: 720)
            return UIGraphicsImageRenderer(size: size, format: format()).image { context in
                UIColor.black.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                cover(size, a, b, in: context.cgContext, rect: CGRect(x: 280, y: 0, width: 720, height: 720))
            }
        case .wide(let a, let b):
            let size = CGSize(width: 1280, height: 720)
            return UIGraphicsImageRenderer(size: size, format: format()).image { cover(size, a, b, in: $0.cgContext, rect: CGRect(origin: .zero, size: size)) }
        case .dark:
            // Pochette SOMBRE dont tout le haut est noir : ne doit PAS être recadrée.
            let size = CGSize(width: 1000, height: 1000)
            return UIGraphicsImageRenderer(size: size, format: format()).image { context in
                UIColor.black.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                cover(size, UIColor(white: 0.12, alpha: 1), UIColor(white: 0.3, alpha: 1), in: context.cgContext,
                      rect: CGRect(x: 0, y: 450, width: 1000, height: 550))
            }
        }
    }

    private static func format() -> UIGraphicsImageRendererFormat {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return format
    }

    // MARK: Scénario

    /// Lance le scénario demandé une fois l'interface prête.
    @MainActor static func run(library: Library, player: Player, router: AppRouter, playlists: PlaylistStore) {
        guard active else { return }
        let main = library.tracks.filter { $0.album != "Index" }
        guard main.count >= 4 else { return }
        if playlists.items.first(where: { $0.name == "Test mosaïque" }) == nil {
            _ = playlists.create(named: "Test mosaïque", from: main.map(\.id))
        }
        let screen = value("demoScreen") ?? "player"
        let trackIndex = Int(value("demoTrack") ?? "0") ?? 0
        diag("DÉMO : scénario \(screen), morceau \(trackIndex)")
        for track in main {
            if let url = track.artworkURL, let image = ArtworkCache.thumbnail(at: url, maxPixel: 560) {
                diag("DÉMO : pochette « \(track.title) » vignette \(Int(image.size.width))×\(Int(image.size.height))")
            }
        }

        if arguments.contains("-demoLoop") {
            // « Répéter ce titre » : le morceau se mixe sur son propre début, platines enregistrées.
            player.shuffle = false
            player.repeatMode = .one
            player.play([main[0]], startingAt: 0)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                player.seek(to: max(0, player.duration - 22))
                player.demoRecordDecks(seconds: 34, directory: documents)
                for _ in 0..<10 {
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    try? DiagnosticsLog.shared.exportText.write(to: documents.appendingPathComponent("diag.txt"), atomically: true, encoding: .utf8)
                }
            }
            return
        }

        if arguments.contains("-demoMix") {
            // Vrai mix A (124 BPM) → B (128 BPM), platines enregistrées séparément.
            player.shuffle = false
            // Deux mix d'affilée : le 2e profite de la compensation apprise au 1er.
            player.play([main[0], main[1], main[0]], startingAt: 0)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                player.seek(to: max(0, player.duration - 34))
                player.demoRecordDecks(seconds: 80, directory: documents)
                try? await Task.sleep(nanoseconds: 28_000_000_000)
                // Pendant le morceau B : on avance juste avant SA sortie pour le 2e mix.
                player.seek(to: max(0, player.duration - 26))
                for _ in 0..<14 {
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    try? DiagnosticsLog.shared.exportText.write(to: documents.appendingPathComponent("diag.txt"), atomically: true, encoding: .utf8)
                }
            }
            return
        }

        switch screen {
        case "tracks", "albums":
            router.tab = .library
            player.play([main[trackIndex]], startingAt: 0)
        case "playlists", "playlist":
            router.tab = .playlists
            player.play([main[trackIndex]], startingAt: 0)
        case "settings", "sweep":
            router.tab = .settings
            if screen == "sweep" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    ThemeSweep.run(from: Theme.active, to: .jade) {
                        UserDefaults.standard.set(Palette.jade.rawValue, forKey: "palette")
                        Theme.apply(.jade)
                    }
                }
            }
        default:
            player.play([main[trackIndex]], startingAt: 0)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 800_000_000)
                withAnimation(Motion.sheet) { player.showFullScreen = true }
            }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            try? DiagnosticsLog.shared.exportText.write(to: documents.appendingPathComponent("diag.txt"), atomically: true, encoding: .utf8)
        }
    }
}

/// Enregistre la sortie d'une platine (avant le volume de mix) dans un fichier, avec l'heure
/// moteur du 1er échantillon (pour superposer les deux platines à l'échantillon près).
final class DemoRecorder: @unchecked Sendable {
    private let file: AVAudioFile
    private let name: String
    private let directory: URL
    private var firstSample: AVAudioFramePosition?
    private let lock = NSLock()

    init(file: AVAudioFile, name: String, directory: URL) {
        self.file = file
        self.name = name
        self.directory = directory
    }

    func write(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
        lock.lock()
        defer { lock.unlock() }
        if firstSample == nil {
            firstSample = when.sampleTime
            let info = "{\"first\": \(when.sampleTime), \"rate\": \(buffer.format.sampleRate)}"
            try? info.write(to: directory.appendingPathComponent("\(name).json"), atomically: true, encoding: .utf8)
        }
        try? file.write(from: buffer)
    }
}
#endif
