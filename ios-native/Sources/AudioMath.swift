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

/// Analyse d'un fichier audio : tempo et niveau, avec mémoire par morceau.
///
/// L'analyse coûte quelques dizaines de millisecondes par titre : on la fait UNE fois, puis on
/// garde le résultat en mémoire pour toute la session.
actor TrackAnalyzer {
    private var bpmCache: [UUID: Double?] = [:]
    private var levelCache: [UUID: Double] = [:]

    /// Tempo estimé d'un morceau, ou `nil` si le signal est ambigu.
    func bpm(of track: Track) -> Double? {
        if let cached = bpmCache[track.id] { return cached }
        let value = readSamples(of: track).flatMap { data in
            AudioMath.estimateBPM(samples: data.samples, sampleRate: data.rate)
        }
        bpmCache[track.id] = value
        return value
    }

    /// Niveau efficace du morceau (pour égaliser les volumes pendant le fondu).
    func level(of track: Track) -> Double {
        if let cached = levelCache[track.id] { return cached }
        let value = readSamples(of: track).map { AudioMath.rms($0.samples) } ?? 0
        levelCache[track.id] = value
        return value
    }

    /// Lit jusqu'à 60 s du morceau en mono et à taux réduit : suffisant pour le tempo, et rapide.
    private func readSamples(of track: Track) -> (samples: [Float], rate: Double)? {
        guard let file = try? AVAudioFile(forReading: track.fileURL) else { return nil }
        let format = file.processingFormat
        let target: Double = 22_050
        let ratio = format.sampleRate / target
        let frames = AVAudioFrameCount(min(Double(file.length), format.sampleRate * 60))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        do {
            try file.read(into: buffer)
        } catch {
            return nil
        }
        guard let channel = buffer.floatChannelData?[0] else { return nil }
        let length = Int(buffer.frameLength)
        var samples = [Float](repeating: 0, count: length)
        for index in 0..<length { samples[index] = channel[index] }
        // Sous-échantillonnage simple : l'autocorrélation travaille sur 100 points par seconde,
        // donc une fréquence native élevée n'apporterait rien.
        let step = max(1, Int(ratio))
        if step > 1 {
            samples = stride(from: 0, to: samples.count, by: step).map { samples[$0] }
        }
        return (samples, format.sampleRate / Double(step))
    }
}
