import Accelerate
import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Fréquences des 10 bandes de l'égaliseur (Hz). Constante globale : lisible de partout.
let equalizerBandFrequencies: [Double] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/// Clés de sauvegarde des réglages du lecteur (UserDefaults).
fileprivate enum Keys {
    static let automix = "player.automix"
    static let mixLength = "player.mixLength"
    static let beatMatched = "player.beatMatched"
    static let repeatMode = "player.repeat"
    static let shuffle = "player.shuffle"
    static let history = "player.history"
    static let eqEnabled = "eq.enabled"
    static let eqGains = "eq.gains"
    static let eqPreamp = "eq.preamp"
    static let eqPreset = "eq.preset"
    static let eqCustom = "eq.custom"
    static let eqAutoHeadroom = "eq.autoHeadroom"
}

/// Horloge système en secondes (même base que les `hostTime` d'AVAudioTime).
fileprivate func hostNow() -> Double {
    AVAudioTime.seconds(forHostTime: mach_absolute_time())
}

/// Spectre audio en temps réel (visualiseur). Objet séparé : seule la vue du visualiseur
/// l'observe, rien d'autre ne se redessine 30 fois par seconde.
@MainActor
final class SpectrumModel: ObservableObject {
    static let bandCount = 28
    @Published var bands: [Float] = Array(repeating: 0, count: 28)
}

/// Lecteur audio natif, sur `AVAudioEngine`.
///
///     platine A ─► timePitch A ─► FX A (bass swap / filtre) ─┐
///                                                            ├─► mixeur ─► EQ 10 bandes ─► sortie
///     platine B ─► timePitch B ─► FX B (bass swap / filtre) ─┘
///
/// AUTOMIX : chaque morceau est analysé (tempo au centième, grille de temps forts recalée au début
/// et à la fin, tonalité, niveau, silences). Le planificateur choisit la transition (mix calé +
/// bass swap, fondu filtré, fondu simple, ou enchaînement sans blanc pour un album), et
/// l'entrante démarre À L'ÉCHANTILLON PRÈS sur un temps fort de la sortante (horloge du moteur).
@MainActor
final class Player: NSObject, ObservableObject {
    // MARK: - Lecture des réglages

    nonisolated private static func storedDouble(_ key: String, _ fallback: Double) -> Double {
        UserDefaults.standard.object(forKey: key) as? Double ?? fallback
    }

    nonisolated private static func storedBool(_ key: String, _ fallback: Bool) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? fallback
    }

    nonisolated private static func storedRepeat() -> RepeatMode {
        RepeatMode(rawValue: UserDefaults.standard.string(forKey: Keys.repeatMode) ?? "") ?? .all
    }

    nonisolated private static func storedMixLength() -> MixLength {
        MixLength(rawValue: UserDefaults.standard.string(forKey: Keys.mixLength) ?? "") ?? .normal
    }

    nonisolated private static func storedGains() -> [Double] {
        let count = equalizerBandFrequencies.count
        let saved = UserDefaults.standard.array(forKey: Keys.eqGains) as? [Double] ?? []
        return saved.count == count ? saved : Array(repeating: 0, count: count)
    }

    nonisolated private static func storedCustomPresets() -> [String: [Double]] {
        guard let data = UserDefaults.standard.data(forKey: Keys.eqCustom),
              let map = try? JSONDecoder().decode([String: [Double]].self, from: data) else { return [:] }
        return map
    }

    nonisolated private static func storedHistory() -> [UUID] {
        (UserDefaults.standard.stringArray(forKey: Keys.history) ?? []).compactMap(UUID.init(uuidString:))
    }

    // MARK: - État observé par l'interface

    @Published private(set) var current: Track?
    @Published private(set) var playing = false
    let clock = PlaybackClock()
    let spectrum = SpectrumModel()
    var position: Double { clock.position }
    @Published private(set) var currentBPM: Double?
    @Published private(set) var currentKey: Int?
    @Published var showFullScreen = false
    /// Morceau vers lequel l'automix est en train de mixer (nil hors transition).
    @Published private(set) var mixingInto: Track?
    /// Derniers morceaux écoutés (le plus récent en premier).
    @Published private(set) var history: [UUID] = Player.storedHistory()

    @Published var repeatMode: RepeatMode = Player.storedRepeat() {
        didSet {
            rebuildOrder()
            UserDefaults.standard.set(repeatMode.rawValue, forKey: Keys.repeatMode)
        }
    }

    @Published var shuffle: Bool = Player.storedBool(Keys.shuffle, false) {
        didSet {
            rebuildOrder()
            UserDefaults.standard.set(shuffle, forKey: Keys.shuffle)
        }
    }

    /// Lecture continue : à la fin de la file, on enchaîne avec des morceaux du même genre et d'un
    /// tempo proche (au lieu de s'arrêter ou de reboucler sur un single).
    @Published var autoplay: Bool = Player.storedBool("player.autoplay", true) {
        didSet {
            UserDefaults.standard.set(autoplay, forKey: "player.autoplay")
            extendQueueIfNeeded()
            refreshPlan()
        }
    }

    /// Source de la lecture continue (toute la bibliothèque), branchée au lancement.
    var libraryProvider: (() -> [Track])?

    // MARK: - AutoMix

    /// Longueur des transitions, en TEMPS musicaux (comme un DJ), avec un équivalent en secondes
    /// quand le rythme n'est pas détectable.
    enum MixLength: String, CaseIterable, Identifiable {
        case short, normal, long
        var id: String { rawValue }
        var beats: Int { self == .short ? 8 : (self == .normal ? 16 : 32) }
        var seconds: Double { self == .short ? 4 : (self == .normal ? 8 : 12) }
        var label: String { self == .short ? "Courte" : (self == .normal ? "Normale" : "Longue") }
    }

    @Published var automixEnabled: Bool = Player.storedBool(Keys.automix, true) {
        didSet {
            UserDefaults.standard.set(automixEnabled, forKey: Keys.automix)
            if !automixEnabled { cancelFade() }
            refreshPlan()
        }
    }

    @Published var mixLength: MixLength = Player.storedMixLength() {
        didSet {
            UserDefaults.standard.set(mixLength.rawValue, forKey: Keys.mixLength)
            refreshPlan()
        }
    }

    @Published var beatMatched: Bool = Player.storedBool(Keys.beatMatched, true) {
        didSet {
            UserDefaults.standard.set(beatMatched, forKey: Keys.beatMatched)
            refreshPlan()
        }
    }

    func setAutomix(_ on: Bool) { automixEnabled = on }

    // MARK: - Égalisation du volume

    /// Tous les morceaux au MÊME volume perçu, en permanence (comme Sound Check d'Apple, mais avec
    /// une mesure qui ne se laisse pas tromper par les grosses basses). Plus aucun morceau qui
    /// écrase l'autre pendant ou après une transition.
    @Published var normalizeVolume: Bool = true {
        didSet {
            UserDefaults.standard.set(normalizeVolume, forKey: "player.normalize")
            applyLoudness(to: activeDeck, for: current, ramp: true)
        }
    }

    /// Volume perçu visé (même échelle que `TrackAnalysis.loudness`).
    private static let loudnessTarget = 0.12
    private var loudnessRampTask: Task<Void, Never>?

    /// Gain (dB) qui ramène ce morceau au volume commun : −10 dB maximum pour un morceau masterisé
    /// très fort, +5 dB maximum pour un morceau trop bas (au-delà, risque de saturation).
    private func loudnessGain(for track: Track?) -> Float {
        guard normalizeVolume, let track, let loudness = analyses[track.id]?.loudness, loudness > 0 else { return 0 }
        let decibels = 20 * log10(Self.loudnessTarget / loudness)
        return Float(max(-10, min(5, decibels)))
    }

    /// Applique le gain de volume d'un morceau sur sa platine — en douceur (1,6 s) si la musique
    /// joue déjà, pour qu'on n'entende jamais de saut.
    private func applyLoudness(to deck: AVAudioPlayerNode?, for track: Track?, ramp: Bool) {
        guard let deck else { return }
        let unit = fx(for: deck)
        let target = loudnessGain(for: track)
        loudnessRampTask?.cancel()
        guard ramp, abs(unit.globalGain - target) > 0.3 else {
            unit.globalGain = target
            return
        }
        let from = unit.globalGain
        loudnessRampTask = Task {
            let steps = 40
            for step in 1...steps {
                if Task.isCancelled { return }
                let u = Float(step) / Float(steps)
                unit.globalGain = from + (target - from) * u * u * (3 - 2 * u)
                try? await Task.sleep(nanoseconds: 40_000_000)
            }
        }
    }

    // MARK: - Égaliseur

    @Published var eqEnabled: Bool = Player.storedBool(Keys.eqEnabled, false) {
        didSet {
            applyEqualizer()
            UserDefaults.standard.set(eqEnabled, forKey: Keys.eqEnabled)
        }
    }

    @Published var eqGains: [Double] = Player.storedGains() {
        didSet {
            applyEqualizer()
            UserDefaults.standard.set(eqGains, forKey: Keys.eqGains)
        }
    }

    @Published var eqPreamp: Double = Player.storedDouble(Keys.eqPreamp, 0) {
        didSet {
            applyEqualizer()
            UserDefaults.standard.set(eqPreamp, forKey: Keys.eqPreamp)
        }
    }

    @Published var eqAutoHeadroom: Bool = Player.storedBool(Keys.eqAutoHeadroom, true) {
        didSet {
            applyEqualizer()
            UserDefaults.standard.set(eqAutoHeadroom, forKey: Keys.eqAutoHeadroom)
        }
    }

    @Published var eqPresetName: String = UserDefaults.standard.string(forKey: "eq.preset") ?? "Plat" {
        didSet { UserDefaults.standard.set(eqPresetName, forKey: Keys.eqPreset) }
    }

    @Published var customPresets: [String: [Double]] = Player.storedCustomPresets() {
        didSet {
            if let data = try? JSONEncoder().encode(customPresets) {
                UserDefaults.standard.set(data, forKey: Keys.eqCustom)
            }
        }
    }

    enum RepeatMode: String, Codable, CaseIterable { case off, all, one }

    static let equalizerFrequencies: [Double] = equalizerBandFrequencies

    static let builtInPresets: [(name: String, gains: [Double])] = [
        ("Plat", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        ("Phonk", [7, 6, 3, 0, -2, -1, 1, 3, 4, 3]),
        ("Basses+", [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]),
        ("Bass boost", [9, 8, 5, 2, 0, -1, 0, 0, 0, 0]),
        ("Hip-hop", [5, 4, 2, 1, -1, -1, 1, 1, 2, 3]),
        ("Électro", [5, 4, 1, 0, -2, 1, 0, 1, 4, 5]),
        ("Loudness", [5, 3, 0, 0, -1, 0, 0, 1, 3, 4]),
        ("Rock", [4, 3, 2, 1, -1, -1, 1, 2, 3, 4]),
        ("Pop", [-1, 1, 2, 3, 2, 0, -1, -1, 1, 2]),
        ("Voix", [-2, -1, 0, 2, 3, 3, 2, 1, 0, -1]),
        ("Aigus+", [0, 0, 0, 0, 0, 1, 2, 4, 5, 6]),
        ("Acoustique", [3, 3, 2, 1, 1, 1, 2, 2, 2, 1]),
        ("Koto", [3, 2, 0, -1, -2, 0, 2, 3, 2, 1]),
        ("Nuit", [-3, -2, -1, 0, 1, 1, 0, -2, -3, -4]),
    ]

    var allPresetNames: [String] {
        Self.builtInPresets.map(\.name) + customPresets.keys.sorted()
    }

    func gains(forPreset name: String) -> [Double]? {
        if let custom = customPresets[name] { return custom }
        return Self.builtInPresets.first { $0.name == name }?.gains
    }

    func applyPreset(_ name: String) {
        guard let preset = gains(forPreset: name) else { return }
        eqGains = preset
        eqPresetName = name
        if !eqEnabled { eqEnabled = true }
    }

    func setGain(_ value: Double, at index: Int) {
        guard eqGains.indices.contains(index) else { return }
        var updated = eqGains
        updated[index] = (value * 2).rounded() / 2
        eqGains = updated
        if self.gains(forPreset: eqPresetName) != updated { eqPresetName = "Personnalisé" }
    }

    func saveCustomPreset(named raw: String) {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        customPresets[name] = eqGains
        eqPresetName = name
    }

    func deleteCustomPreset(named name: String) {
        customPresets[name] = nil
        if eqPresetName == name { eqPresetName = "Personnalisé" }
    }

    func resetEqualizer() {
        eqGains = Array(repeating: 0, count: Self.equalizerFrequencies.count)
        eqPreamp = 0
        eqPresetName = "Plat"
    }

    // MARK: - Moteur

    private let engine = AVAudioEngine()
    private let equalizer = AVAudioUnitEQ(numberOfBands: 10)
    private let crossMixer = AVAudioMixerNode()
    private let deckA = AVAudioPlayerNode()
    private let deckB = AVAudioPlayerNode()
    private let pitchA = AVAudioUnitTimePitch()
    private let pitchB = AVAudioUnitTimePitch()
    /// Effets de transition par platine : bande 0 = plateau grave (bass swap), bande 1 = passe-haut.
    private let fxA = AVAudioUnitEQ(numberOfBands: 2)
    private let fxB = AVAudioUnitEQ(numberOfBands: 2)

    private let analyzer = TrackAnalyzer()
    private var analyses: [UUID: TrackAnalysis] = [:]
    private var analysisTask: Task<Void, Never>?
    private var activeDeck: AVAudioPlayerNode?
    private var activeFile: AVAudioFile?
    /// Position du fichier à partir de laquelle chaque platine a été programmée.
    private var segmentStartA: Double = 0
    private var segmentStartB: Double = 0

    /// Horloge de position : ancre (heure système, position, vitesse). Exacte même quand le tempo
    /// est modifié pendant un mix, et figée proprement en pause.
    private var anchorHost: Double = 0
    private var anchorPosition: Double = 0
    private var anchorRate: Double = 1
    private var pausedPosition: Double?

    private var scheduleToken = 0
    /// Toute action manuelle incrémente ce jeton : une transition en cours s'arrête proprement.
    private var fadeToken = 0
    private var fading = false
    private var plan: MixPlan?
    private var planTrackID: UUID?

    private var timer: Timer?
    private var order: [Int] = []
    private var queue: [Track] = []
    private var queuePosition = 0
    private var failedLoads = 0
    private var sleepDeadline: Date?
    private var wasPlayingBeforeInterruption = false

    private var artworkTrackID: UUID?
    private var nowPlayingArtwork: MPMediaItemArtwork?

    private let spectrumAnalyzer = SpectrumAnalyzer(bandCount: 28)
    private var tapInstalled = false
    private var stalledTicks = 0

    /// À partir de cette place dans `order`, le lecteur CHOISIT LUI-MÊME l'ordre (aléatoire, ou
    /// morceaux ajoutés par la lecture continue) : le suivant est celui qui se mixe le mieux.
    /// Avant, une file jouée dans l'ordre (album, playlist) n'est jamais réordonnée.
    private var freeOrderFrom = Int.max
    /// Place dans `queue` où commencent les morceaux ajoutés par la lecture continue.
    private var extendedFrom: Int?
    /// Automate des transitions : tourne sur son propre fil temps réel (5 ms), plus jamais sur le
    /// fil de l'interface (avant, un défilement ou une animation faisait « sauter » les fondus).
    private let automator = MixAutomator()
    /// Retour progressif au tempo d'origine après un mix (calcul exact de la position).
    /// Rampe de tempo en cours (sortante qui va chercher le tempo du suivant) : vitesse
    /// `from` → `to` en courbe en S sur `length` secondes, à partir de l'heure `host`.
    private var glide: (host: Double, from: Double, to: Double, length: Double)?

    override init() {
        super.init()
        configureEngine()
        configureSession()
        configureRemoteCommands()
        observeAudioSession()
        applyEqualizer()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // Mode .common : le minuteur tourne aussi PENDANT un défilement.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        let analyzer = self.analyzer
        Task { [weak self] in
            let stored = await analyzer.allCached()
            guard let self else { return }
            for (id, analysis) in stored where self.analyses[id] == nil { self.analyses[id] = analysis }
            self.pickSmartNext()
            self.refreshPlan()
        }
    }

    private func configureEngine() {
        for node in [deckA, deckB, pitchA, pitchB, fxA, fxB, crossMixer, equalizer] as [AVAudioNode] {
            engine.attach(node)
        }

        let last = Self.equalizerFrequencies.count - 1
        for (index, frequency) in Self.equalizerFrequencies.enumerated() {
            let band = equalizer.bands[index]
            band.filterType = index == 0 ? .lowShelf : (index == last ? .highShelf : .parametric)
            band.frequency = Float(frequency)
            band.bandwidth = 1.0
            band.gain = 0
            band.bypass = true
        }
        for fx in [fxA, fxB] {
            fx.bands[0].filterType = .lowShelf
            fx.bands[0].frequency = 180
            fx.bands[0].gain = 0
            fx.bands[0].bypass = false
            fx.bands[1].filterType = .highPass
            fx.bands[1].frequency = 20
            fx.bands[1].bypass = true
        }

        engine.connect(deckA, to: pitchA, format: nil)
        engine.connect(deckB, to: pitchB, format: nil)
        engine.connect(pitchA, to: fxA, format: nil)
        engine.connect(pitchB, to: fxB, format: nil)
        engine.connect(fxA, to: crossMixer, fromBus: 0, toBus: 0, format: nil)
        engine.connect(fxB, to: crossMixer, fromBus: 0, toBus: 1, format: nil)
        engine.connect(crossMixer, to: equalizer, format: nil)
        engine.connect(equalizer, to: engine.mainMixerNode, format: nil)

        deckA.volume = 1
        deckB.volume = 0
        engine.prepare()
        try? engine.start()
    }

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
    }

    private func ensureEngineRunning() {
        guard !engine.isRunning else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            diag("session audio : activation refusée (\(error.localizedDescription))")
        }
        do {
            try engine.start()
            diag("moteur audio démarré")
        } catch {
            diag("moteur audio : démarrage impossible (\(error.localizedDescription))")
        }
    }

    private func pitch(for deck: AVAudioPlayerNode?) -> AVAudioUnitTimePitch { deck === deckB ? pitchB : pitchA }
    private func fx(for deck: AVAudioPlayerNode?) -> AVAudioUnitEQ { deck === deckB ? fxB : fxA }
    private func other(than deck: AVAudioPlayerNode?) -> AVAudioPlayerNode { deck === deckA ? deckB : deckA }

    private func resetFX(_ fx: AVAudioUnitEQ) {
        fx.bands[0].gain = 0
        fx.bands[1].bypass = true
        fx.bands[1].frequency = 20
    }

    private func observeAudioSession() {
        let center = NotificationCenter.default
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            Task { @MainActor in
                guard let self, let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
                switch type {
                case .began:
                    diag("interruption (appel, Siri, alarme…) : pause")
                    self.wasPlayingBeforeInterruption = self.playing
                    self.pause()
                case .ended:
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
                    diag("fin d'interruption (reprise autorisée : \(options.contains(.shouldResume)))")
                    if self.wasPlayingBeforeInterruption && options.contains(.shouldResume) {
                        self.resume()
                    }
                    self.wasPlayingBeforeInterruption = false
                @unknown default:
                    break
                }
            }
        }

        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor in
                guard let self, let reasonRaw, let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) else { return }
                diag("sortie audio changée (raison \(reasonRaw))")
                if reason == .oldDeviceUnavailable { self.pause() }
            }
        }

        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in
                diag("moteur audio reconfiguré par iOS → relance")
                self?.recoverEngine()
            }
        }

        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.configureSession()
                self?.recoverEngine()
            }
        }
    }

    private func recoverEngine() {
        let wasPlaying = playing
        let resumeAt = livePosition()
        cancelFade()
        ensureEngineRunning()
        guard let deck = activeDeck, let file = activeFile else { return }
        deck.stop()
        schedule(on: deck, file: file, from: resumeAt)
        deck.volume = 1
        if wasPlaying {
            deck.play()
            setAnchor(resumeAt, rate: 1)
            pausedPosition = nil
        } else {
            pausedPosition = resumeAt
        }
        clock.position = resumeAt
        diag("relance à \(String(format: "%.1f", resumeAt)) s (lecture : \(wasPlaying))")
        if tapInstalled {
            engine.mainMixerNode.removeTap(onBus: 0)
            tapInstalled = false
            setVisualizer(active: true)
        }
    }

    private func applyEqualizer() {
        let maxBoost = eqGains.max() ?? 0
        let headroom = eqAutoHeadroom ? -max(0, maxBoost) * 0.6 : 0
        for (index, band) in equalizer.bands.enumerated() {
            band.bypass = !eqEnabled
            band.gain = Float(eqGains.indices.contains(index) ? eqGains[index] : 0)
        }
        equalizer.globalGain = eqEnabled ? Float(max(-24, min(24, eqPreamp + headroom))) : 0
    }

    // MARK: - Visualiseur

    /// Branche / débranche l'analyse de spectre sur la sortie. Uniquement quand la vue lecture
    /// est affichée ET l'app au premier plan : zéro coût le reste du temps.
    func setVisualizer(active: Bool) {
        let mixer = engine.mainMixerNode
        if active, !tapInstalled {
            let format = mixer.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { return }
            mixer.removeTap(onBus: 0)
            mixer.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.makeTap(spectrumAnalyzer, spectrum))
            tapInstalled = true
        } else if !active, tapInstalled {
            mixer.removeTap(onBus: 0)
            tapInstalled = false
            spectrum.bands = Array(repeating: 0, count: SpectrumModel.bandCount)
        }
    }

    nonisolated private static func makeTap(_ analyzer: SpectrumAnalyzer, _ model: SpectrumModel) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let bands = analyzer.process(buffer) else { return }
            Task { @MainActor in model.bands = bands }
        }
    }

    // MARK: - Commandes distantes

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.toggle() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.previous() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let time = event.positionTime
            Task { @MainActor in self?.seek(to: time) }
            return .success
        }
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
    }

    nonisolated private static func makeArtwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }

    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard let current else {
            center.nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: current.title,
            MPMediaItemPropertyArtist: current.artist,
            MPMediaItemPropertyAlbumTitle: current.album,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: livePosition(),
            MPNowPlayingInfoPropertyPlaybackRate: playing ? anchorRate : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if artworkTrackID == current.id, let art = nowPlayingArtwork {
            info[MPMediaItemPropertyArtwork] = art
        }
        center.nowPlayingInfo = info

        if artworkTrackID != current.id {
            artworkTrackID = current.id
            nowPlayingArtwork = nil
            let track = current
            Task { [weak self] in
                guard let image = await ArtworkCache.shared.load(for: track, maxPixel: 700) else { return }
                guard let self, self.current?.id == track.id else { return }
                let art = Self.makeArtwork(image)
                self.nowPlayingArtwork = art
                var refreshed = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                refreshed[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = refreshed
            }
        }
    }

    // MARK: - File de lecture

    private func rebuildOrder() {
        var indices = Array(queue.indices)
        if shuffle {
            indices.shuffle()
            if let at = indices.firstIndex(of: queuePosition), at != 0 { indices.swapAt(0, at) }
            freeOrderFrom = 0
        } else {
            freeOrderFrom = extendedFrom ?? Int.max
        }
        order = indices
        pickSmartNext()
        refreshPlan()
    }

    // MARK: - Choix du morceau suivant (aléatoire / lecture continue)

    /// Note de compatibilité de mix entre deux morceaux (0…1), comme un DJ la ferait :
    /// tempo (±5 % idéal, demi/double tempo compris), tonalité (roue Camelot : même tonalité ou
    /// voisine = parfait), et énergie (volume perçu proche).
    nonisolated static func mixScore(from a: TrackAnalysis?, to b: TrackAnalysis?) -> Double {
        var score = 0.0
        if let x = a?.bpm, let y = b?.bpm, x > 0, y > 0 {
            let distance = abs(log(AudioMath.tempoRatio(outgoing: x, incoming: y)))
            score += 0.5 * exp(-pow(distance / 0.05, 2))
        } else {
            score += 0.5 * 0.3
        }
        if let harmonic = AudioMath.harmonicDistance(a?.key, b?.key) {
            let table: [Double] = [1.0, 0.9, 0.5, 0.3, 0.2, 0.12, 0.08]
            score += 0.3 * table[min(harmonic, table.count - 1)]
        } else {
            score += 0.3 * 0.4
        }
        if let la = a?.loudness, let lb = b?.loudness, la > 0, lb > 0 {
            let decibels = abs(20 * log10(lb / la))
            score += 0.2 * exp(-pow(decibels / 6, 2))
        } else {
            score += 0.2 * 0.5
        }
        return score
    }

    /// En aléatoire et en lecture continue, le SUIVANT n'est plus tiré au hasard : parmi les
    /// morceaux pas encore joués, on prend l'un des meilleurs pour le mix (BPM, tonalité, énergie,
    /// même genre, artiste différent), avec une part de hasard entre les meilleurs pour ne jamais
    /// tourner en rond. Jamais modifié quand la transition est imminente.
    private func pickSmartNext() {
        guard repeatMode != .one, !fading, let current,
              let at = order.firstIndex(of: queuePosition),
              at + 1 < order.count, at + 1 >= freeOrderFrom else { return }
        if let plan, planTrackID == current.id, livePosition() > plan.rampStart - 12 { return }

        let from = analyses[current.id]
        let prepared = PlaylistStore.preparedGenreIDs
        let currentIsGenre = PlaylistStore.isGenreTrack(current, prepared: prepared)
        let recentIDs = Set(history.prefix(4))
        let recentArtists = Set(queue.filter { recentIDs.contains($0.id) }.map(\.artist))

        var scored: [(position: Int, score: Double)] = []
        for offset in 0..<min(400, order.count - at - 1) {
            let position = at + 1 + offset
            let index = order[position]
            guard queue.indices.contains(index) else { continue }
            let track = queue[index]
            guard track.id != current.id else { continue }
            var score = Self.mixScore(from: from, to: analyses[track.id])
            if track.artist == current.artist {
                score *= 0.8
            } else if recentArtists.contains(track.artist) {
                score *= 0.9
            }
            if PlaylistStore.isGenreTrack(track, prepared: prepared) != currentIsGenre { score *= 0.75 }
            if recentIDs.contains(track.id) { score *= 0.5 }
            scored.append((position, score))
        }
        guard let best = scored.max(by: { $0.score < $1.score }) else { return }
        let finalists = scored.filter { $0.score >= best.score * 0.9 }.sorted { $0.score > $1.score }.prefix(4)
        let total = finalists.reduce(0) { $0 + $1.score * $1.score }
        var roll = Double.random(in: 0..<max(total, 1e-9))
        var chosen = best.position
        for item in finalists {
            roll -= item.score * item.score
            if roll <= 0 {
                chosen = item.position
                break
            }
        }
        if chosen != at + 1 { order.swapAt(at + 1, chosen) }
    }

    /// Morceaux de la zone libre pas encore analysés (on en analyse quelques-uns à chaque titre,
    /// en tâche de fond : le choix devient de plus en plus juste, et c'est gardé pour toujours).
    private func candidatesToAnalyze(limit: Int, excluding: Set<UUID>) -> [Track] {
        guard repeatMode != .one, let at = order.firstIndex(of: queuePosition),
              at + 1 < order.count, at + 1 >= freeOrderFrom else { return [] }
        var result: [Track] = []
        for position in order[(at + 1)...].shuffled() {
            guard queue.indices.contains(position) else { continue }
            let track = queue[position]
            if analyses[track.id] == nil, !excluding.contains(track.id) {
                result.append(track)
                if result.count >= limit { break }
            }
        }
        return result
    }

    /// Prochain morceau que jouera l'automix. En « répéter ce titre », c'est le morceau lui-même :
    /// il se mixe sur son propre début, calé sur les temps (boucle façon DJ, sans blanc).
    private var nextIndexInOrder: Int? {
        if repeatMode == .one, queue.indices.contains(queuePosition) { return queuePosition }
        guard let at = order.firstIndex(of: queuePosition) else { return nil }
        if at + 1 < order.count { return order[at + 1] }
        return repeatMode == .all ? order.first : nil
    }

    private var upcomingTrack: Track? {
        nextIndexInOrder.flatMap { queue.indices.contains($0) ? queue[$0] : nil }
    }

    /// Les prochains morceaux de la file (pour l'analyse anticipée).
    private func upcoming(_ count: Int) -> [Track] {
        guard let at = order.firstIndex(of: queuePosition), !order.isEmpty else { return [] }
        var result: [Track] = []
        for step in 1...max(1, count) {
            let index = at + step
            if index < order.count {
                result.append(queue[order[index]])
            } else if repeatMode == .all {
                result.append(queue[order[index % order.count]])
            }
        }
        return result
    }

    func play(_ tracks: [Track], startingAt startIndex: Int) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        extendedFrom = nil
        queuePosition = min(max(0, startIndex), tracks.count - 1)
        failedLoads = 0
        rebuildOrder()
        load(track: queue[queuePosition])
    }

    func playShuffled(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        extendedFrom = nil
        queuePosition = Int.random(in: 0..<tracks.count)
        failedLoads = 0
        if shuffle { rebuildOrder() } else { shuffle = true }
        load(track: queue[queuePosition])
    }

    private func load(track: Track, at seconds: Double = 0) {
        cancelFade()
        guard let file = try? AVAudioFile(forReading: track.fileURL) else {
            diag("fichier illisible : « \(track.title) » → suivant")
            failedLoads += 1
            if failedLoads < max(1, queue.count) {
                advance(manual: true)
            } else {
                failedLoads = 0
                pause()
            }
            return
        }
        failedLoads = 0
        ensureEngineRunning()
        deckA.stop()
        deckB.stop()
        pitchA.rate = 1
        pitchB.rate = 1
        resetFX(fxA)
        resetFX(fxB)
        deckA.volume = 1
        deckB.volume = 0
        activeDeck = deckA
        activeFile = file
        current = track
        currentBPM = analyses[track.id]?.bpm
        diag("lecture : « \(track.title) »")
        currentKey = analyses[track.id]?.key
        loudnessRampTask?.cancel()
        fxA.globalGain = loudnessGain(for: track)

        let start = max(0, seconds)
        schedule(on: deckA, file: file, from: start)
        deckA.play()
        playing = true
        setAnchor(start, rate: 1)
        pausedPosition = nil
        clock.position = start
        clock.duration = duration
        remember(track)
        extendQueueIfNeeded()
        pickSmartNext()
        updateNowPlaying()
        refreshPlan()
        analyzeAhead()
    }

    /// Si on joue le DERNIER morceau de la file, on la prolonge (lecture continue) : même genre si
    /// possible, puis tempos les plus proches d'abord — l'automix a toujours un suivant à mixer.
    private func extendQueueIfNeeded() {
        guard autoplay, repeatMode != .one, let current,
              let at = order.firstIndex(of: queuePosition), at == order.count - 1 else { return }
        if repeatMode == .all && queue.count > 1 { return }
        guard let all = libraryProvider?(), all.count > 1 else { return }

        let excluded = Set(queue.map(\.id)).union(history.prefix(25))
        var pool = all.filter { !excluded.contains($0.id) }
        if pool.isEmpty { pool = all.filter { $0.id != current.id } }
        guard !pool.isEmpty else { return }

        let prepared = PlaylistStore.preparedGenreIDs
        if PlaylistStore.isGenreTrack(current, prepared: prepared) {
            let sameGenre = pool.filter { PlaylistStore.isGenreTrack($0, prepared: prepared) }
            if sameGenre.count >= 5 { pool = sameGenre }
        }
        pool.shuffle()
        // Les 16 qui se mixent le mieux avec le morceau en cours (BPM, tonalité, énergie) + 8 au
        // hasard pour la découverte. L'ordre exact est ensuite choisi titre après titre.
        let from = analyses[current.id]
        let ranked = pool.prefix(600).sorted {
            Self.mixScore(from: from, to: analyses[$0.id]) > Self.mixScore(from: from, to: analyses[$1.id])
        }
        var picks = Array(ranked.prefix(16))
        let chosen = Set(picks.map(\.id))
        picks += pool.filter { !chosen.contains($0.id) }.prefix(8)
        let base = queue.count
        if extendedFrom == nil { extendedFrom = base }
        freeOrderFrom = min(freeOrderFrom, order.count)
        queue.append(contentsOf: picks)
        order.append(contentsOf: base..<queue.count)
    }

    private func remember(_ track: Track) {
        var updated = history.filter { $0 != track.id }
        updated.insert(track.id, at: 0)
        if updated.count > 40 { updated.removeLast(updated.count - 40) }
        history = updated
        UserDefaults.standard.set(updated.map(\.uuidString), forKey: Keys.history)
    }

    /// Analyse (en arrière-plan, sauvegardée) du morceau en cours et des 5 suivants : quand la
    /// transition arrive, tout est prêt depuis longtemps.
    private func analyzeAhead() {
        guard let current else { return }
        let chain = [current] + upcoming(5)
        let candidates = candidatesToAnalyze(limit: 10, excluding: Set(chain.map(\.id)))
        let analyzer = self.analyzer
        analysisTask?.cancel()
        // Priorité « utilitaire » : l'analyse ne prend jamais la main sur l'interface.
        analysisTask = Task(priority: .utility) { [weak self] in
            for (index, track) in chain.enumerated() {
                if Task.isCancelled { return }
                let result = await analyzer.analysis(of: track)
                guard let self else { return }
                self.analyses[track.id] = result
                if self.current?.id == track.id {
                    self.currentBPM = result.bpm
                    self.currentKey = result.key
                    // 1re écoute d'un morceau : son volume est égalisé dès que l'analyse est
                    // prête, en douceur (les fois suivantes, c'est immédiat : l'analyse est gardée).
                    if !self.fading { self.applyLoudness(to: self.activeDeck, for: track, ramp: true) }
                }
                if index <= 1 { self.refreshPlan() }
                if index == 1 {
                    // Pochettes du suivant préparées : affichage instantané au changement.
                    for size in [CGFloat(180), 260, 1000] {
                        _ = await ArtworkCache.shared.load(for: track, maxPixel: size)
                    }
                }
            }

            // Aléatoire / lecture continue : on apprend de nouveaux morceaux, puis on re-choisit
            // le suivant si un meilleur raccord existe (jamais quand le mix est imminent).
            guard !candidates.isEmpty else { return }
            for track in candidates {
                if Task.isCancelled { return }
                let result = await analyzer.analysis(of: track)
                guard let self else { return }
                self.analyses[track.id] = result
            }
            guard let self, !Task.isCancelled else { return }
            let before = self.upcomingTrack?.id
            self.pickSmartNext()
            if let next = self.upcomingTrack, next.id != before {
                self.refreshPlan()
                diag("suivant choisi pour le mix : « \(next.title) » (\(self.analyses[next.id]?.bpm.map { String(format: "%.1f BPM", $0) } ?? "BPM ?"))")
                if self.analyses[next.id] == nil {
                    self.analyses[next.id] = await analyzer.analysis(of: next)
                    self.refreshPlan()
                }
                for size in [CGFloat(180), 260, 1000] {
                    _ = await ArtworkCache.shared.load(for: next, maxPixel: size)
                }
            }
        }
    }

    /// (Re)calcule la transition vers le morceau suivant.
    private func refreshPlan() {
        // Le suivant peut être LE MÊME morceau (répéter ce titre, ou file d'un seul titre) :
        // il est alors mixé sur lui-même.
        guard automixEnabled, let current, let next = upcomingTrack else {
            plan = nil
            planTrackID = nil
            return
        }
        let sameAlbum = !shuffle
            && next.id != current.id
            && current.album == next.album
            && current.artist == next.artist
            && current.album != "Album inconnu"
        plan = MixPlanner.plan(
            out: analyses[current.id] ?? .empty,
            outDuration: duration,
            into: analyses[next.id] ?? .empty,
            sameAlbum: sameAlbum,
            sameTrack: next.id == current.id,
            beats: mixLength.beats,
            seconds: mixLength.seconds,
            beatMatch: beatMatched
        )
        planTrackID = current.id
    }

    private func schedule(on deck: AVAudioPlayerNode, file: AVAudioFile, from seconds: Double) {
        let rate = file.processingFormat.sampleRate
        let start = max(0, seconds)
        let frame = AVAudioFramePosition(start * rate)
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        if deck === deckA { segmentStartA = start } else { segmentStartB = start }
        scheduleToken += 1
        let token = scheduleToken
        guard remaining > 0 else { return }
        deck.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.activeDeck === deck, self.scheduleToken == token else { return }
                self.handleFinished()
            }
        }
    }

    private func handleFinished() {
        if fading { return }
        if repeatMode == .one, let current {
            load(track: current)
            return
        }
        advance(manual: false)
    }

    private func advance(manual: Bool) {
        guard !queue.isEmpty, let at = order.firstIndex(of: queuePosition) else { return }
        if at + 1 < order.count {
            queuePosition = order[at + 1]
        } else if repeatMode != .off || manual {
            if shuffle {
                var indices = Array(queue.indices)
                indices.shuffle()
                order = indices
                freeOrderFrom = 0
            }
            queuePosition = order.first ?? 0
        } else {
            pause()
            seek(to: 0)
            return
        }
        load(track: queue[queuePosition])
    }

    // MARK: - Transport

    func resume() {
        guard let deck = activeDeck, let file = activeFile else {
            if let current { load(track: current) }
            return
        }
        guard !playing else { return }
        let resumeAt = pausedPosition ?? clock.position
        if !engine.isRunning {
            ensureEngineRunning()
            deck.stop()
            schedule(on: deck, file: file, from: resumeAt)
        }
        deck.volume = 1
        deck.play()
        setAnchor(resumeAt, rate: Double(pitch(for: deck).rate))
        pausedPosition = nil
        playing = true
        updateNowPlaying()
    }

    func pause() {
        guard playing else { return }
        let at = livePosition()
        cancelFade()
        activeDeck?.pause()
        playing = false
        pausedPosition = at
        clock.position = at
        updateNowPlaying()
    }

    func toggle() { playing ? pause() : resume() }

    func seek(to seconds: Double) {
        guard let file = activeFile, let deck = activeDeck else { return }
        cancelFade()
        let clamped = max(0, min(seconds, max(0, duration - 0.25)))
        ensureEngineRunning()
        deck.stop()
        deck.volume = 1
        schedule(on: deck, file: file, from: clamped)
        if playing {
            deck.play()
            setAnchor(clamped, rate: 1)
            pausedPosition = nil
        } else {
            pausedPosition = clamped
        }
        clock.position = clamped
        updateNowPlaying()
    }

    func next() { advance(manual: true) }

    /// Des morceaux vont être supprimés de l'iPhone : on les retire de la file. Si le morceau en
    /// cours en fait partie, on passe proprement au suivant qui reste (ou on s'arrête).
    func removeTracks(_ ids: Set<UUID>) {
        guard !ids.isEmpty, !queue.isEmpty else { return }
        let survivors = queue.filter { !ids.contains($0.id) }
        guard let current, ids.contains(current.id) else {
            // Le morceau en cours reste : on garde la lecture, on recompose juste la file.
            let currentID = self.current?.id
            var newIndex: [UUID: Int] = [:]
            for (index, track) in survivors.enumerated() where newIndex[track.id] == nil {
                newIndex[track.id] = index
            }
            order = order.compactMap { old in
                guard queue.indices.contains(old) else { return nil }
                return newIndex[queue[old].id]
            }
            var seen = Set<Int>()
            order = order.filter { seen.insert($0).inserted }
            queue = survivors
            queuePosition = currentID.flatMap { newIndex[$0] } ?? 0
            refreshPlan()
            return
        }

        // Le morceau en cours est supprimé : on cherche le suivant qui survit, dans l'ordre.
        var nextID: UUID?
        if let at = order.firstIndex(of: queuePosition) {
            for step in 1..<max(2, order.count + 1) {
                let index = order[(at + step) % order.count]
                if queue.indices.contains(index), !ids.contains(queue[index].id) {
                    nextID = queue[index].id
                    break
                }
            }
        }
        _ = current
        if survivors.isEmpty || nextID == nil {
            stopAndClear()
            return
        }
        let start = survivors.firstIndex { $0.id == nextID } ?? 0
        play(survivors, startingAt: start)
    }

    /// Arrêt complet : plus rien en cours (le mini-lecteur disparaît).
    func stopAndClear() {
        cancelFade()
        analysisTask?.cancel()
        deckA.stop()
        deckB.stop()
        playing = false
        showFullScreen = false
        current = nil
        activeFile = nil
        queue = []
        order = []
        queuePosition = 0
        plan = nil
        planTrackID = nil
        pausedPosition = nil
        clock.position = 0
        clock.duration = 0
        updateNowPlaying()
    }

    /// `force` : vrai titre précédent (swipe), sans la règle « au-delà de 3 s, on revient au début ».
    func previous(force: Bool = false) {
        guard !queue.isEmpty else { return }
        if !force, livePosition() > 3 {
            seek(to: 0)
            return
        }
        guard let at = order.firstIndex(of: queuePosition) else { return }
        queuePosition = at > 0 ? order[at - 1] : (order.last ?? 0)
        load(track: queue[queuePosition])
    }

    // MARK: - Horloge

    private func setAnchor(_ position: Double, rate: Double) {
        anchorHost = hostNow()
        anchorPosition = position
        anchorRate = rate
        glide = nil
    }

    private func livePosition() -> Double {
        if !playing { return pausedPosition ?? clock.position }
        let raw = hostNow() - anchorHost
        var advanced = max(0, raw) * anchorRate
        if let glide, glide.host == anchorHost {
            // Vitesse a → b en courbe douce s(u) = 3u² − 2u³ : position = intégrale EXACTE,
            // ∫₀ᵗ r = a·t + (b − a)·D·(u³ − u⁴/2). Avant le début de la rampe : vitesse a.
            let length = glide.length
            let a = glide.from
            let b = glide.to
            if raw < 0 {
                advanced = raw * a
            } else if raw < length {
                let u = raw / length
                advanced = a * raw + (b - a) * length * (u * u * u - u * u * u * u / 2)
            } else {
                advanced = a * length + (b - a) * length * 0.5 + b * (raw - length)
            }
        }
        return min(duration, max(0, anchorPosition + advanced))
    }

    /// Position EXACTE d'une platine, lue sur l'horloge de rendu du moteur, avec l'heure système
    /// correspondante. C'est la base du démarrage à l'échantillon près.
    private func renderPosition(of deck: AVAudioPlayerNode) -> (position: Double, host: UInt64)? {
        guard let nodeTime = deck.lastRenderTime, nodeTime.isHostTimeValid,
              let playerTime = deck.playerTime(forNodeTime: nodeTime), playerTime.sampleRate > 0 else { return nil }
        let start = deck === deckA ? segmentStartA : segmentStartB
        return (start + Double(playerTime.sampleTime) / playerTime.sampleRate, nodeTime.hostTime)
    }

    private func tick() {
        if let deadline = sleepDeadline {
            let remaining = Int(deadline.timeIntervalSinceNow.rounded(.up))
            if remaining <= 0 {
                sleepDeadline = nil
                clock.sleepRemaining = nil
                pause()
            } else if clock.sleepRemaining != remaining {
                clock.sleepRemaining = remaining
            }
        }

        guard playing else {
            stalledTicks = 0
            return
        }

        // SURVEILLANCE : la lecture est censée tourner mais le moteur est arrêté (coupure
        // système, sortie changée sans prévenir…). Avant, la barre continuait d'avancer en
        // silence. Après 0,3 s de silence anormal, on relance au bon endroit.
        if !fading, !engine.isRunning || activeDeck?.isPlaying == false {
            stalledTicks += 1
            if stalledTicks >= 3 {
                stalledTicks = -20   // 2 s de répit avant une nouvelle tentative
                diag("SURVEILLANCE : moteur arrêté pendant la lecture → relance automatique")
                recoverEngine()
                return
            }
        } else {
            stalledTicks = 0
        }

        let now = livePosition()
        if abs(clock.position - now) > 0.04 { clock.position = now }
        let total = duration
        if clock.duration != total { clock.duration = total }

        guard automixEnabled, !fading,
              let plan, planTrackID == current?.id else { return }
        // On se met en route juste avant la rampe de tempo (ou 1,2 s avant le point de sortie
        // s'il n'y a pas de rampe) ; si on a déjà dépassé la moitié du chevauchement prévu (seek
        // tardif), on laisse le morceau finir normalement.
        let trigger = plan.rampLength > 0 ? plan.rampStart - 0.6 : plan.exitAt - 1.2
        if now >= trigger, now < plan.exitAt + max(0.3, plan.length * 0.5) {
            startMix(plan)
        }
    }

    // MARK: - Transition

    private func startMix(_ original: MixPlan) {
        guard let nextIndex = nextIndexInOrder, queue.indices.contains(nextIndex),
              let outgoing = activeDeck else { return }
        let incomingTrack = queue[nextIndex]
        guard let file = try? AVAudioFile(forReading: incomingTrack.fileURL) else { return }

        fadeToken += 1
        let token = fadeToken
        fading = true
        var plan = original

        let incoming = other(than: outgoing)
        let incomingFX = fx(for: incoming)
        ensureEngineRunning()
        incoming.stop()
        resetFX(incomingFX)
        incoming.volume = plan.style == .gapless ? 1 : 0
        incomingFX.globalGain = loudnessGain(for: incomingTrack)
        // L'entrante joue TOUJOURS à son tempo naturel : c'est la sortante qui s'accorde.
        pitch(for: incoming).rate = 1
        pitch(for: outgoing).rate = 1
        schedule(on: incoming, file: file, from: plan.entryAt)
        mixingInto = incomingTrack

        // Position réelle de la sortante (horloge de rendu du moteur), à cet instant.
        let nowSeconds = hostNow()
        var position = livePosition()
        if let render = renderPosition(of: outgoing) {
            position = render.position + max(0, nowSeconds - AVAudioTime.seconds(forHostTime: render.host))
        }

        if plan.style == .beatmix, plan.rampLength > 0, abs(plan.outRate - 1) > 0.0005 {
            let r = plan.outRate
            var rampHost: Double
            var rampLength = plan.rampLength
            var rampFrom = plan.rampStart
            if position <= plan.rampStart - 0.02 {
                rampHost = nowSeconds + (plan.rampStart - position)
            } else {
                // En retard (reprise, seek) : rampe plus courte qui finit quand même PILE au
                // point de sortie. D = 2·(sortie − position) / (1 + r).
                rampHost = nowSeconds + 0.03
                rampFrom = position + 0.03
                rampLength = (plan.exitAt - rampFrom) * 2 / (1 + r)
                if rampLength < 1.5 {
                    // Trop tard pour accorder les tempos sans à-coup : fondu filtré court.
                    plan.style = .filter
                    plan.outRate = 1
                    plan.rampLength = 0
                    plan.bassSwap = false
                    plan.length = min(plan.length, 6)
                    rampHost = 0
                }
            }
            if plan.style == .beatmix {
                incomingFX.bands[0].gain = -26
                // Horloge d'affichage : suit EXACTEMENT la rampe (intégrale de la vitesse).
                anchorHost = rampHost
                anchorPosition = rampFrom
                anchorRate = 1
                glide = (rampHost, 1, r, rampLength)
                pausedPosition = nil
                let pitchUnit = pitch(for: outgoing)
                let armPlan = plan
                diag("rampe de tempo de la sortante : ×1,000 → ×\(String(format: "%.3f", r)) en \(String(format: "%.1f", rampLength)) s, avant « \(incomingTrack.title) »")
                automator.run(
                    start: rampHost,
                    length: rampLength,
                    switchAt: max(0, (rampLength - 0.35) / rampLength),
                    apply: { u in
                        let smooth = u * u * (3 - 2 * u)
                        pitchUnit.rate = Float(1 + (r - 1) * smooth)
                    },
                    onSwitch: { [weak self] in
                        guard let self, token == self.fadeToken else { return }
                        self.armIncoming(plan: armPlan, token: token, outgoing: outgoing, incoming: incoming,
                                         track: incomingTrack, file: file, index: nextIndex)
                    },
                    onDone: {}
                )
                return
            }
        }
        if plan.bassSwap { incomingFX.bands[0].gain = plan.style == .beatmix ? -26 : -12 }
        armIncoming(plan: plan, token: token, outgoing: outgoing, incoming: incoming,
                    track: incomingTrack, file: file, index: nextIndex)
    }

    /// Lance l'entrante à l'échantillon près sur le point de sortie, puis le chevauchement.
    /// Appelé juste avant la fin de la rampe : la position réelle de la sortante est relue sur
    /// l'horloge du moteur, ce qui efface toute petite dérive accumulée pendant la rampe.
    private func armIncoming(plan: MixPlan, token: Int, outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode,
                             track incomingTrack: Track, file: AVAudioFile, index nextIndex: Int) {
        guard token == fadeToken else { return }
        automator.cancel()
        let r = plan.outRate
        pitch(for: outgoing).rate = Float(r)

        // Heure exacte où la sortante atteint le point de sortie (à la vitesse r).
        let nowHost = mach_absolute_time()
        var startHost: UInt64
        if let render = renderPosition(of: outgoing) {
            let delta = max(0, (plan.exitAt - render.position) / r)
            startHost = render.host + AVAudioTime.hostTime(forSeconds: delta)
            // On recale aussi l'horloge d'affichage sur la position réelle.
            let elapsed = AVAudioTime.seconds(forHostTime: nowHost) - AVAudioTime.seconds(forHostTime: render.host)
            setAnchor(render.position + max(0, elapsed) * r, rate: r)
        } else {
            let position = livePosition()
            let delta = max(0, (plan.exitAt - position) / r)
            startHost = nowHost + AVAudioTime.hostTime(forSeconds: delta)
            setAnchor(position, rate: r)
        }
        let earliest = nowHost + AVAudioTime.hostTime(forSeconds: 0.03)
        if startHost < earliest { startHost = earliest }
        incoming.play(at: AVAudioTime(hostTime: startHost))

        diag("mix \(plan.style) → « \(incomingTrack.title) » : sortie \(String(format: "%.1f", plan.exitAt)) s, entrée \(String(format: "%.1f", plan.entryAt)) s, \(plan.bars > 0 ? "\(plan.bars) mesures, " : "")\(String(format: "%.1f", plan.length)) s, sortante ×\(String(format: "%.3f", r))")
        runMix(plan: plan, token: token, outgoing: outgoing, incoming: incoming,
               track: incomingTrack, file: file, index: nextIndex,
               start: AVAudioTime.seconds(forHostTime: startHost))
    }

    /// Exécute la transition. Les courbes (volumes, bass swap, filtre) sont appliquées toutes les
    /// 5 ms par l'automate, sur un fil temps réel : rien ne peut les faire hoqueter (défilement,
    /// animation, écran verrouillé). Le fil principal ne fait que basculer l'affichage au milieu.
    private func runMix(plan: MixPlan, token: Int, outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode,
                        track: Track, file: AVAudioFile, index: Int, start: Double) {
        let outFX = fx(for: outgoing)
        let inFX = fx(for: incoming)
        let gain = normalizeVolume ? 1 : plan.levelGain
        let style = plan.style
        // Mix entre deux morceaux : bascule au milieu. Boucle / enchaînement sans blanc : bascule
        // DÈS que le début se fait entendre (la barre repart pile avec le son).
        let switchAt: Double = (style == .gapless || style == .loop) ? 0 : 0.5
        // Échange des basses sur le DERNIER temps avant la mesure du milieu : les basses de
        // l'entrante arrivent pile sur le temps fort (un swap à côté du temps sonne comme un raté).
        let swapWidth = plan.bars > 0 ? 1 / Double(4 * plan.bars) : 0.12
        automator.run(
            start: start,
            length: style == .gapless ? 0 : max(0.001, plan.length),
            switchAt: switchAt,
            apply: { t in
                Player.applyCurves(style: style, t: t, gain: gain, swapWidth: swapWidth, outgoing: outgoing, incoming: incoming, outFX: outFX, inFX: inFX)
            },
            onSwitch: { [weak self] in
                guard let self, token == self.fadeToken else { return }
                self.switchToIncoming(plan: plan, incoming: incoming, file: file, track: track, index: index, start: start)
            },
            onDone: { [weak self] in
                guard let self, token == self.fadeToken else { return }
                self.finishMix(plan: plan, token: token, outgoing: outgoing, incoming: incoming)
            }
        )
    }

    /// Bascule l'état du lecteur sur le morceau entrant (titre, pochette, barre, écran verrouillé).
    private func switchToIncoming(plan: MixPlan, incoming: AVAudioPlayerNode, file: AVAudioFile,
                                  track: Track, index: Int, start: Double) {
        let elapsed = max(0, hostNow() - start)
        activeDeck = incoming
        activeFile = file
        current = track
        queuePosition = index
        setAnchor(plan.entryAt + elapsed, rate: 1)
        pausedPosition = nil
        currentBPM = analyses[track.id]?.bpm
        currentKey = analyses[track.id]?.key
        diag("bascule sur « \(track.title) »")
        clock.duration = duration
        clock.position = livePosition()
        remember(track)
        extendQueueIfNeeded()
        updateNowPlaying()
    }

    /// Fin du chevauchement : la sortante s'arrête et retrouve sa vitesse normale. L'entrante
    /// joue déjà à son tempo naturel : rien à rattraper.
    private func finishMix(plan: MixPlan, token: Int, outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode) {
        if plan.style != .gapless { outgoing.stop() }
        outgoing.volume = 0
        resetFX(fx(for: outgoing))
        pitch(for: outgoing).rate = 1
        let inFX = fx(for: incoming)
        inFX.bands[0].gain = 0
        inFX.bands[1].bypass = true
        completeMix(incoming: incoming)
    }

    private func completeMix(incoming: AVAudioPlayerNode) {
        incoming.volume = 1
        pitch(for: incoming).rate = 1
        setAnchor(livePosition(), rate: 1)
        fading = false
        mixingInto = nil
        diag("mix terminé")
        pickSmartNext()
        refreshPlan()
        analyzeAhead()
    }

    /// Courbes de transition, selon le style. Appelée par l'automate (hors fil principal).
    nonisolated private static func applyCurves(style: MixPlan.Style, t: Double, gain: Double, swapWidth: Double,
                                                outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode,
                                                outFX: AVAudioUnitEQ, inFX: AVAudioUnitEQ) {
        switch style {
        case .beatmix:
            // 1re moitié : l'entrante monte (basses coupées), la sortante cède un peu de place.
            // Milieu : BASS SWAP, les deux à 0,82 (volume total ≈ +1 dB seulement). 2nde moitié :
            // la sortante s'efface, l'entrante prend toute la place. Jamais deux grosses caisses
            // à la fois, jamais un morceau qui écrase l'autre.
            if t < 0.5 {
                let rise = t / 0.5
                incoming.volume = Float(0.82 * sin(rise * .pi / 2) * gain)
                outgoing.volume = Float(1 - 0.18 * rise)
            } else {
                let fall = (t - 0.5) / 0.5
                incoming.volume = Float((0.82 + 0.18 * fall) * gain)
                outgoing.volume = Float(0.82 * cos(fall * .pi / 2))
            }
            let swap = min(1, max(0, (t - (0.5 - swapWidth)) / swapWidth))
            inFX.bands[0].gain = Float(-26 * (1 - swap))
            outFX.bands[0].gain = Float(-26 * swap)
        case .filter:
            // Fondu à puissance constante + la sortante s'éclaircit (passe-haut 30 Hz → 1,2 kHz).
            incoming.volume = Float(sin(t * .pi / 2) * gain)
            outgoing.volume = Float(cos(t * .pi / 2))
            outFX.bands[1].bypass = false
            outFX.bands[1].frequency = Float(30 * pow(40, t))
        case .crossfade:
            incoming.volume = Float(sin(t * .pi / 2) * gain)
            outgoing.volume = Float(cos(t * .pi / 2))
            let smooth = t * t * (3 - 2 * t)
            inFX.bands[0].gain = Float(-12 * (1 - smooth))
            outFX.bands[0].gain = Float(-12 * smooth)
        case .loop:
            // Raccord court à puissance constante, sans effet : la fin se fond dans le début.
            incoming.volume = Float(sin(t * .pi / 2) * gain)
            outgoing.volume = Float(cos(t * .pi / 2))
        case .gapless:
            break
        }
    }

    /// Arrête net une transition : l'autre platine se tait, la platine active repart à plein.
    private func cancelFade() {
        fadeToken += 1
        automator.cancel()
        if mixingInto != nil { mixingInto = nil }
        guard fading else { return }
        diag("mix interrompu (action manuelle ou relance)")
        fading = false
        let position = livePosition()
        let silent = other(than: activeDeck)
        silent.stop()
        silent.volume = 0
        resetFX(fxA)
        resetFX(fxB)
        activeDeck?.volume = 1
        pitchA.rate = 1
        pitchB.rate = 1
        if playing { setAnchor(position, rate: 1) }
    }

    // MARK: - Minuteur de sommeil

    func setSleepTimer(minutes: Int?) {
        if let minutes, minutes > 0 {
            sleepDeadline = Date().addingTimeInterval(Double(minutes) * 60)
            clock.sleepRemaining = minutes * 60
        } else {
            sleepDeadline = nil
            clock.sleepRemaining = nil
        }
    }

    var duration: Double {
        guard let file = activeFile, file.processingFormat.sampleRate > 0 else { return current?.duration ?? 0 }
        return Double(file.length) / file.processingFormat.sampleRate
    }

    var progress: Double { clock.progress }
}

// MARK: - Automate des transitions (fil temps réel)

/// Applique une courbe de transition toutes les 5 ms sur une file dédiée haute priorité, avec
/// l'horloge système (la même que celle du moteur audio). Les événements « bascule » et « fin »
/// sont renvoyés au fil principal, dans l'ordre. `cancel()` est synchrone : après son retour,
/// plus aucune courbe n'est appliquée.
final class MixAutomator: @unchecked Sendable {
    private let queue = DispatchQueue(label: "benten.mix.automation", qos: .userInteractive)
    private var timer: DispatchSourceTimer?
    private var generation = 0

    func run(start: Double, length: Double, switchAt: Double,
             apply: @escaping @Sendable (Double) -> Void,
             onSwitch: @escaping @MainActor () -> Void,
             onDone: @escaping @MainActor () -> Void) {
        queue.sync {
            timer?.cancel()
            generation += 1
            let current = generation
            var switched = false
            let source = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
            source.schedule(deadline: .now(), repeating: .milliseconds(5), leeway: .milliseconds(1))
            source.setEventHandler { [weak self] in
                guard let self, self.generation == current else { return }
                let elapsed = AVAudioTime.seconds(forHostTime: mach_absolute_time()) - start
                guard elapsed >= 0 else { return }
                let t = length > 0 ? min(1, elapsed / length) : 1
                apply(t)
                var events: [@MainActor () -> Void] = []
                if !switched && t >= switchAt {
                    switched = true
                    events.append(onSwitch)
                }
                if t >= 1 {
                    self.timer?.cancel()
                    self.timer = nil
                    self.generation += 1
                    events.append(onDone)
                }
                if !events.isEmpty {
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            for event in events { event() }
                        }
                    }
                }
            }
            timer = source
            source.resume()
        }
    }

    func cancel() {
        queue.sync {
            generation += 1
            timer?.cancel()
            timer = nil
        }
    }
}

// MARK: - Analyse de spectre (fil audio)

/// FFT 1024 points sur la sortie, regroupée en bandes logarithmiques (40 Hz – 16 kHz), lissée
/// (montée rapide, retombée douce). Tourne sur le fil du tap audio ; n'émet que 30 fois/s.
final class SpectrumAnalyzer: @unchecked Sendable {
    private let size = 1024
    private let log2n = vDSP_Length(10)
    private let setup: FFTSetup?
    private var window: [Float]
    private var frame: [Float]
    private var real: [Float]
    private var imag: [Float]
    private var magnitudes: [Float]
    private var smoothed: [Float]
    private var ranges: [(Int, Int)] = []
    private var sampleRate: Double = 0
    private var lastEmit: Double = 0
    private let bandCount: Int

    init(bandCount: Int) {
        self.bandCount = bandCount
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))
        window = [Float](repeating: 0, count: size)
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_NORM))
        frame = [Float](repeating: 0, count: size)
        real = [Float](repeating: 0, count: size / 2)
        imag = [Float](repeating: 0, count: size / 2)
        magnitudes = [Float](repeating: 0, count: size / 2)
        smoothed = [Float](repeating: 0, count: bandCount)
    }

    deinit {
        if let setup { vDSP_destroy_fftsetup(setup) }
    }

    private func computeRanges(_ rate: Double) {
        sampleRate = rate
        let nyquist = rate / 2
        let low = 40.0
        let high = min(16_000.0, nyquist * 0.95)
        ranges = (0..<bandCount).map { band in
            let f0 = low * pow(high / low, Double(band) / Double(bandCount))
            let f1 = low * pow(high / low, Double(band + 1) / Double(bandCount))
            let b0 = max(1, Int(f0 / rate * Double(size)))
            let b1 = max(b0 + 1, Int(f1 / rate * Double(size)))
            return (b0, min(size / 2, b1))
        }
    }

    func process(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        guard let setup, let channels = buffer.floatChannelData, Int(buffer.frameLength) >= size else { return nil }
        let rate = buffer.format.sampleRate
        if rate != sampleRate { computeRanges(rate) }

        vDSP_vmul(channels[0], 1, window, 1, &frame, 1, vDSP_Length(size))
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

        for (band, range) in ranges.enumerated() {
            var peak: Float = 0
            for bin in range.0..<range.1 { peak = max(peak, magnitudes[bin]) }
            let decibels = 10 * log10(peak + 1e-9)
            let level = min(1, max(0, (decibels + 5) / 55))
            let previous = smoothed[band]
            smoothed[band] = level > previous ? previous + (level - previous) * 0.65 : previous + (level - previous) * 0.18
        }

        let now = AVAudioTime.seconds(forHostTime: mach_absolute_time())
        guard now - lastEmit >= 1.0 / 30.0 else { return nil }
        lastEmit = now
        return smoothed
    }
}
