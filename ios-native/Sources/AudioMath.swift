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

    /// Basses seules (passe-bas 1 pôle à 150 Hz) : grosse caisse et ligne de basse.
    static func lowPassed(_ samples: [Float], sampleRate: Double) -> [Float] {
        let alpha = Float(1 - exp(-2 * Double.pi * 150 / sampleRate))
        var state: Float = 0
        var output = [Float](repeating: 0, count: samples.count)
        for index in samples.indices {
            state += alpha * (samples[index] - state)
            output[index] = state
        }
        return output
    }

    /// Énergie (RMS) de chaque mesure d'un extrait, plein spectre et basses.
    /// `origin` : position (s) du 1er échantillon de l'extrait dans le morceau ;
    /// `firstBar` : position (s) d'un temps fort ; les mesures suivent toutes les `bar` secondes.
    static func barEnergies(samples: [Float], rate: Double, origin: Double, firstBar: Double, bar: Double) -> [(time: Double, full: Double, low: Double)] {
        guard bar > 0.3, rate > 0, !samples.isEmpty else { return [] }
        let low = lowPassed(samples, sampleRate: rate)
        var result: [(time: Double, full: Double, low: Double)] = []
        var time = firstBar
        while true {
            let from = Int(((time - origin) * rate).rounded())
            let to = Int(((time + bar - origin) * rate).rounded())
            if to > samples.count { break }
            if from >= 0, to - from > 8 {
                var full: Float = 0
                var bass: Float = 0
                samples.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress! + from, 1, &full, vDSP_Length(to - from)) }
                low.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress! + from, 1, &bass, vDSP_Length(to - from)) }
                result.append((time, Double(full), Double(bass)))
            }
            time += bar
        }
        return result
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
/// 4. Grille prolongée et affinée sur TOUT le morceau (`refineWhole`), tempo fixe vérifié.
/// 5. « 1 » de la mesure et phrases : vote sur tout le morceau (`meter`) — énergie, harmonie,
///    motif grosse caisse / caisse claire.
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

// MARK: - Volume perçu (LUFS) et outils de signal

extension AudioMath {
    /// Différence échantillon par échantillon (a − b) : partie aiguë = signal − basses.
    static func difference(_ a: [Float], _ b: [Float]) -> [Float] {
        let count = min(a.count, b.count)
        guard count > 0 else { return [] }
        var output = [Float](repeating: 0, count: count)
        vDSP_vsub(b, 1, a, 1, &output, 1, vDSP_Length(count))
        return output
    }

    /// Niveau efficace d'une tranche d'un tampon (0 si la tranche sort du tampon).
    static func rms(_ buffer: UnsafeBufferPointer<Float>, from: Int, count: Int) -> Float {
        guard count > 0, from >= 0, from + count <= buffer.count, let base = buffer.baseAddress else { return 0 }
        var value: Float = 0
        vDSP_rmsqv(base + from, 1, &value, vDSP_Length(count))
        return value
    }

    /// Niveau efficace de (a − b) sur une tranche, sans créer le signal différence :
    /// moyenne((a − b)²) = moy(a²) − 2·moy(a·b) + moy(b²).
    static func rmsDifference(_ a: UnsafeBufferPointer<Float>, _ b: UnsafeBufferPointer<Float>, from: Int, count: Int) -> Float {
        guard count > 0, from >= 0, from + count <= a.count, from + count <= b.count,
              let baseA = a.baseAddress, let baseB = b.baseAddress else { return 0 }
        var aa: Float = 0, ab: Float = 0, bb: Float = 0
        vDSP_dotpr(baseA + from, 1, baseA + from, 1, &aa, vDSP_Length(count))
        vDSP_dotpr(baseA + from, 1, baseB + from, 1, &ab, vDSP_Length(count))
        vDSP_dotpr(baseB + from, 1, baseB + from, 1, &bb, vDSP_Length(count))
        return (max(0, aa - 2 * ab + bb) / Float(count)).squareRoot()
    }

    /// Courbe en S (3u² − 2u³), bornée à [0, 1].
    static func smoothstep(_ u: Double) -> Double {
        let x = min(1, max(0, u))
        return x * x * (3 - 2 * x)
    }

    /// Pondération K de la norme ITU-R BS.1770 (celle des LUFS) : plateau +4 dB au-dessus de
    /// ~1,7 kHz (sensibilité de l'oreille) puis passe-haut 38 Hz. Coefficients recalculés pour la
    /// fréquence d'échantillonnage réelle (formules de libebur128). Renvoie le signal pondéré.
    static func kWeighted(_ samples: [Float], sampleRate: Double) -> [Float] {
        guard sampleRate > 4000, !samples.isEmpty else { return samples }
        // Étage 1 : plateau aigu.
        let f0 = 1681.974450955533
        let gainDB = 3.999843853973347
        let q = 0.7071752369554196
        let k = tan(Double.pi * f0 / sampleRate)
        let vh = pow(10.0, gainDB / 20)
        let vb = pow(vh, 0.4996667741545416)
        let a0 = 1 + k / q + k * k
        let b0 = (vh + vb * k / q + k * k) / a0
        let b1 = 2 * (k * k - vh) / a0
        let b2 = (vh - vb * k / q + k * k) / a0
        let a1 = 2 * (k * k - 1) / a0
        let a2 = (1 - k / q + k * k) / a0
        // Étage 2 : passe-haut.
        let f1 = 38.13547087602444
        let q1 = 0.5003270373238773
        let k1 = tan(Double.pi * f1 / sampleRate)
        let d0 = 1 + k1 / q1 + k1 * k1
        let c1 = 2 * (k1 * k1 - 1) / d0
        let c2 = (1 - k1 / q1 + k1 * k1) / d0

        var output = [Float](repeating: 0, count: samples.count)
        var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
        var u1 = 0.0, u2 = 0.0, z1 = 0.0, z2 = 0.0
        for index in samples.indices {
            let x = Double(samples[index])
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x
            y2 = y1; y1 = y
            let z = y - 2 * u1 + u2 - c1 * z1 - c2 * z2
            u2 = u1; u1 = y
            z2 = z1; z1 = z
            output[index] = Float(z)
        }
        return output
    }

    /// Volume INTÉGRÉ en LUFS (EBU R128) d'un signal déjà pondéré K : blocs de 400 ms recouverts à
    /// 75 %, porte absolue −70 LUFS, porte relative −10 LU. Le signal est un mixage mono (L+R)/2 :
    /// on compte deux canaux identiques (+3 dB), comme un titre stéréo ordinaire.
    static func integratedLoudness(weighted: [Float], sampleRate: Double) -> Double? {
        let step = max(1, Int(sampleRate * 0.1))
        let segments = weighted.count / step
        guard segments >= 4 else { return nil }
        var energy = [Double](repeating: 0, count: segments)
        weighted.withUnsafeBufferPointer { buffer in
            for segment in 0..<segments {
                var value: Float = 0
                vDSP_measqv(buffer.baseAddress! + segment * step, 1, &value, vDSP_Length(step))
                energy[segment] = Double(value)
            }
        }
        var blocks: [Double] = []
        for start in 0...(segments - 4) {
            let mean = (energy[start] + energy[start + 1] + energy[start + 2] + energy[start + 3]) / 4
            blocks.append(2 * mean)
        }
        func lufs(_ power: Double) -> Double { -0.691 + 10 * log10(max(power, 1e-12)) }
        let absolute = blocks.filter { lufs($0) > -70 }
        guard !absolute.isEmpty else { return nil }
        let ungated = absolute.reduce(0, +) / Double(absolute.count)
        let threshold = lufs(ungated) - 10
        let kept = absolute.filter { lufs($0) > threshold }
        let mean = kept.isEmpty ? ungated : kept.reduce(0, +) / Double(kept.count)
        return lufs(mean)
    }

    /// Volume (LUFS, même échelle) d'une tranche d'un signal pondéré K.
    static func shortLoudness(_ buffer: UnsafeBufferPointer<Float>, from: Int, count: Int) -> Double {
        guard count > 0, from >= 0, from + count <= buffer.count, let base = buffer.baseAddress else { return -70 }
        var value: Float = 0
        vDSP_measqv(base + from, 1, &value, vDSP_Length(count))
        return max(-70, -0.691 + 10 * log10(max(2 * Double(value), 1e-12)))
    }
}

// MARK: - Chromagramme par trame (changements d'accords)

/// FFT 4096 points → 12 classes de hauteur (90 Hz – 2 kHz), normalisées. Sert à repérer les
/// changements d'harmonie, qui tombent presque toujours sur le « 1 » des mesures.
final class ChromaExtractor {
    let size = 4096
    private let log2n = vDSP_Length(12)
    private let setup: FFTSetup
    private var window: [Float]
    private var frame: [Float]
    private var real: [Float]
    private var imag: [Float]
    private var magnitudes: [Float]
    private let pitchClass: [Int]

    init?(sampleRate: Double) {
        let length = 4096
        guard sampleRate > 0, let fft = vDSP_create_fftsetup(vDSP_Length(12), FFTRadix(kFFTRadix2)) else { return nil }
        var hann = [Float](repeating: 0, count: length)
        vDSP_hann_window(&hann, vDSP_Length(length), Int32(vDSP_HANN_NORM))
        var classes = [Int](repeating: -1, count: length / 2)
        for bin in 1..<(length / 2) {
            let frequency = Double(bin) * sampleRate / Double(length)
            guard frequency >= 90, frequency <= 2000 else { continue }
            let midi = 12 * log2(frequency / 440) + 69
            classes[bin] = ((Int(midi.rounded()) % 12) + 12) % 12
        }
        setup = fft
        window = hann
        pitchClass = classes
        frame = [Float](repeating: 0, count: length)
        real = [Float](repeating: 0, count: length / 2)
        imag = [Float](repeating: 0, count: length / 2)
        magnitudes = [Float](repeating: 0, count: length / 2)
    }

    deinit {
        vDSP_destroy_fftsetup(setup)
    }

    func chroma(_ source: UnsafeBufferPointer<Float>, start: Int) -> [Float] {
        var result = [Float](repeating: 0, count: 12)
        guard start >= 0, start + size <= source.count, let base = source.baseAddress else { return result }
        let half = size / 2
        vDSP_vmul(base + start, 1, window, 1, &frame, 1, vDSP_Length(size))
        real.withUnsafeMutableBufferPointer { realBuffer in
            imag.withUnsafeMutableBufferPointer { imagBuffer in
                var split = DSPSplitComplex(realp: realBuffer.baseAddress!, imagp: imagBuffer.baseAddress!)
                frame.withUnsafeBufferPointer { framePointer in
                    framePointer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { complex in
                        vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(half))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvmags(&split, 1, &magnitudes, 1, vDSP_Length(half))
            }
        }
        var total: Float = 0
        for bin in 1..<half where pitchClass[bin] >= 0 {
            let value = magnitudes[bin].squareRoot()
            result[pitchClass[bin]] += value
            total += value
        }
        if total > 0 {
            for index in 0..<12 { result[index] /= total }
        }
        return result
    }
}

// MARK: - Grille sur tout le morceau, « 1 » de mesure et phrases

extension BeatAnalysis {
    /// Morceau d'enveloppe [from, to) (en points).
    static func slice(_ env: Envelope, from: Int, to: Int) -> Envelope? {
        let lo = max(0, from)
        let hi = min(env.onset.count, to)
        guard hi - lo > 16 else { return nil }
        return Envelope(onset: Array(env.onset[lo..<hi]), lowOnset: Array(env.lowOnset[lo..<hi]), rate: env.rate)
    }

    /// AFFINAGE SUR TOUT LE MORCEAU : la grille trouvée sur 45 s est prolongée du début à la fin,
    /// et on cherche le tempo (±0,3 %, pas de 0,005 %) et la phase (±10 ms) qui tombent le mieux
    /// sur TOUTES les attaques. Sur 4 min, une erreur de 0,01 % décalerait la fin de 24 ms : la
    /// précision vient de la longueur mesurée. `anchor` : position (points) d'un temps du cœur.
    static func refineWhole(_ env: Envelope, bpm: Double, anchor: Double) -> (bpm: Double, anchor: Double) {
        var best = (bpm: bpm, anchor: anchor, score: Float(-1))
        for step in -60...60 {
            let candidate = bpm * (1 + Double(step) * 0.00005)
            let period = 60 * env.rate / candidate
            for shift in -8...8 {
                let position = anchor + Double(shift) * 0.25
                var phase = position.truncatingRemainder(dividingBy: period)
                if phase < 0 { phase += period }
                let score = gridScore(env.onset, period: period, phase: phase)
                if score > best.score { best = (candidate, position, score) }
            }
        }
        return (best.bpm, best.anchor)
    }

    /// Écart (s) entre la grille globale et la phase locale, fenêtre de 16 s par fenêtre de 16 s.
    /// Sert à savoir si le tempo est FIXE (production électronique) ou s'il bouge (jeu live).
    static func gridDeviations(_ env: Envelope, bpm: Double, anchor: Double) -> [Double] {
        let period = 60 * env.rate / bpm
        let size = Int(16 * env.rate)
        var result: [Double] = []
        var from = 0
        while from + size <= env.onset.count {
            if let part = slice(env, from: from, to: from + size),
               let local = localPhase(part, bpm: bpm), local.confidence >= 1.3 {
                var predicted = (anchor - Double(from)).truncatingRemainder(dividingBy: period)
                if predicted < 0 { predicted += period }
                var delta = local.phase - predicted
                delta -= (delta / period).rounded() * period
                result.append(delta / env.rate)
            }
            from += size
        }
        return result
    }

    /// Mesure du morceau : quel temps de la grille porte le « 1 », et où commencent les phrases.
    struct Meter {
        /// 0…3 : décalage (en temps) du « 1 » par rapport au 1er temps de la grille.
        var phase: Int
        /// Avance du gagnant sur le 2e (en écarts-types) : < 1 = vote serré.
        var margin: Double
        /// 0…7 : mesure (comptée depuis la 1re mesure de la grille) où commencent les phrases.
        var phraseOffset: Int?
        var phraseMargin: Double
    }

    /// VOTE SUR TOUT LE MORCEAU (un seul « 1 » partout). Trois indices, chacun évalué sur chaque
    /// temps puis moyenné par position dans la mesure (1, 2, 3 ou 4) :
    /// - changements d'ÉNERGIE (basses et aigus, 4 temps après contre 4 temps avant) : les
    ///   sections commencent sur le « 1 » ;
    /// - changements d'HARMONIE (chromagramme) : les accords changent sur le « 1 » ;
    /// - motif grosse caisse / caisse claire : grosse caisse sur le 1 (et le 3), caisse claire
    ///   sur le 2 et le 4.
    /// Chaque indice est converti en écarts-types (un indice plat ne vote pas), puis additionné.
    /// Même principe à l'échelle des mesures pour trouver les phrases de 4/8 mesures.
    static func meter(samples: [Float], low: [Float], rate: Double,
                      firstBeat: Double, beat: Double, musicStart: Double, musicEnd: Double) -> Meter? {
        guard beat > 0.2, rate > 0, samples.count == low.count else { return nil }
        let n = Int((Double(samples.count) / rate - firstBeat) / beat) - 1
        guard n >= 32 else { return nil }
        let span = max(16, Int(beat * rate))
        let quarter = max(8, Int(beat * rate / 4))
        var logLow = [Double](repeating: 0, count: n)
        var logHigh = [Double](repeating: 0, count: n)
        var attackLow = [Double](repeating: 0, count: n)
        var attackHigh = [Double](repeating: 0, count: n)
        var chroma = [[Float]](repeating: [Float](repeating: 0, count: 12), count: n)
        let extractor = ChromaExtractor(sampleRate: rate)
        // Aigus = signal − basses (calculé tranche par tranche, sans copie du morceau).
        low.withUnsafeBufferPointer { lowBuffer in
            samples.withUnsafeBufferPointer { fullBuffer in
                for b in 0..<n {
                    let s = Int(((firstBeat + Double(b) * beat) * rate).rounded())
                    logLow[b] = log(Double(AudioMath.rms(lowBuffer, from: s, count: span)) + 1e-5)
                    logHigh[b] = log(Double(AudioMath.rmsDifference(fullBuffer, lowBuffer, from: s, count: span)) + 1e-5)
                    let lowAfter = Double(AudioMath.rms(lowBuffer, from: s, count: quarter))
                    let lowBefore = Double(AudioMath.rms(lowBuffer, from: s - quarter, count: quarter))
                    attackLow[b] = log((lowAfter + 1e-5) / (lowBefore + 1e-5))
                    let highAfter = Double(AudioMath.rmsDifference(fullBuffer, lowBuffer, from: s, count: quarter))
                    let highBefore = Double(AudioMath.rmsDifference(fullBuffer, lowBuffer, from: s - quarter, count: quarter))
                    attackHigh[b] = log((highAfter + 1e-5) / (highBefore + 1e-5))
                    if let extractor { chroma[b] = extractor.chroma(fullBuffer, start: s) }
                }
            }
        }
        func valid(_ b: Int) -> Bool {
            let time = firstBeat + Double(b) * beat
            return time >= musicStart - 0.05 && time + beat <= musicEnd + 0.05
        }
        func cosineDistance(_ a: [Float], _ b: [Float]) -> Double {
            var dot: Float = 0, na: Float = 0, nb: Float = 0
            for index in 0..<12 {
                dot += a[index] * b[index]
                na += a[index] * a[index]
                nb += b[index] * b[index]
            }
            let norm = (na * nb).squareRoot()
            return norm > 0 ? Double(1 - dot / norm) : 0
        }
        func add(_ a: [Float], _ b: [Float]) -> [Float] { (0..<12).map { a[$0] + b[$0] } }

        var energy = [Double?](repeating: nil, count: n)
        var harmony = [Double?](repeating: nil, count: n)
        var groove = [Double?](repeating: nil, count: n)
        for b in 0..<n where valid(b) {
            if b >= 4, b + 4 <= n {
                var after = 0.0, before = 0.0, afterHigh = 0.0, beforeHigh = 0.0
                for k in 0..<4 {
                    after += logLow[b + k]
                    before += logLow[b - 1 - k]
                    afterHigh += logHigh[b + k]
                    beforeHigh += logHigh[b - 1 - k]
                }
                energy[b] = abs(after - before) / 4 + abs(afterHigh - beforeHigh) / 4
            }
            if b >= 2, b + 2 <= n {
                harmony[b] = cosineDistance(add(chroma[b], chroma[b + 1]), add(chroma[b - 1], chroma[b - 2]))
            }
            if b + 4 <= n {
                let backbeat = attackHigh[b + 1] + attackHigh[b + 3] - attackHigh[b] - attackHigh[b + 2]
                groove[b] = attackLow[b] + 0.5 * backbeat
            }
        }
        let energyZ = phaseScores(capped(energy), period: 4)
        let harmonyZ = phaseScores(capped(harmony), period: 4)
        let grooveZ = phaseScores(capped(groove), period: 4)
        var total = [Double](repeating: 0, count: 4)
        for phase in 0..<4 { total[phase] = energyZ[phase] + 0.8 * harmonyZ[phase] + 0.5 * grooveZ[phase] }
        let ranked = total.indices.sorted { total[$0] > total[$1] }
        let phase = ranked[0]
        var result = Meter(phase: phase, margin: total[ranked[0]] - total[ranked[1]], phraseOffset: nil, phraseMargin: 0)

        // PHRASES : même vote à l'échelle des mesures (2 mesures après contre 2 avant).
        let barCount = (n - phase) / 4
        guard barCount >= 16 else { return result }
        var barLow = [Double](repeating: 0, count: barCount)
        var barHigh = [Double](repeating: 0, count: barCount)
        var barChroma = [[Float]](repeating: [Float](repeating: 0, count: 12), count: barCount)
        for k in 0..<barCount {
            let first = phase + 4 * k
            for b in first..<(first + 4) {
                barLow[k] += logLow[b] / 4
                barHigh[k] += logHigh[b] / 4
                barChroma[k] = add(barChroma[k], chroma[b])
            }
        }
        var novelty = [Double?](repeating: nil, count: barCount)
        for k in 2..<max(2, barCount - 2) where valid(phase + 4 * k) {
            let lowChange = abs(barLow[k] + barLow[k + 1] - barLow[k - 1] - barLow[k - 2]) / 2
            let highChange = abs(barHigh[k] + barHigh[k + 1] - barHigh[k - 1] - barHigh[k - 2]) / 2
            let harmonic = cosineDistance(add(barChroma[k], barChroma[k + 1]), add(barChroma[k - 1], barChroma[k - 2]))
            novelty[k] = lowChange + highChange + 0.8 * harmonic
        }
        var four = phaseScores(capped(novelty), period: 4)
        var eight = phaseScores(capped(novelty), period: 8)
        // Indice d'appoint : la musique commence en général au début d'une phrase.
        let firstMusicBar = max(0, Int(((musicStart - firstBeat - Double(phase) * beat) / (4 * beat)).rounded(.up)))
        four[firstMusicBar % 4] += 0.75
        eight[firstMusicBar % 8] += 0.75
        let fourRanked = four.indices.sorted { four[$0] > four[$1] }
        let q = fourRanked[0]
        result.phraseOffset = eight[q] >= eight[q + 4] ? q : q + 4
        result.phraseMargin = four[fourRanked[0]] - four[fourRanked[1]]
        return result
    }

    /// Limite chaque valeur au 95e centile : un seul énorme saut (le silence du début) ne doit
    /// pas décider à lui seul.
    private static func capped(_ values: [Double?]) -> [Double?] {
        let present = values.compactMap { $0 }.sorted()
        guard present.count >= 8 else { return values }
        let ceiling = present[Int(Double(present.count - 1) * 0.95)]
        return values.map { item in item.map { min($0, ceiling) } }
    }

    /// Moyenne par position (indice modulo `period`), exprimée en écarts-types de la moyenne
    /// (score z). Un indice plat ou trop court donne 0 partout.
    private static func phaseScores(_ values: [Double?], period: Int) -> [Double] {
        var sums = [Double](repeating: 0, count: period)
        var counts = [Double](repeating: 0, count: period)
        var all: [Double] = []
        for (index, item) in values.enumerated() {
            guard let value = item else { continue }
            sums[index % period] += value
            counts[index % period] += 1
            all.append(value)
        }
        guard all.count >= period * 3 else { return [Double](repeating: 0, count: period) }
        let mean = all.reduce(0, +) / Double(all.count)
        let variance = all.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(all.count)
        let deviation = max(variance.squareRoot(), 1e-9)
        return (0..<period).map { index in
            counts[index] > 0 ? (sums[index] / counts[index] - mean) / (deviation / counts[index].squareRoot()) : 0
        }
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
    /// Volume PERÇU (filtré, fenêtré), ancienne échelle (sert encore au choix du suivant).
    var loudness: Double?
    /// Fin de l'INTRO : 1er temps fort où le morceau atteint sa pleine énergie (basses + niveau).
    /// C'est là que l'entrante doit « arriver » quand la sortante a fini de partir.
    var introEnd: Double?
    /// Début de l'OUTRO : 1er temps fort de la dernière section faible (l'énergie retombe).
    var outroStart: Double?
    /// Fin MUSICALE : fin de la dernière mesure encore pleine (≥ −10 dB). Après, ce n'est plus
    /// qu'une queue qui s'éteint : inutile de la faire entendre seule avant la suivante.
    var mixOut: Double?
    /// Version des repères de mix (les anciennes analyses sont refaites quand on en a besoin).
    var cueVersion: Int?

    // v4 — grille UNIQUE sur tout le morceau, phrases, volume par mesure, LUFS.
    /// 1er temps fort (« 1 ») de la grille globale, ≥ 0 s : la mesure 0.
    var gridOrigin: Double?
    /// Tempo fixe vérifié sur tout le morceau (sinon, recalages locaux au début et à la fin).
    var gridStable: Bool?
    /// Marge du vote du « 1 » (écarts-types) : < 1 = incertain.
    var downbeatMargin: Double?
    /// Les phrases (4/8 mesures) commencent aux mesures ≡ phraseOffset (mod 8), comptées depuis
    /// `gridOrigin`.
    var phraseOffset: Int?
    /// Volume (LUFS, pondéré K) de chaque mesure depuis `gridOrigin`.
    var barLoudness: [Float]?
    /// Volume intégré du morceau (LUFS, EBU R128).
    var lufs: Double?
    /// Crête (dBFS, mono) : borne le gain de remontée.
    var peak: Double?

    static let currentCueVersion = 4

    static let empty = TrackAnalysis(bpm: nil, confidence: 0, headDownbeat: nil, midDownbeat: nil, tailDownbeat: nil, key: nil, level: 0, start: 0, end: nil, loudness: nil)

    var hasGrid: Bool { bpm != nil }
}

// MARK: - Lecture de la grille (pour le planificateur)

extension TrackAnalysis {
    var barLength: Double? { bpm.map { 240 / $0 } }

    /// Ancre (temps fort) la plus proche d'un instant : début, milieu, fin ou origine de grille.
    /// Toutes portent le même « 1 » ; la plus proche absorbe une éventuelle dérive de tempo.
    func anchor(near time: Double) -> Double? {
        let candidates = [headDownbeat, midDownbeat, tailDownbeat, gridOrigin].compactMap { $0 }
        return candidates.min { abs($0 - time) < abs($1 - time) }
    }

    /// Temps fort de la grille près d'un instant (arrondi au choix : avant, après, au plus près).
    func downbeat(near time: Double, _ rule: FloatingPointRoundingRule) -> Double? {
        guard let bar = barLength, let anchor = anchor(near: time) else { return nil }
        return anchor + ((time - anchor) / bar).rounded(rule) * bar
    }

    /// Numéro de mesure (depuis l'origine de la grille) d'un temps fort.
    func barIndex(at time: Double) -> Int? {
        guard let bar = barLength, let origin = gridOrigin ?? anchor(near: 0) else { return nil }
        return Int(((time - origin) / bar).rounded())
    }

    /// Nombre de mesures (0…3) depuis le dernier début de phrase de 4 mesures. Sans phrases
    /// détectées (ancienne analyse) : phrases comptées depuis le temps fort du début.
    func barsIntoPhrase(at time: Double) -> Int? {
        guard let index = barIndex(at: time) else { return nil }
        let origin: Int
        if let offset = phraseOffset {
            origin = offset
        } else if let head = headDownbeat ?? midDownbeat, let headIndex = barIndex(at: head) {
            origin = headIndex
        } else {
            return nil
        }
        return ((index - origin) % 4 + 4) % 4
    }

    /// Volume (LUFS) moyen en puissance d'une zone, mesure par mesure.
    func regionLoudness(from: Double, to: Double) -> Double? {
        guard let bars = barLoudness, !bars.isEmpty, let bar = barLength, let origin = gridOrigin, to > from else { return nil }
        let first = max(0, Int(((from - origin) / bar).rounded(.down)))
        let last = min(bars.count - 1, Int(((to - origin) / bar).rounded(.up)) - 1)
        guard last >= first else { return nil }
        var power = 0.0
        for index in first...last { power += pow(10, Double(bars[index]) / 10) }
        return 10 * log10(power / Double(last - first + 1))
    }

    /// Volume du « cœur » du morceau : 70e centile des mesures.
    var coreLoudness: Double? {
        guard let bars = barLoudness, bars.count >= 4 else { return nil }
        let sorted = bars.sorted()
        return Double(sorted[Int(Double(sorted.count - 1) * 0.7)])
    }

    /// Résumé lisible pour le journal de diagnostic.
    var summary: String {
        func f(_ value: Double, _ digits: Int = 1) -> String { String(format: "%.\(digits)f", value) }
        guard let bpm else { return "pas de rythme détecté (fondu simple)" + (lufs.map { ", \(f($0)) LUFS" } ?? "") }
        var parts = ["\(f(bpm, 2)) BPM (confiance \(f(confidence, 2)))"]
        if cueVersion != Self.currentCueVersion { parts.append("ancienne analyse v\(cueVersion ?? 0)") }
        if let gridStable { parts.append(gridStable ? "tempo fixe" : "tempo variable (recalages locaux)") }
        if let origin = gridOrigin { parts.append("« 1 » à \(f(origin, 3)) s (vote, marge \(f(downbeatMargin ?? 0)))") }
        if let phraseOffset { parts.append("phrases depuis la mesure \(phraseOffset)") }
        if let introEnd { parts.append("fin d'intro \(f(introEnd)) s") }
        if let outroStart { parts.append("outro \(f(outroStart)) s") }
        if let mixOut { parts.append("fin musicale \(f(mixOut)) s") }
        if let label = AudioMath.camelotLabel(key) { parts.append("tonalité \(label)") }
        if let lufs { parts.append("\(f(lufs)) LUFS") }
        return parts.joined(separator: ", ")
    }
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

    /// Toutes les analyses déjà faites (sauvegardées) : le choix du morceau suivant connaît
    /// immédiatement le BPM et la tonalité de tout ce qui a déjà été analysé.
    func allCached() -> [UUID: TrackAnalysis] { cache }

    func analysis(of track: Track) -> TrackAnalysis {
        if let hit = cache[track.id], hit.cueVersion == TrackAnalysis.currentCueVersion { return hit }
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

    /// Analyse COMPLÈTE d'un morceau (tout le fichier, mono ~11 kHz).
    private static func analyze(url: URL) -> TrackAnalysis {
        guard let file = try? AVAudioFile(forReading: url) else { return .empty }
        let fileRate = file.processingFormat.sampleRate
        guard fileRate > 0, file.length > 0 else { return .empty }
        let total = Double(file.length) / fileRate
        // Morceaux longs (> 6 min) lus à ~5,5 kHz : la mémoire reste raisonnable (le rythme, les
        // basses, l'harmonie jusqu'à 2 kHz et le volume perçu restent mesurables). Au-delà de
        // 20 min (mix, podcast), seul le début est analysé : pas de repères de fin.
        let target = total > 360 ? 5_512.5 : 11_025.0
        guard let whole = readMono(file: file, targetRate: target, maxSeconds: 1200) else { return .empty }
        let samples = whole.samples
        let rate = whole.rate
        let covered = Double(samples.count) / rate
        let truncated = covered < total - 1

        func excerpt(from start: Double, seconds: Double) -> [Float] {
            let lo = max(0, min(samples.count, Int(start * rate)))
            let hi = max(lo, min(samples.count, Int((start + seconds) * rate)))
            return Array(samples[lo..<hi])
        }
        // Trois repères : début (intro, silence), milieu (tempo, tonalité, niveau), fin.
        let head = excerpt(from: 0, seconds: 45)
        let middleStart = min(max(0, covered - 45), max(20, covered * 0.3))
        let middle = excerpt(from: middleStart, seconds: 45)
        let tailStart = max(0, covered - 45)
        let tail = excerpt(from: tailStart, seconds: 45)

        let reference = middle.count > Int(rate * 8) ? middle : head
        let level = AudioMath.rms(reference)
        let lowLevel = AudioMath.rms(AudioMath.lowPassed(reference, sampleRate: rate))
        let threshold = Float(max(0.004, level * 0.08))

        var result = TrackAnalysis.empty
        result.cueVersion = TrackAnalysis.currentCueVersion
        result.level = level
        let perceived = AudioMath.perceivedLoudness(samples: reference, sampleRate: rate)
        if perceived > 0 { result.loudness = perceived }
        let weighted = AudioMath.kWeighted(samples, sampleRate: rate)
        result.lufs = AudioMath.integratedLoudness(weighted: weighted, sampleRate: rate)
        var peak: Float = 0
        vDSP_maxmgv(samples, 1, &peak, vDSP_Length(samples.count))
        if peak > 0 { result.peak = 20 * log10(Double(peak)) }
        result.start = AudioMath.firstLoud(samples: head, sampleRate: rate, threshold: threshold, limit: 8)
        let lastLoud = AudioMath.lastLoud(samples: tail, sampleRate: rate, threshold: threshold)
        let candidateEnd = tailStart + lastLoud
        if !truncated, candidateEnd > total * 0.5, candidateEnd < total - 0.3 { result.end = candidateEnd }
        result.key = KeyDetector.estimate(samples: reference, sampleRate: rate)

        // TEMPO : grossier sur le cœur (45 s), puis affiné sur tout le morceau.
        guard let env = BeatAnalysis.envelope(samples, sampleRate: rate) else { return result }
        let middleFrom = Int(middleStart * env.rate)
        guard let middleEnv = BeatAnalysis.slice(env, from: middleFrom, to: middleFrom + Int(45 * env.rate)),
              let tempo = BeatAnalysis.tempo(middleEnv), tempo.confidence >= 1.25 else { return result }
        let refined = BeatAnalysis.refineWhole(env, bpm: tempo.bpm, anchor: Double(middleFrom) + tempo.phase)
        let bpm = refined.bpm
        let beat = 60 / bpm
        let bar = 4 * beat
        result.bpm = bpm
        result.confidence = tempo.confidence

        // Tempo fixe ? (fenêtres à contretemps — intro de charleston, syncopes — ignorées : ce
        // n'est pas une dérive, juste une fenêtre sans temps marqués.)
        let deviations = BeatAnalysis.gridDeviations(env, bpm: bpm, anchor: refined.anchor)
            .filter { abs($0) < 0.3 * beat }
        let stable: Bool = {
            guard deviations.count >= 3 else { return true }
            let sorted = deviations.map { abs($0) }.sorted()
            let median = sorted[sorted.count / 2]
            let close = Double(sorted.filter { $0 < 0.03 }.count) / Double(sorted.count)
            return median < 0.012 && close >= 0.75
        }()
        result.gridStable = stable

        var firstBeat = (refined.anchor / env.rate).truncatingRemainder(dividingBy: beat)
        if firstBeat < 0 { firstBeat += beat }

        // « 1 » DE MESURE et PHRASES : vote sur tout le morceau.
        let low = AudioMath.lowPassed(samples, sampleRate: rate)
        let musicEnd = result.end ?? covered
        let meter = BeatAnalysis.meter(samples: samples, low: low, rate: rate,
                                       firstBeat: firstBeat, beat: beat, musicStart: result.start, musicEnd: musicEnd)
        let phase: Int
        if let meter {
            phase = meter.phase
            result.downbeatMargin = meter.margin
            result.phraseOffset = meter.phraseOffset
        } else {
            // Morceau trop court pour voter : ancienne méthode (grosse caisse la plus forte).
            let offset = BeatAnalysis.downbeatOffset(middleEnv, bpm: tempo.bpm, phase: tempo.phase)
            let time = Double(middleFrom) / env.rate + (tempo.phase + Double(offset) * 60 * env.rate / tempo.bpm) / env.rate
            phase = ((Int(((time - firstBeat) / beat).rounded()) % 4) + 4) % 4
        }
        let origin = firstBeat + Double(phase) * beat
        result.gridOrigin = origin

        // Ancres début / milieu / fin : sur la grille globale ; si le tempo bouge, recalées sur la
        // phase locale (même « 1 », jamais plus d'un tiers de temps).
        func gridDownbeat(atOrAfter time: Double) -> Double {
            origin + max(0, ((time - origin) / bar).rounded(.up)) * bar
        }
        func localized(_ time: Double) -> Double {
            guard !stable else { return time }
            let from = max(0, Int((time - 12) * env.rate))
            guard let part = BeatAnalysis.slice(env, from: from, to: Int((time + 18) * env.rate)),
                  let local = BeatAnalysis.localPhase(part, bpm: bpm), local.confidence >= 1.2 else { return time }
            let period = 60 * env.rate / bpm
            var predicted = (time * env.rate - Double(from)).truncatingRemainder(dividingBy: period)
            if predicted < 0 { predicted += period }
            var delta = local.phase - predicted
            delta -= (delta / period).rounded() * period
            let seconds = delta / env.rate
            return abs(seconds) <= beat / 3 ? time + seconds : time
        }
        result.headDownbeat = localized(gridDownbeat(atOrAfter: max(0, result.start - 0.05)))
        result.midDownbeat = gridDownbeat(atOrAfter: middleStart)
        if !truncated { result.tailDownbeat = localized(gridDownbeat(atOrAfter: tailStart)) }

        // ÉNERGIE MESURE PAR MESURE (plein spectre, basses, volume perçu LUFS).
        var fullBars: [Double] = []
        var lowBars: [Double] = []
        var loudBars: [Float] = []
        let barSamples = Int((bar * rate).rounded())
        samples.withUnsafeBufferPointer { fullBuffer in
            low.withUnsafeBufferPointer { lowBuffer in
                weighted.withUnsafeBufferPointer { weightedBuffer in
                    var index = 0
                    while true {
                        let from = Int(((origin + Double(index) * bar) * rate).rounded())
                        if from + barSamples > fullBuffer.count { break }
                        fullBars.append(Double(AudioMath.rms(fullBuffer, from: from, count: barSamples)))
                        lowBars.append(Double(AudioMath.rms(lowBuffer, from: from, count: barSamples)))
                        let loud = AudioMath.shortLoudness(weightedBuffer, from: from, count: barSamples)
                        loudBars.append(Float((loud * 10).rounded() / 10))
                        index += 1
                    }
                }
            }
        }
        if !loudBars.isEmpty { result.barLoudness = loudBars }

        // REPÈRES DE MIX (comme un DJ), recalés sur les PHRASES (4 mesures) :
        //  - fin d'intro : 1re mesure ≥ 70 % du niveau ET ≥ 55 % des basses du cœur, qui tient ;
        //  - début d'outro : 1re mesure de la dernière série de mesures faibles ;
        //  - fin musicale : fin de la dernière mesure encore ≥ 30 % du niveau (−10 dB).
        func barTime(_ index: Int) -> Double { origin + Double(index) * bar }
        func isPhraseStart(_ index: Int) -> Bool {
            let offset = result.phraseOffset ?? 0
            return ((index - offset) % 4 + 4) % 4 == 0
        }
        func snapToPhrase(_ index: Int) -> Int {
            for delta in [0, -1, 1] where index + delta >= 0 && isPhraseStart(index + delta) { return index + delta }
            return index
        }
        guard level > 0, lowLevel > 0, !fullBars.isEmpty else { return result }
        for index in fullBars.indices {
            let time = barTime(index)
            guard time >= result.start - 0.05 else { continue }
            if time > min(90, total * 0.5) { break }
            let full = fullBars[index] >= 0.7 * level && lowBars[index] >= 0.55 * lowLevel
            let holds = index + 1 >= fullBars.count || fullBars[index + 1] >= 0.6 * level
            if full && holds {
                result.introEnd = barTime(index >= 3 ? snapToPhrase(index) : index)
                break
            }
        }
        guard !truncated else { return result }
        let usable = fullBars.indices.filter { barTime($0) + bar <= musicEnd + bar * 0.5 }
        if let lastFull = usable.last(where: { fullBars[$0] >= 0.3 * level }) {
            let candidate = barTime(lastFull) + bar
            if candidate > total * 0.5 { result.mixOut = min(candidate, result.end ?? total) }
        }
        if var index = usable.last {
            let last = index
            while index >= 0, barTime(index) > total * 0.5,
                  fullBars[index] < 0.55 * level || lowBars[index] < 0.4 * lowLevel { index -= 1 }
            let weakCount = last - index
            if weakCount >= 2, index + 1 <= last {
                let start = barTime(snapToPhrase(index + 1))
                if start > total * 0.5 { result.outroStart = start }
            }
        }
        return result
    }

    /// Lit TOUT le fichier (par blocs, jamais tout en mémoire en pleine résolution) en mono
    /// (moyenne des canaux) à ~`targetRate`, avec un filtre de moyenne contre le repliement.
    private static func readMono(file: AVAudioFile, targetRate: Double, maxSeconds: Double) -> (samples: [Float], rate: Double)? {
        let format = file.processingFormat
        let rate = format.sampleRate
        guard rate > 0 else { return nil }
        let step = max(1, Int((rate / targetRate).rounded()))
        let totalFrames = min(file.length, AVAudioFramePosition(maxSeconds * rate))
        guard totalFrames > 0 else { return nil }
        let chunkFrames = AVAudioFrameCount(step * 65_536)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return nil }
        let channels = max(1, Int(format.channelCount))
        let scale = 1 / Float(step * channels)
        var output: [Float] = []
        output.reserveCapacity(Int(totalFrames) / step + 1)
        file.framePosition = 0
        var position: AVAudioFramePosition = 0
        while position < totalFrames {
            let wanted = AVAudioFrameCount(min(AVAudioFramePosition(chunkFrames), totalFrames - position))
            do { try file.read(into: buffer, frameCount: wanted) } catch { break }
            let length = Int(buffer.frameLength)
            guard length > 0, let data = buffer.floatChannelData else { break }
            let count = length / step
            var chunk = [Float](repeating: 0, count: count)
            for channel in 0..<channels {
                let source = data[channel]
                for index in 0..<count {
                    var sum: Float = 0
                    let base = index * step
                    for offset in 0..<step { sum += source[base + offset] }
                    chunk[index] += sum * scale
                }
            }
            output.append(contentsOf: chunk)
            position += AVAudioFramePosition(length)
        }
        return output.count > 16 ? (output, rate / Double(step)) : nil
    }
}

// MARK: - Planification d'une transition

/// Une transition prête à jouer.
///
/// Déroulé d'un mix calé (comme AutoMix d'Apple Music et un DJ) :
/// - les deux morceaux JOUENT ENSEMBLE ; l'un monte pendant que l'autre descend (volume) ;
/// - CROISEMENT DE TEMPO : pendant tout le chevauchement, un tempo COMMUN glisse en courbe en S
///   du tempo de la sortante B₁ vers celui de l'entrante B₂ : B(t) = B₁ + (B₂ − B₁)·s(t),
///   s(u) = 3u² − 2u³. La sortante va de ×1 vers ×B₂/B₁ ; l'entrante part à ×B₁/B₂ et revient à
///   ×1. À chaque instant, les deux ont le MÊME tempo : jamais de « double frappe » ;
/// - SORTIE et ENTRÉE sur des débuts de PHRASE (4/8 mesures) : les structures se superposent ;
/// - EQ DJ 3 bandes par platine : l'entrante arrive basses coupées, médiums et aigus en retrait ;
///   ÉCHANGE DES BASSES pile sur le « 1 » du milieu ; la sortante perd ensuite médiums et aigus ;
/// - VOLUMES équilibrés : zone de sortie et zone d'entrée mesurées (LUFS mesure par mesure), la
///   plus forte est retenue ; un limiteur sur la sortie empêche toute saturation ;
/// - le chevauchement se termine quand la sortante finit musicalement ET que l'entrante sort de
///   son intro (alignement « fin d'outro = fin d'intro », comme Mixxx « Full Intro + Outro »).
struct MixPlan: Sendable {
    enum Style: Sendable {
        /// Mix calé : temps alignés, tempo accordé, bass swap.
        case beatmix
        /// Tempos incompatibles : fondu avec filtre passe-haut sur la sortante, passe-bas qui
        /// s'ouvre sur l'entrante.
        case filter
        /// Rythme non détecté : fondu à puissance constante.
        case crossfade
        /// Même album : enchaînement sans aucun blanc, sans fondu (comme Apple).
        case gapless
        /// Même morceau qui se répète : le « 1 » du début retombe PILE sur un temps fort de la
        /// fin (fin de phrase), la queue de la fin s'efface dessous.
        case loop
    }

    var style: Style
    /// Position (secondes) de la SORTANTE où démarre l'entrante.
    var exitAt: Double
    /// Position (secondes) de l'ENTRANTE à laquelle elle démarre.
    var entryAt: Double
    /// Durée du chevauchement (secondes réelles).
    var length: Double
    /// R = tempo de l'entrante / tempo de la sortante (demi/double tempo compris) : vitesse
    /// d'ARRIVÉE de la sortante. Vitesse de l'entrante = vitesse de la sortante / R.
    var outRate: Double
    /// Durée réelle (s) de la rampe de tempo de la sortante, qui se TERMINE au point de sortie.
    var rampLength: Double
    var levelGain: Double
    var bassSwap: Bool
    /// Nombre de mesures du chevauchement (0 si non calé).
    var bars: Int
    /// Durée d'une mesure de la sortante (s) : sert à décaler la sortie d'un nombre entier de
    /// mesures si l'automix démarre en retard (0 = inconnue).
    var outBar: Double = 0
    /// Fraction MUSICALE du chevauchement où se fait l'échange des basses (0,5 = mesure du milieu).
    var swapAt: Double = 0.5
    /// Atténuation (dB, ≤ 0) de la sortante pendant le mix (zone de sortie plus forte).
    var outTrim: Double = 0
    /// Atténuation (dB, ≤ 0) de l'entrante au début du mix, rendue progressivement.
    var inTrim: Double = 0
    /// Tonalités qui jurent : médiums de l'entrante plus en retrait jusqu'à l'échange.
    var clash: Bool = false
    /// Boucle : durée (s) entre le départ de l'entrante et son « 1 » (levée + 5 ms d'attaque).
    var lead: Double = 0
    /// Boucle : l'entrante monte en fondu pendant la levée (sinon elle part à plein volume).
    var fadeIn: Bool = false
    /// Sortie et entrée tombent sur des débuts de phrase.
    var phraseAligned: Bool = false
    /// Résumé des décisions (journal de diagnostic).
    var note: String = ""

    /// Position de la sortante où commence la rampe (= où l'automix se met en route).
    /// Vitesse r(t) = 1 + (r − 1)·s(t/D), s(u) = 3u² − 2u³ : la position avance de D·(1 + r)/2.
    var rampStart: Double { exitAt - rampLength * (1 + outRate) / 2 }
}

enum MixPlanner {
    /// Écart de tempo maximal pour un mix calé (chacun n'est étiré que quand il est le plus
    /// discret). Au-delà de ~8 %, l'étirement s'entend : fondu filtré.
    static let maxStretch = 0.08

    private static func f(_ value: Double, _ digits: Int = 1) -> String { String(format: "%.\(digits)f", value) }

    static func plan(
        out: TrackAnalysis, outDuration: Double,
        into incoming: TrackAnalysis,
        sameAlbum: Bool, sameTrack: Bool = false, beats: Int, seconds: Double, beatMatch: Bool
    ) -> MixPlan {
        // Fin MUSICALE de la sortante : on ne fait pas entendre seule une queue qui s'éteint.
        let realEnd = min(outDuration, out.end ?? outDuration)
        let outEnd = min(realEnd, out.mixOut ?? realEnd)
        let inStart = min(max(0, incoming.start), 8)

        if sameTrack {
            return loopPlan(out: out, outDuration: outDuration, realEnd: realEnd, outEnd: outEnd,
                            inStart: inStart, beatMatch: beatMatch)
        }
        if sameAlbum {
            return MixPlan(style: .gapless, exitAt: outDuration, entryAt: 0, length: 0,
                           outRate: 1, rampLength: 0, levelGain: 1, bassSwap: false, bars: 0,
                           note: "même album : enchaînement sans blanc")
        }
        let gain = AudioMath.loudnessGain(outgoing: out.level, incoming: incoming.level)

        if beatMatch, let outBPM = out.bpm, let inBPM = incoming.bpm {
            // Vitesse de la sortante pour atteindre le tempo de l'entrante (demi/double compris).
            let outRate = 1 / AudioMath.tempoRatio(outgoing: outBPM, incoming: inBPM)
            let inBar = 240 / inBPM
            let entry0 = firstDownbeat(incoming, after: inStart, bar: inBar) ?? inStart
            if abs(log(outRate)) <= maxStretch {
                return beatPlan(out: out, outDuration: outDuration, realEnd: realEnd, outEnd: outEnd,
                                into: incoming, entry0: entry0, outBPM: outBPM, inBar: inBar,
                                outRate: outRate, beats: beats, gain: gain)
            }
            return filterPlan(outEnd: outEnd, outBPM: outBPM, out: out, entry: entry0, seconds: seconds, gain: gain,
                              note: "tempos trop éloignés (\(f(outBPM)) → \(f(inBPM)) BPM, écart \(f(abs(outRate - 1) * 100)) %) : fondu filtré")
        }

        let length = min(seconds, max(1, outEnd * 0.25))
        return MixPlan(style: .crossfade, exitAt: max(0, outEnd - length), entryAt: inStart, length: length,
                       outRate: 1, rampLength: 0, levelGain: gain, bassSwap: true, bars: 0,
                       note: beatMatch ? "rythme non détecté : fondu à puissance constante" : "mix calé désactivé : fondu")
    }

    /// 1er temps fort de l'entrante APRÈS son silence d'intro.
    private static func firstDownbeat(_ analysis: TrackAnalysis, after inStart: Double, bar: Double) -> Double? {
        guard let value = analysis.downbeat(near: inStart - 0.02, .up) else { return nil }
        return value >= -0.02 && value <= inStart + bar ? max(0, value) : nil
    }

    private static func beatPlan(out: TrackAnalysis, outDuration: Double, realEnd: Double, outEnd: Double,
                                 into incoming: TrackAnalysis, entry0: Double, outBPM: Double, inBar: Double,
                                 outRate: Double, beats: Int, gain: Double) -> MixPlan {
        let outBar = 4 * 60 / outBPM
        // Une mesure de l'ENTRANTE (calée), en secondes de son propre fichier.
        let inSpanPerBar = outBar / outRate
        var notes: [String] = []

        // LONGUEUR : celle choisie (2 / 4 / 8 mesures), allongée (jusqu'au double, 16 mesures
        // maximum) quand l'outro ET l'intro sont longues, raccourcie quand ça risque de jurer.
        var bars = max(2, beats / 4)
        let distance = AudioMath.harmonicDistance(out.key, incoming.key)
        let clash = (distance ?? 0) >= 3
        let hotOut = out.outroStart.map { (outEnd - $0) < 2 * outBar } ?? true
        let hotIn = incoming.introEnd.map { ($0 - entry0) < 2 * inSpanPerBar } ?? false
        if let distance, distance > 1 {
            bars = max(2, bars / 2)
            notes.append("tonalités \(AudioMath.camelotLabel(out.key) ?? "?") → \(AudioMath.camelotLabel(incoming.key) ?? "?") éloignées : mix raccourci")
        } else if hotOut && hotIn {
            bars = max(2, min(bars, 4))
            notes.append("fin et début pleins (pas d'outro ni d'intro) : mix court")
        } else if let outro = out.outroStart, let intro = incoming.introEnd {
            let outroBars = Int(((outEnd - outro) / outBar).rounded(.down))
            let introBars = Int(((intro - entry0) / inSpanPerBar).rounded(.down))
            let room = min(outroBars, introBars, bars * 2, 16)
            if room > bars {
                bars = room >= 4 ? room - room % 4 : room - room % 2
                notes.append("outro \(outroBars) / intro \(introBars) mesures : blend long")
            }
        }
        if abs(log(outRate)) > 0.06, bars > 4 {
            bars = 4
            notes.append("écart de tempo \(f(abs(outRate - 1) * 100)) % : mix court")
        }

        // SORTIE : le chevauchement finit à la fin musicale de la sortante, et commence sur un
        // DÉBUT DE PHRASE (au plus 2 mesures plus tôt, ou plus tard si la fin le permet).
        var exit = outEnd - Double(bars) * outBar
        if let snapped = out.downbeat(near: exit, .down) { exit = snapped }
        var phraseOut = false
        if let into = out.barsIntoPhrase(at: exit) {
            let laterFits: (Int) -> Bool = { shift in
                exit + Double(bars + shift) * outBar <= realEnd + 0.5 * outBar
            }
            switch into {
            case 0:
                phraseOut = true
            case 1:
                exit -= outBar
                phraseOut = true
            case 2:
                if laterFits(2) { exit += 2 * outBar } else { exit -= 2 * outBar }
                phraseOut = true
            default:
                if laterFits(1) { exit += outBar } else { exit -= 3 * outBar }
                phraseOut = true
            }
        }
        // Jamais plus de 8 mesures / 15 s de musique coupées après le chevauchement (première
        // plainte contre AutoMix d'Apple) : sortie repoussée d'autant de mesures que nécessaire.
        let maxCut = min(8 * outBar, 15)
        while realEnd - (exit + Double(bars) * outBar) > maxCut + 0.01, exit + Double(bars + 1) * outBar <= realEnd + 0.01 {
            exit += outBar
            phraseOut = out.barsIntoPhrase(at: exit) == 0
        }
        exit = max(outDuration * 0.4, exit)
        bars = max(2, min(bars, Int(((outDuration - 0.05 - exit) / outBar).rounded(.down))))
        // Durée réelle : le tempo commun vaut en moyenne (B₁ + B₂)/2 sur une courbe en S,
        // donc L = mesures × mesure₁ × 2 / (1 + R).
        let length = Double(bars) * outBar * 2 / (1 + outRate)
        // Ce que l'entrante parcourt de son fichier pendant ce temps : mesures × mesure₂.
        let inSpan = Double(bars) * inSpanPerBar

        // ENTRÉE : l'intro de l'entrante se termine quand la sortante a fini de partir. Sans
        // intro détectée : 1er temps fort après le silence. Jamais plus de 8 mesures d'intro
        // sautées (deuxième plainte contre AutoMix : « il saute le début »). Puis début de phrase.
        var entry = entry0
        if let intro = incoming.introEnd {
            let target = intro - inSpan
            if target > entry0 {
                let snapped = entry0 + ((target - entry0) / inBar).rounded() * inBar
                entry = min(snapped, entry0 + 8 * inBar)
            }
        }
        var phraseIn = false
        if let into = incoming.barsIntoPhrase(at: entry) {
            if into == 0 {
                phraseIn = true
            } else if into <= 2, entry - Double(into) * inBar >= entry0 - 0.01 {
                entry -= Double(into) * inBar
                phraseIn = true
            } else if entry + Double(4 - into) * inBar <= entry0 + 8 * inBar + 0.01 {
                entry += Double(4 - into) * inBar
                phraseIn = true
            }
        }

        // ÉQUILIBRE DES VOLUMES : énergie de la zone de sortie et de la zone d'entrée, chacune
        // rapportée au cœur de son morceau (les cœurs sont déjà au même volume). On corrige la
        // MOITIÉ de l'écart, en baissant la plus forte (jamais de remontée : pas de saturation).
        var outTrim = 0.0
        var inTrim = 0.0
        if let outRegion = out.regionLoudness(from: exit, to: exit + Double(bars) * outBar), let outCore = out.coreLoudness,
           let inRegion = incoming.regionLoudness(from: entry, to: entry + inSpan), let inCore = incoming.coreLoudness {
            let dOut = outRegion - outCore
            let dIn = inRegion - inCore
            let balance = max(-8, min(8, dOut - dIn))
            if balance > 1 {
                outTrim = -min(3, balance * 0.5)
            } else if balance < -1 {
                inTrim = -min(4.5, -balance * 0.5)
            }
            notes.append("énergie sortie \(f(dOut)) dB / entrée \(f(dIn)) dB → sortante \(f(outTrim)) dB, entrante \(f(inTrim)) dB")
        }
        if clash { notes.append("médiums de l'entrante en retrait jusqu'à l'échange") }
        notes.insert("\(bars) mesures, phrase sortie \(phraseOut ? "✓" : "✗") / entrée \(phraseIn ? "✓" : "✗")", at: 0)

        return MixPlan(style: .beatmix, exitAt: exit, entryAt: max(0, entry), length: length,
                       outRate: abs(log(outRate)) < 0.0005 ? 1 : outRate, rampLength: 0,
                       levelGain: gain, bassSwap: true, bars: bars, outBar: outBar,
                       swapAt: 0.5, outTrim: outTrim, inTrim: inTrim, clash: clash,
                       phraseAligned: phraseOut && phraseIn, note: notes.joined(separator: " ; "))
    }

    /// RÉPÉTER CE TITRE : boucle « sans couture ». Le 1er temps fort du morceau retombe PILE sur un
    /// temps fort de la fin — de préférence un nombre entier de phrases (8, sinon 4 mesures) après
    /// le début, au plus près de la fin musicale. La levée éventuelle (≤ 1 mesure avant le « 1 »)
    /// part juste avant ; la queue de la fin s'efface en 2 temps sous le nouveau départ. Pas de
    /// changement de tempo (même morceau), pas d'effet : on n'entend ni redémarrage ni doublon.
    private static func loopPlan(out: TrackAnalysis, outDuration: Double, realEnd: Double, outEnd: Double,
                                 inStart: Double, beatMatch: Bool) -> MixPlan {
        guard beatMatch, let bpm = out.bpm, let bar = out.barLength,
              let landing = firstDownbeat(out, after: inStart, bar: bar),
              let firstIndex = out.barIndex(at: landing) else {
            let length = 1.5
            let exit = max(outDuration * 0.5, realEnd - length)
            return MixPlan(style: .loop, exitAt: exit, entryAt: inStart,
                           length: max(0.5, min(length, outDuration - exit - 0.02)),
                           outRate: 1, rampLength: 0, levelGain: 1, bassSwap: false, bars: 0,
                           fadeIn: true, note: "boucle sans grille : fondu de 1,5 s")
        }
        let beat = 60 / bpm
        let pickup = landing - inStart
        let lead = pickup > 0.03 && pickup < bar ? pickup : min(0.005, landing)

        var best: (time: Double, score: Double)?
        var candidate = out.downbeat(near: outEnd - 2 * bar, .up) ?? outEnd
        let limit = min(realEnd - 0.05, outEnd + bar + 0.01)
        while candidate <= limit {
            if candidate > outDuration * 0.5, let index = out.barIndex(at: candidate) {
                let barsFromStart = ((index - firstIndex) % 8 + 8) % 8
                var score = -abs(candidate - outEnd) / bar
                if barsFromStart == 0 { score += 2 } else if barsFromStart == 4 { score += 1 }
                if let current = best, score <= current.score {
                    // garde le meilleur
                } else {
                    best = (candidate, score)
                }
            }
            candidate += bar
        }
        let target = best?.time ?? (out.downbeat(near: outEnd, .down) ?? outEnd)
        let fade = max(0.05, min(2 * beat, outDuration - target - 0.02))
        let phrase = out.barIndex(at: target).map { (($0 - firstIndex) % 4 + 4) % 4 == 0 } ?? false
        return MixPlan(style: .loop, exitAt: target - lead, entryAt: max(0, landing - lead), length: lead + fade,
                       outRate: 1, rampLength: 0, levelGain: 1, bassSwap: false, bars: 0, outBar: bar,
                       lead: lead, fadeIn: lead > beat, phraseAligned: phrase,
                       note: "boucle : « 1 » du début (\(f(landing, 2)) s) posé sur le temps fort \(f(target, 2)) s\(phrase ? " (phrase)" : ""), levée \(f(pickup > 0.03 && pickup < bar ? pickup * 1000 : 0, 0)) ms, queue effacée en \(f(fade, 2)) s")
    }

    /// Tempos trop éloignés : fondu filtré court (≤ 6 s), sortie sur un temps, entrée sur le
    /// 1er temps fort après le silence.
    private static func filterPlan(outEnd: Double, outBPM: Double, out: TrackAnalysis, entry: Double, seconds: Double,
                                   gain: Double, note: String) -> MixPlan {
        let beat = 60 / outBPM
        let length = min(seconds, 6)
        var exit = outEnd - length
        if let anchor = out.anchor(near: exit) {
            exit = anchor + ((exit - anchor) / beat).rounded(.down) * beat
        }
        return MixPlan(style: .filter, exitAt: max(0, exit), entryAt: max(0, entry), length: length,
                       outRate: 1, rampLength: 0, levelGain: gain, bassSwap: false, bars: 0, note: note)
    }
}
