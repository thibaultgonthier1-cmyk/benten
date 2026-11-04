import Accelerate
import AVFoundation
import Foundation

// MARK: - Outils de calcul

enum AudioMath {
    /// Gain d'égalisation de niveau entre la piste sortante et l'entrante, borné à ±6 dB.
    static func loudnessGain(outgoing: Double, incoming: Double, maxDecibels: Double = 6) -> Double {
        guard outgoing.isFinite, incoming.isFinite else { return 1 }
        guard outgoing > 0.0001, incoming > 0.0001 else { return 1 }
        let limit = pow(10, maxDecibels / 20)
        return min(limit, max(1 / limit, outgoing / incoming))
    }

    /// Volume PERÇU, à la manière de la norme de loudness (EBU R128 / LUFS) :
    /// - filtre passe-haut (~150 Hz) : les grosses basses (808) ne trompent plus la mesure —
    ///   l'oreille juge le volume surtout dans les médiums ;
    /// - blocs de 400 ms, et seuil relatif à −10 dB : les passages calmes (intro, break) ne tirent
    ///   pas la mesure vers le bas.
    /// Renvoie un niveau efficace (linéaire) comparable d'un morceau à l'autre.
    static func perceivedLoudness(samples: [Float], sampleRate: Double) -> Double {
        guard samples.count > 16 else { return 0 }
        let coefficient = Float(exp(-2 * Double.pi * 150 / sampleRate))
        var previousInput: Float = 0
        var previousOutput: Float = 0
        let block = max(1, Int(sampleRate * 0.4))
        var energies: [Double] = []
        var sum: Double = 0
        var count = 0
        for sample in samples {
            let filtered = coefficient * (previousOutput + sample - previousInput)
            previousInput = sample
            previousOutput = filtered
            sum += Double(filtered * filtered)
            count += 1
            if count == block {
                energies.append(sum / Double(block))
                sum = 0
                count = 0
            }
        }
        let audible = energies.filter { $0 > 1e-7 }
        guard !audible.isEmpty else { return 0 }
        let ungated = audible.reduce(0, +) / Double(audible.count)
        let kept = audible.filter { $0 >= ungated * 0.1 }
        let mean = kept.isEmpty ? ungated : kept.reduce(0, +) / Double(kept.count)
        return mean.squareRoot()
    }

    /// Niveau efficace (RMS).
    static func rms(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var value: Float = 0
        vDSP_rmsqv(samples, 1, &value, vDSP_Length(samples.count))
        return Double(value)
    }

    /// Premier instant au-dessus du seuil dans les `limit` premières secondes (intro silencieuse).
    static func firstLoud(samples: [Float], sampleRate: Double, threshold: Float, limit: Double) -> Double {
        let window = max(1, Int(sampleRate * 0.05))
        let maxIndex = min(samples.count, Int(sampleRate * limit))
        var start = 0
        while start + window <= maxIndex {
            var value: Float = 0
            samples.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress! + start, 1, &value, vDSP_Length(window)) }
            if value > threshold { return max(0, Double(start) / sampleRate - 0.02) }
            start += window
        }
        return 0
    }

    /// Dernier instant au-dessus du seuil d'un extrait (secondes depuis le début de l'extrait).
    static func lastLoud(samples: [Float], sampleRate: Double, threshold: Float) -> Double {
        let window = max(1, Int(sampleRate * 0.05))
        var last = -1
        var index = 0
        var start = 0
        while start + window <= samples.count {
            var value: Float = 0
            samples.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress! + start, 1, &value, vDSP_Length(window)) }
            if value > threshold { last = index }
            index += 1
            start += window
        }
        return last < 0 ? 0 : Double((last + 1) * window) / sampleRate
    }

    /// Vitesse à appliquer à l'entrante pour que ses temps tombent sur ceux de la sortante.
    /// Gère le demi / double tempo (un phonk à 70 BPM se cale sur un à 140).
    static func tempoRatio(outgoing: Double, incoming: Double) -> Double {
        var best = 1.0
        var bestDistance = Double.infinity
        for factor in [0.5, 1.0, 2.0] {
            let ratio = outgoing / (incoming * factor)
            let distance = abs(log(ratio))
            if distance < bestDistance {
                bestDistance = distance
                best = ratio
            }
        }
        return best
    }

    // MARK: Tonalité (roue Camelot, celle des DJ)

    /// `key` : 0–11 = majeur (tonique C…B), 12–23 = mineur.
    static func camelot(_ key: Int) -> (number: Int, minor: Bool) {
        let tonic = key % 12
        let minor = key >= 12
        let number = minor ? ((7 * tonic) % 12 + 4) % 12 + 1 : ((7 * tonic) % 12 + 7) % 12 + 1
        return (number, minor)
    }

    static func camelotLabel(_ key: Int?) -> String? {
        guard let key else { return nil }
        let value = camelot(key)
        return "\(value.number)\(value.minor ? "A" : "B")"
    }

    /// Distance harmonique : 0 = même tonalité, 1 = voisine (mélange parfait), ≥ 2 = risque de
    /// dissonance. `nil` si une tonalité est inconnue.
    static func harmonicDistance(_ a: Int?, _ b: Int?) -> Int? {
        guard let a, let b else { return nil }
        let first = camelot(a)
        let second = camelot(b)
        let gap = abs(first.number - second.number)
        let wheel = min(gap, 12 - gap)
        if first.minor == second.minor { return wheel }
        return wheel == 0 ? 1 : wheel + 2
    }
}

// MARK: - Grille de temps

/// Analyse rythmique de précision « DJ ».
///
/// 1. Enveloppe d'attaques à 200 points/s, en mélangeant les basses (grosse caisse) et tout le
///    spectre, moyenne locale retirée (seuil adaptatif).
/// 2. Tempo grossier par autocorrélation, pondéré vers 125 BPM (zone musicale la plus probable).
/// 3. AFFINAGE au centième de BPM : on cherche le couple (tempo, phase) dont la grille tombe le
///    plus souvent sur des attaques, sur ~45 s. Une erreur d'1 % suffirait à décaler les temps
///    d'un demi-temps en 16 temps : c'est l'étape qui fait la différence.
/// 4. Temps fort (« 1 » de la mesure) : le temps de la mesure où la grosse caisse frappe le plus.
enum BeatAnalysis {
    static let envelopeRate = 200.0

    struct Envelope {
        let onset: [Float]
        let lowOnset: [Float]
        let rate: Double
    }

    static func envelope(_ samples: [Float], sampleRate: Double) -> Envelope? {
        let hop = max(1, Int((sampleRate / envelopeRate).rounded()))
        let frames = samples.count / hop
        guard frames > 16 else { return nil }
        var low = [Float](repeating: 0, count: frames)
        var full = [Float](repeating: 0, count: frames)
        let alpha = Float(1 - exp(-2 * Double.pi * 150 / sampleRate))
        var filtered: Float = 0
        samples.withUnsafeBufferPointer { buffer in
            for frame in 0..<frames {
                var lowEnergy: Float = 0
                var fullEnergy: Float = 0
                let base = frame * hop
                for index in base..<(base + hop) {
                    let x = buffer[index]
                    filtered += alpha * (x - filtered)
                    lowEnergy += filtered * filtered
                    fullEnergy += x * x
                }
                low[frame] = log1p(1000 * lowEnergy / Float(hop))
                full[frame] = log1p(1000 * fullEnergy / Float(hop))
            }
        }
        var onset = [Float](repeating: 0, count: frames)
        var lowOnset = [Float](repeating: 0, count: frames)
        for frame in 1..<frames {
            let dl = max(0, low[frame] - low[frame - 1])
            let df = max(0, full[frame] - full[frame - 1])
            lowOnset[frame] = dl
            onset[frame] = dl + 0.5 * df
        }
        // Seuil adaptatif : on retire la moyenne locale (0,5 s) pour ne garder que les vraies attaques.
        let radius = 50
        var prefix = [Float](repeating: 0, count: frames + 1)
        for frame in 0..<frames { prefix[frame + 1] = prefix[frame] + onset[frame] }
        var cleaned = [Float](repeating: 0, count: frames)
        for frame in 0..<frames {
            let lo = max(0, frame - radius)
            let hi = min(frames, frame + radius + 1)
            let mean = (prefix[hi] - prefix[lo]) / Float(hi - lo)
            cleaned[frame] = max(0, onset[frame] - mean)
        }
        return Envelope(onset: cleaned, lowOnset: lowOnset, rate: sampleRate / Double(hop))
    }

    /// Somme des attaques sur une grille (interpolation linéaire entre deux points).
    private static func gridScore(_ onset: [Float], period: Double, phase: Double) -> Float {
        var sum: Float = 0
        var position = phase
        let last = Double(onset.count - 1)
        onset.withUnsafeBufferPointer { buffer in
            while position < last {
                let index = Int(position)
                let fraction = Float(position - Double(index))
                sum += buffer[index] * (1 - fraction) + buffer[index + 1] * fraction
                position += period
            }
        }
        return sum
    }

    /// Tempo (fractionnaire), phase du premier temps (en points d'enveloppe) et confiance.
    static func tempo(_ env: Envelope) -> (bpm: Double, phase: Double, confidence: Double)? {
        let onset = env.onset
        let rate = env.rate
        guard onset.count > Int(rate * 8) else { return nil }

        let minLag = Int(rate * 60 / 200)
        let maxLag = min(onset.count / 3, Int(rate * 60 / 60))
        guard maxLag > minLag else { return nil }
        var bestLag = 0
        var bestValue: Float = 0
        onset.withUnsafeBufferPointer { buffer in
            for lag in minLag...maxLag {
                var dot: Float = 0
                vDSP_dotpr(buffer.baseAddress!, 1, buffer.baseAddress! + lag, 1, &dot, vDSP_Length(onset.count - lag))
                let bpm = 60 * rate / Double(lag)
                let weight = Float(exp(-0.5 * pow(log2(bpm / 125), 2)))
                let value = dot / Float(onset.count - lag) * weight
                if value > bestValue {
                    bestValue = value
                    bestLag = lag
                }
            }
        }
        guard bestLag > 0 else { return nil }
        var coarse = 60 * rate / Double(bestLag)
        while coarse < 70 { coarse *= 2 }
        while coarse > 180 { coarse /= 2 }

        var best = (bpm: coarse, phase: 0.0, score: Float(-1))
        var bpm = coarse * 0.97
        while bpm <= coarse * 1.03 {
            let period = 60 * rate / bpm
            var phase = 0.0
            while phase < period {
                let score = gridScore(onset, period: period, phase: phase)
                if score > best.score { best = (bpm, phase, score) }
                phase += 1
            }
            bpm += 0.02
        }
        // Affinage fin de la phase et du tempo autour du meilleur couple.
        let refinedPeriod0 = 60 * rate / best.bpm
        var fineBPM = best.bpm - 0.02
        while fineBPM <= best.bpm + 0.02 {
            let period = 60 * rate / fineBPM
            var phase = max(0, best.phase - 1)
            while phase <= best.phase + 1 {
                let score = gridScore(onset, period: period, phase: phase)
                if score > best.score { best = (fineBPM, phase, score) }
                phase += 0.1
            }
            fineBPM += 0.004
        }
        _ = refinedPeriod0

        // Confiance : la meilleure grille doit nettement dominer la moyenne des phases.
        let period = 60 * rate / best.bpm
        var total: Float = 0
        var count: Float = 0
        var phase = 0.0
        while phase < period {
            total += gridScore(onset, period: period, phase: phase)
            count += 1
            phase += 1
        }
        let mean = count > 0 ? total / count : 0
        let confidence = mean > 0 ? Double(best.score / mean) : 0
        return (best.bpm, best.phase, confidence)
    }

    /// Phase locale (en points) pour un tempo connu, sur un extrait donné : sert à recaler la
    /// grille au DÉBUT et à la FIN du morceau, là où se font les transitions.
    static func localPhase(_ env: Envelope, bpm: Double) -> (phase: Double, confidence: Double)? {
        let onset = env.onset
        guard onset.count > Int(env.rate * 4) else { return nil }
        let period = 60 * env.rate / bpm
        var best = (phase: 0.0, score: Float(-1))
        var total: Float = 0
        var count: Float = 0
        var phase = 0.0
        while phase < period {
            let score = gridScore(onset, period: period, phase: phase)
            total += score
            count += 1
            if score > best.score { best = (phase, score) }
            phase += 0.25
        }
        let mean = count > 0 ? total / count : 0
        return (best.phase, mean > 0 ? Double(best.score / mean) : 0)
    }

    /// Lequel des 4 temps porte le « 1 » : celui où la grosse caisse est la plus forte.
    static func downbeatOffset(_ env: Envelope, bpm: Double, phase: Double) -> Int {
        let period = 60 * env.rate / bpm
        var sums = [Float](repeating: 0, count: 4)
        var position = phase
        var beat = 0
        let lows = env.lowOnset
        while position < Double(lows.count - 2) {
            let index = Int(position)
            sums[beat % 4] += max(lows[index], lows[index + 1])
            position += period
            beat += 1
        }
        return sums.enumerated().max { $0.element < $1.element }?.offset ?? 0
    }
}

// MARK: - Tonalité

/// Détection de tonalité : chromagramme (FFT) corrélé aux profils de Krumhansl.
enum KeyDetector {
    private static let major: [Double] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    private static let minor: [Double] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

    static func estimate(samples: [Float], sampleRate: Double) -> Int? {
        let size = 4096
        let log2n = vDSP_Length(12)
        guard samples.count > size * 4, let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return nil }
        defer { vDSP_destroy_fftsetup(setup) }

        var window = [Float](repeating: 0, count: size)
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_NORM))
        // Case de fréquence → classe de hauteur (do, do#, …), entre 80 Hz et 2 kHz.
        var pitchClass = [Int](repeating: -1, count: size / 2)
        for bin in 1..<(size / 2) {
            let frequency = Double(bin) * sampleRate / Double(size)
            guard frequency >= 80, frequency <= 2000 else { continue }
            let midi = 12 * log2(frequency / 440) + 69
            pitchClass[bin] = ((Int(midi.rounded()) % 12) + 12) % 12
        }

        var chroma = [Double](repeating: 0, count: 12)
        var frame = [Float](repeating: 0, count: size)
        var real = [Float](repeating: 0, count: size / 2)
        var imag = [Float](repeating: 0, count: size / 2)
        var magnitudes = [Float](repeating: 0, count: size / 2)
        var start = 0
        while start + size <= samples.count {
            samples.withUnsafeBufferPointer { source in
                vDSP_vmul(source.baseAddress! + start, 1, window, 1, &frame, 1, vDSP_Length(size))
            }
            real.withUnsafeMutableBufferPointer { realBuffer in
                imag.withUnsafeMutableBufferPointer { imagBuffer in
                    var split = DSPSplitComplex(realp: realBuffer.baseAddress!, imagp: imagBuffer.baseAddress!)
                    frame.withUnsafeBufferPointer { framePointer in
                        framePointer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: size / 2) { complex in
                            vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(size / 2))
                        }
                    }
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    vDSP_zvmags(&split, 1, &magnitudes, 1, vDSP_Length(size / 2))
                }
            }
            for bin in 1..<(size / 2) where pitchClass[bin] >= 0 {
                chroma[pitchClass[bin]] += Double(magnitudes[bin]).squareRoot()
            }
            start += size * 2
        }
        guard chroma.reduce(0, +) > 0 else { return nil }

        var bestKey = 0
        var bestScore = -Double.infinity
        for tonic in 0..<12 {
            let majorScore = correlation(chroma, rotated(major, by: tonic))
            if majorScore > bestScore { bestScore = majorScore; bestKey = tonic }
            let minorScore = correlation(chroma, rotated(minor, by: tonic))
            if minorScore > bestScore { bestScore = minorScore; bestKey = tonic + 12 }
        }
        return bestScore > 0.3 ? bestKey : nil
    }

    private static func rotated(_ profile: [Double], by tonic: Int) -> [Double] {
        (0..<12).map { profile[(($0 - tonic) % 12 + 12) % 12] }
    }

    private static func correlation(_ a: [Double], _ b: [Double]) -> Double {
        let meanA = a.reduce(0, +) / 12
        let meanB = b.reduce(0, +) / 12
        var top = 0.0, left = 0.0, right = 0.0
        for index in 0..<12 {
            let x = a[index] - meanA
            let y = b[index] - meanB
            top += x * y
            left += x * x
            right += y * y
        }
        let bottom = (left * right).squareRoot()
        return bottom > 0 ? top / bottom : 0
    }
}

// MARK: - Résultat d'analyse

/// Tout ce que l'automix sait d'un morceau. Sauvegardé sur le disque : chaque morceau n'est
/// analysé qu'UNE fois, même après un redémarrage.
struct TrackAnalysis: Codable, Sendable {
    var bpm: Double?
    var confidence: Double
    /// Un temps fort (« 1 ») près du DÉBUT, en secondes absolues dans le fichier.
    var headDownbeat: Double?
    /// Un temps fort près du MILIEU (grille de référence).
    var midDownbeat: Double?
    /// Un temps fort près de la FIN (là où commence la transition).
    var tailDownbeat: Double?
    /// Tonalité (0–11 majeur, 12–23 mineur).
    var key: Int?
    /// Niveau efficace de la partie la plus représentative (milieu du morceau).
    var level: Double
    /// Silence d'intro à sauter (secondes).
    var start: Double
    /// Fin « réelle », avant la queue silencieuse (nil = fin du fichier).
    var end: Double?
    /// Volume PERÇU (filtré, fenêtré) : sert à mettre tous les morceaux au même volume.
    var loudness: Double?

    static let empty = TrackAnalysis(bpm: nil, confidence: 0, headDownbeat: nil, midDownbeat: nil, tailDownbeat: nil, key: nil, level: 0, start: 0, end: nil, loudness: nil)

    var hasGrid: Bool { bpm != nil }
}

/// Analyse des morceaux, avec mémoire PERSISTANTE. `actor` : tout tourne hors du fil principal.
actor TrackAnalyzer {
    private var cache: [UUID: TrackAnalysis] = [:]
    private var saveScheduled = false

    private static var storeURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("benten-analysis-v4.json")
    }

    init() {
        if let data = try? Data(contentsOf: Self.storeURL),
           let stored = try? JSONDecoder().decode([UUID: TrackAnalysis].self, from: data) {
            cache = stored
        }
    }

    func cached(_ track: Track) -> TrackAnalysis? { cache[track.id] }

    func analysis(of track: Track) -> TrackAnalysis {
        if let hit = cache[track.id] { return hit }
        let result = Self.analyze(url: track.fileURL)
        cache[track.id] = result
        scheduleSave()
        return result
    }

    private func scheduleSave() {
        guard !saveScheduled else { return }
        saveScheduled = true
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            self.flush()
        }
    }

    private func flush() {
        saveScheduled = false
        guard let data = try? JSONEncoder().encode(cache) else { return }
        try? data.write(to: Self.storeURL, options: .atomic)
    }

    private static func analyze(url: URL) -> TrackAnalysis {
        guard let file = try? AVAudioFile(forReading: url) else { return .empty }
        let rate = file.processingFormat.sampleRate
        guard rate > 0, file.length > 0 else { return .empty }
        let total = Double(file.length) / rate

        // Trois extraits : début (intro + calage d'entrée), milieu (tempo, tonalité, niveau),
        // fin (vraie fin + calage de sortie).
        let head = readMono(file: file, from: 0, seconds: 30)
        let middleStart = min(max(0, total - 45), max(20, total * 0.3))
        let middle = readMono(file: file, from: AVAudioFramePosition(middleStart * rate), seconds: 45)
        let tailStart = max(0, total - 30)
        let tail = readMono(file: file, from: AVAudioFramePosition(tailStart * rate), seconds: 30)

        let reference = middle ?? head
        let level = reference.map { AudioMath.rms($0.samples) } ?? 0
        let threshold = Float(max(0.004, level * 0.08))

        var result = TrackAnalysis.empty
        result.level = level
        if let reference {
            let perceived = AudioMath.perceivedLoudness(samples: reference.samples, sampleRate: reference.rate)
            if perceived > 0 { result.loudness = perceived }
        }
        if let head {
            result.start = AudioMath.firstLoud(samples: head.samples, sampleRate: head.rate, threshold: threshold, limit: 8)
        }
        if let tail {
            let lastLoud = AudioMath.lastLoud(samples: tail.samples, sampleRate: tail.rate, threshold: threshold)
            let candidate = tailStart + lastLoud
            if candidate > total * 0.5, candidate < total - 0.3 { result.end = candidate }
        }
        if let middle {
            result.key = KeyDetector.estimate(samples: middle.samples, sampleRate: middle.rate)
        }

        guard let reference,
              let env = BeatAnalysis.envelope(reference.samples, sampleRate: reference.rate),
              let tempo = BeatAnalysis.tempo(env),
              tempo.confidence >= 1.25 else { return result }
        result.bpm = tempo.bpm
        result.confidence = tempo.confidence
        let referenceStart = middle != nil ? middleStart : 0
        let bar = 4 * 60 / tempo.bpm

        func downbeat(in env: BeatAnalysis.Envelope, phase: Double, origin: Double) -> Double {
            let beatOffset = BeatAnalysis.downbeatOffset(env, bpm: tempo.bpm, phase: phase)
            return origin + (phase + Double(beatOffset) * 60 * env.rate / tempo.bpm) / env.rate
        }

        result.midDownbeat = downbeat(in: env, phase: tempo.phase, origin: referenceStart)

        // Recalage local au début et à la fin (aucune dérive de grille sur la durée du morceau).
        if let head, let headEnv = BeatAnalysis.envelope(head.samples, sampleRate: head.rate),
           let local = BeatAnalysis.localPhase(headEnv, bpm: tempo.bpm), local.confidence >= 1.2 {
            result.headDownbeat = downbeat(in: headEnv, phase: local.phase, origin: 0)
        }
        if let tail, let tailEnv = BeatAnalysis.envelope(tail.samples, sampleRate: tail.rate),
           let local = BeatAnalysis.localPhase(tailEnv, bpm: tempo.bpm), local.confidence >= 1.2 {
            result.tailDownbeat = downbeat(in: tailEnv, phase: local.phase, origin: tailStart)
        }
        // Les temps forts locaux doivent rester cohérents avec la grille du milieu (± un temps) ;
        // sinon on garde la grille du milieu, plus fiable.
        if let mid = result.midDownbeat {
            for keyPath in [\TrackAnalysis.headDownbeat, \TrackAnalysis.tailDownbeat] {
                if let local = result[keyPath: keyPath] {
                    let offset = (local - mid).truncatingRemainder(dividingBy: 60 / tempo.bpm)
                    let wrapped = min(abs(offset), 60 / tempo.bpm - abs(offset))
                    if wrapped > 0.06 { result[keyPath: keyPath] = nil }
                }
            }
        }
        _ = bar
        return result
    }

    /// Lit un extrait en mono (moyenne des canaux) à ~11 kHz, avec un filtre de moyenne pour
    /// limiter le repliement. Suffisant et rapide pour le rythme, la tonalité et les silences.
    private static func readMono(file: AVAudioFile, from frame: AVAudioFramePosition, seconds: Double) -> (samples: [Float], rate: Double)? {
        let format = file.processingFormat
        let rate = format.sampleRate
        let available = file.length - frame
        guard available > 0 else { return nil }
        let frames = AVAudioFrameCount(min(Double(available), rate * seconds))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        file.framePosition = frame
        do { try file.read(into: buffer, frameCount: frames) } catch { return nil }
        guard let data = buffer.floatChannelData else { return nil }
        let length = Int(buffer.frameLength)
        let channels = max(1, Int(format.channelCount))
        let step = max(1, Int((rate / 11_025).rounded()))
        let count = length / step
        guard count > 0 else { return nil }
        var output = [Float](repeating: 0, count: count)
        let scale = 1 / Float(step * channels)
        for channel in 0..<channels {
            let source = data[channel]
            for index in 0..<count {
                var sum: Float = 0
                let base = index * step
                for offset in 0..<step { sum += source[base + offset] }
                output[index] += sum * scale
            }
        }
        return (output, rate / Double(step))
    }
}

// MARK: - Planification d'une transition

/// Une transition prête à jouer.
struct MixPlan: Sendable {
    enum Style: Sendable {
        /// Mix calé : temps alignés, tempo accordé, bass swap.
        case beatmix
        /// Tempos incompatibles : fondu avec filtre passe-haut sur la sortante.
        case filter
        /// Rythme non détecté : fondu à puissance constante.
        case crossfade
        /// Même album : enchaînement sans aucun blanc, sans fondu (comme Apple).
        case gapless
    }

    var style: Style
    /// Position (secondes) de la SORTANTE où démarre l'entrante.
    var exitAt: Double
    /// Position (secondes) de l'ENTRANTE à laquelle elle démarre.
    var entryAt: Double
    /// Durée du chevauchement (secondes réelles).
    var length: Double
    /// Vitesse appliquée à l'entrante pendant le mix (hauteur préservée).
    var tempoRatio: Double
    var levelGain: Double
    var bassSwap: Bool
}

enum MixPlanner {
    static func plan(
        out: TrackAnalysis, outDuration: Double,
        into incoming: TrackAnalysis,
        sameAlbum: Bool, beats: Int, seconds: Double, beatMatch: Bool
    ) -> MixPlan {
        let outEnd = min(outDuration, out.end ?? outDuration)
        let inStart = min(max(0, incoming.start), 8)

        if sameAlbum {
            return MixPlan(style: .gapless, exitAt: outDuration, entryAt: 0, length: 0, tempoRatio: 1, levelGain: 1, bassSwap: false)
        }
        let gain = AudioMath.loudnessGain(outgoing: out.level, incoming: incoming.level)

        if beatMatch, let outBPM = out.bpm, let inBPM = incoming.bpm {
            let ratio = AudioMath.tempoRatio(outgoing: outBPM, incoming: inBPM)
            let beat = 60 / outBPM
            if abs(ratio - 1) <= 0.08 {
                // Tonalités qui se marient mal → transition plus courte.
                var count = beats
                if let distance = AudioMath.harmonicDistance(out.key, incoming.key), distance > 1 {
                    count = max(8, beats / 2)
                }
                let bar = beat * 4
                var length = min(Double(count) * beat, max(bar * 2, outEnd * 0.3))
                var exit = outEnd - length
                if let anchor = out.tailDownbeat ?? out.midDownbeat {
                    exit = anchor + ((exit - anchor) / bar).rounded(.down) * bar
                }
                exit = max(outDuration * 0.35, exit)
                length = max(1, min(length, outDuration - exit - 0.05))

                var entry = inStart
                if let anchor = incoming.headDownbeat ?? incoming.midDownbeat {
                    let inBar = 4 * 60 / inBPM
                    let aligned = anchor + ((inStart - 0.02 - anchor) / inBar).rounded(.up) * inBar
                    if aligned >= 0, aligned <= inStart + inBar { entry = aligned }
                }
                return MixPlan(style: .beatmix, exitAt: exit, entryAt: max(0, entry), length: length, tempoRatio: ratio, levelGain: gain, bassSwap: true)
            }

            let length = min(seconds, 6)
            var exit = outEnd - length
            if let anchor = out.tailDownbeat ?? out.midDownbeat {
                exit = anchor + ((exit - anchor) / beat).rounded(.down) * beat
            }
            return MixPlan(style: .filter, exitAt: max(0, exit), entryAt: inStart, length: length, tempoRatio: 1, levelGain: gain, bassSwap: false)
        }

        let length = min(seconds, max(1, outEnd * 0.25))
        return MixPlan(style: .crossfade, exitAt: max(0, outEnd - length), entryAt: inStart, length: length, tempoRatio: 1, levelGain: gain, bassSwap: true)
    }
}
