import AVFoundation
import Foundation

/// Analyse rythmique et calculs du fondu — portage EXACT du code du bureau
/// (`src/renderer/audio/beats.ts` et `loudness.ts`).
///
/// Mêmes formules, mêmes garde-fous, mêmes seuils : un fondu réglé sur le PC doit sonner pareil sur
/// le téléphone. Les fonctions sont pures (aucune dépendance à Web Audio ou AVAudioEngine), donc
/// testables et réutilisables.
enum AudioMath {
    /// Points d'enveloppe par seconde : assez fin pour situer un temps à ±10 ms.
    static let envelopeRate: Double = 100

    /// Enveloppe d'énergie (RMS par fenêtre), normalisée dans [0,1].
    static func energyEnvelope(samples: [Float], sampleRate: Double) -> [Float] {
        let hop = max(1, Int((sampleRate / envelopeRate).rounded()))
        let count = samples.count / hop
        guard count > 0 else { return [] }
        var envelope = [Float](repeating: 0, count: count)
        for index in 0..<count {
            let start = index * hop
            let end = min(samples.count, start + hop)
            var sum: Double = 0
            for sample in start..<end {
                let value = Double(samples[sample])
                sum += value * value
            }
            envelope[index] = Float((sum / Double(max(1, end - start))).squareRoot())
        }
        let peak = envelope.max() ?? 0
        if peak > 0 {
            for index in 0..<count { envelope[index] /= peak }
        }
        return envelope
    }

    /// Détection du tempo par autocorrélation des attaques (60–200 BPM).
    ///
    /// Renvoie `nil` plutôt qu'une valeur douteuse : un faux tempo donnerait un fondu mal calé,
    /// pire que pas de calage.
    static func estimateBPM(samples: [Float], sampleRate: Double) -> Double? {
        let envelope = energyEnvelope(samples: samples, sampleRate: sampleRate)
        guard envelope.count >= Int(envelopeRate) * 4 else { return nil }

        // Différences positives : on isole les ATTAQUES (le rythme) plutôt que le niveau.
        var onset = [Float](repeating: 0, count: envelope.count)
        for index in 1..<envelope.count {
            onset[index] = max(0, envelope[index] - envelope[index - 1])
        }

        let minLag = Int((envelopeRate * 60 / 200).rounded())
        let maxLag = Int((envelopeRate * 60 / 60).rounded())
        var bestLag = 0
        var bestScore: Double = 0
        var total: Double = 0

        for lag in minLag...max(minLag, maxLag) where lag < onset.count {
            var score: Double = 0
            var index = 0
            while index + lag < onset.count {
                score += Double(onset[index]) * Double(onset[index + lag])
                index += 1
            }
            score /= Double(onset.count - lag)
            total += score
            if score > bestScore {
                bestScore = score
                bestLag = lag
            }
        }

        guard bestLag > 0 else { return nil }
        let mean = total / Double(max(1, maxLag - minLag + 1))
        guard mean > 0, bestScore >= mean * 2.2 else { return nil }

        var bpm = envelopeRate * 60 / Double(bestLag)
        // L'autocorrélation attrape souvent le double ou la moitié : on ramène dans 70–180.
        while bpm < 70 { bpm *= 2 }
        while bpm > 180 { bpm /= 2 }
        return (bpm * 2).rounded() / 2
    }

    /// Durée d'une noire pour un tempo donné.
    static func beatDuration(bpm: Double) -> Double {
        guard bpm.isFinite, bpm > 0 else { return 0.5 }
        return 60 / bpm
    }

    /// Quantifie une durée de fondu sur un nombre ENTIER de temps (4 par défaut = une mesure).
    static func quantizeFadeToBeats(_ fadeSeconds: Double, bpm: Double?, beatsPerPhrase: Int = 4) -> Double {
        let requested = fadeSeconds.isFinite && fadeSeconds > 0 ? fadeSeconds : 0
        guard requested > 0 else { return 0 }
        guard let bpm, bpm.isFinite, bpm > 0 else { return requested }
        let unit = beatDuration(bpm: bpm) * Double(max(1, beatsPerPhrase))
        let count = max(1, (requested / unit).rounded())
        return count * unit
    }

    /// Gain d'égalisation de niveau entre la piste sortante et l'entrante, borné à ±6 dB.
    static func loudnessGain(outgoing: Double, incoming: Double, maxDecibels: Double = 6) -> Double {
        guard outgoing.isFinite, incoming.isFinite else { return 1 }
        guard outgoing > 0.0001, incoming > 0.0001 else { return 1 }
        let limit = pow(10, maxDecibels / 20)
        let ratio = outgoing / incoming
        return min(limit, max(1 / limit, ratio))
    }

    /// Niveau efficace d'un échantillon (RMS).
    static func rms(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var sum: Double = 0
        for value in samples {
            let v = Double(value)
            sum += v * v
        }
        return (sum / Double(samples.count)).squareRoot()
    }

    /// Premier instant « audible » (au-dessus du seuil), cherché dans les `limit` premières
    /// secondes. Sert à sauter le silence d'intro de la piste entrante.
    static func firstLoud(samples: [Float], sampleRate: Double, threshold: Float, limit: Double) -> Double {
        let window = max(1, Int(sampleRate * 0.05))
        let maxIndex = min(samples.count, Int(sampleRate * limit))
        var start = 0
        while start + window <= maxIndex {
            var sum: Float = 0
            for i in start..<(start + window) { sum += samples[i] * samples[i] }
            if (sum / Float(window)).squareRoot() > threshold {
                return max(0, Double(start) / sampleRate - 0.02)
            }
            start += window
        }
        return 0
    }

    /// Dernier instant « audible » d'un extrait (en secondes depuis le début de l'extrait).
    /// Renvoie 0 si tout l'extrait est sous le seuil.
    static func lastLoud(samples: [Float], sampleRate: Double, threshold: Float) -> Double {
        let window = max(1, Int(sampleRate * 0.05))
        var last = -1
        var index = 0
        var start = 0
        while start + window <= samples.count {
            var sum: Float = 0
            for i in start..<(start + window) { sum += samples[i] * samples[i] }
            if (sum / Float(window)).squareRoot() > threshold { last = index }
            index += 1
            start += window
        }
        return last < 0 ? 0 : Double((last + 1) * window) / sampleRate
    }

    /// Écart de vitesse pour accorder l'entrante sur le tempo de la sortante.
    ///
    /// Sur iOS, la correction est appliquée par `AVAudioUnitTimePitch`, qui change la vitesse SANS
    /// changer la hauteur (contrairement au PC, qui utilisait `playbackRate`). On peut donc rester
    /// dans la limite raisonnable de ±10 % sans jamais déformer la voix.
    static func tempoMatchRatio(outgoing: Double?, incoming: Double?, maxRatio: Double = 0.10) -> Double {
        guard let outgoing, let incoming, outgoing > 0, incoming > 0 else { return 1 }
        let ratio = outgoing / incoming
        guard abs(ratio - 1) <= maxRatio else { return 1 }
        return (ratio * 1000).rounded() / 1000
    }
}

/// Résultat de l'analyse d'un morceau, utilisé par l'automix.
struct TrackAnalysis: Sendable {
    /// Tempo estimé (nil si ambigu : on ne cale pas plutôt que de mal caler).
    var bpm: Double?
    /// Niveau efficace (RMS) de la première minute : sert à égaliser les volumes pendant le fondu.
    var level: Double
    /// Silence d'intro à sauter (secondes).
    var start: Double
    /// Fin « réelle » du morceau (secondes), avant la queue silencieuse ; nil = fin du fichier.
    var end: Double?

    static let empty = TrackAnalysis(bpm: nil, level: 0, start: 0, end: nil)
}

/// Analyse d'un fichier audio, avec mémoire par morceau.
///
/// UNE seule lecture de fichier par morceau (l'ancienne version relisait le fichier séparément
/// pour le tempo et pour le niveau) : la première minute pour le tempo, le niveau et l'intro, les
/// 25 dernières secondes pour trouver la vraie fin. Le résultat est gardé pour toute la session.
/// C'est un `actor` : tout ce travail tourne hors du fil principal.
actor TrackAnalyzer {
    private var cache: [UUID: TrackAnalysis] = [:]

    func analysis(of track: Track) -> TrackAnalysis {
        if let hit = cache[track.id] { return hit }
        let result = Self.analyze(url: track.fileURL)
        cache[track.id] = result
        return result
    }

    func bpm(of track: Track) -> Double? { analysis(of: track).bpm }
    func level(of track: Track) -> Double { analysis(of: track).level }

    private static func analyze(url: URL) -> TrackAnalysis {
        guard let file = try? AVAudioFile(forReading: url) else { return .empty }
        let rate = file.processingFormat.sampleRate
        guard rate > 0, file.length > 0 else { return .empty }
        let total = Double(file.length) / rate

        let head = readMono(file: file, from: 0, seconds: 60)
        let bpm = head.flatMap { AudioMath.estimateBPM(samples: $0.samples, sampleRate: $0.rate) }
        let level = head.map { AudioMath.rms($0.samples) } ?? 0
        // Seuil de « silence » : ~22 dB sous le niveau moyen du morceau, jamais ridiculement bas.
        let threshold = Float(max(0.004, level * 0.08))

        var start = 0.0
        if let head {
            start = AudioMath.firstLoud(samples: head.samples, sampleRate: head.rate, threshold: threshold, limit: 8)
        }

        var end: Double?
        let tailSeconds = min(25, total)
        let tailStartFrame = AVAudioFramePosition(max(0, Double(file.length) - tailSeconds * rate))
        if let tail = readMono(file: file, from: tailStartFrame, seconds: tailSeconds) {
            let lastLoud = AudioMath.lastLoud(samples: tail.samples, sampleRate: tail.rate, threshold: threshold)
            let candidate = Double(tailStartFrame) / rate + lastLoud
            // Garde-fou : une « fin » trouvée dans la première moitié serait une erreur d'analyse.
            if candidate > total * 0.5, candidate < total - 0.3 { end = candidate }
        }
        return TrackAnalysis(bpm: bpm, level: level, start: start, end: end)
    }

    /// Lit un extrait en mono, à ~22 kHz : suffisant pour le tempo et les silences, et rapide.
    private static func readMono(file: AVAudioFile, from frame: AVAudioFramePosition, seconds: Double) -> (samples: [Float], rate: Double)? {
        let format = file.processingFormat
        let available = file.length - frame
        guard available > 0 else { return nil }
        let frames = AVAudioFrameCount(min(Double(available), format.sampleRate * seconds))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        file.framePosition = frame
        do { try file.read(into: buffer, frameCount: frames) } catch { return nil }
        guard let channel = buffer.floatChannelData?[0] else { return nil }
        let length = Int(buffer.frameLength)
        guard length > 0 else { return nil }
        let step = max(1, Int(format.sampleRate / 22_050))
        var samples = [Float]()
        samples.reserveCapacity(length / step + 1)
        var index = 0
        while index < length {
            samples.append(channel[index])
            index += step
        }
        return (samples, format.sampleRate / Double(step))
    }
}
