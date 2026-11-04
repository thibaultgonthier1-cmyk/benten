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
        if !engine.isRunning {
            try? AVAudioSession.sharedInstance().setActive(true)
            try? engine.start()
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
                    self.wasPlayingBeforeInterruption = self.playing
                    self.pause()
                case .ended:
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
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
                if reason == .oldDeviceUnavailable { self.pause() }
            }
        }

        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.recoverEngine() }
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
        if tapInstalled {
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
            guard format.sampleRate > 0 else { return }
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
        }
        order = indices
        refreshPlan()
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
        queuePosition = min(max(0, startIndex), tracks.count - 1)
        failedLoads = 0
        rebuildOrder()
        load(track: queue[queuePosition])
    }

    func playShuffled(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        queuePosition = Int.random(in: 0..<tracks.count)
        failedLoads = 0
        if shuffle { rebuildOrder() } else { shuffle = true }
        load(track: queue[queuePosition])
    }

    private func load(track: Track, at seconds: Double = 0) {
        cancelFade()
        guard let file = try? AVAudioFile(forReading: track.fileURL) else {
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
        currentKey = analyses[track.id]?.key

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
        var picks = Array(pool.prefix(12))
        if let bpm = analyses[current.id]?.bpm {
            func distance(_ track: Track) -> Double {
                guard let other = analyses[track.id]?.bpm else { return 0.5 }
                return abs(log(AudioMath.tempoRatio(outgoing: bpm, incoming: other)))
            }
            picks.sort { distance($0) < distance($1) }
        }
        let base = queue.count
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
        let analyzer = self.analyzer
        analysisTask?.cancel()
        analysisTask = Task { [weak self] in
            for (index, track) in chain.enumerated() {
                if Task.isCancelled { return }
                let result = await analyzer.analysis(of: track)
                guard let self else { return }
                self.analyses[track.id] = result
                if self.current?.id == track.id {
                    self.currentBPM = result.bpm
                    self.currentKey = result.key
                }
                if index <= 1 { self.refreshPlan() }
                if index == 1 {
                    // Pochettes du suivant préparées : affichage instantané au changement.
                    for size in [CGFloat(180), 260, 1000] {
                        _ = await ArtworkCache.shared.load(for: track, maxPixel: size)
                    }
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

    func previous() {
        guard !queue.isEmpty else { return }
        if livePosition() > 3 {
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
    }

    private func livePosition() -> Double {
        if !playing { return pausedPosition ?? clock.position }
        return min(duration, max(0, anchorPosition + (hostNow() - anchorHost) * anchorRate))
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

        guard playing else { return }
        let now = livePosition()
        if abs(clock.position - now) > 0.04 { clock.position = now }
        let total = duration
        if clock.duration != total { clock.duration = total }

        guard automixEnabled, !fading,
              let plan, planTrackID == current?.id else { return }
        // On prépare 1,2 s avant le point de sortie ; si on a déjà dépassé la moitié du
        // chevauchement prévu (seek tardif), on laisse le morceau finir normalement.
        if now >= plan.exitAt - 1.2, now < plan.exitAt + max(0.3, plan.length * 0.5) {
            startMix(plan)
        }
    }

    // MARK: - Transition

    private func startMix(_ plan: MixPlan) {
        guard let nextIndex = nextIndexInOrder, queue.indices.contains(nextIndex),
              let outgoing = activeDeck else { return }
        let incomingTrack = queue[nextIndex]
        guard let file = try? AVAudioFile(forReading: incomingTrack.fileURL) else { return }

        fadeToken += 1
        let token = fadeToken
        fading = true

        let incoming = other(than: outgoing)
        let incomingFX = fx(for: incoming)
        let outgoingRate = max(0.5, Double(pitch(for: outgoing).rate))

        ensureEngineRunning()
        incoming.stop()
        resetFX(incomingFX)
        incoming.volume = plan.style == .gapless ? 1 : 0
        if plan.bassSwap { incomingFX.bands[0].gain = plan.style == .beatmix ? -26 : -12 }
        pitch(for: incoming).rate = Float(plan.tempoRatio)
        schedule(on: incoming, file: file, from: plan.entryAt)

        // Heure exacte où la sortante atteint le point de sortie (horloge du moteur).
        let nowHost = mach_absolute_time()
        var startHost: UInt64
        if let render = renderPosition(of: outgoing) {
            let delta = max(0, (plan.exitAt - render.position) / outgoingRate)
            startHost = render.host + AVAudioTime.hostTime(forSeconds: delta)
            // On recale aussi l'horloge d'affichage sur la position réelle.
            let elapsed = AVAudioTime.seconds(forHostTime: nowHost) - AVAudioTime.seconds(forHostTime: render.host)
            setAnchor(render.position + max(0, elapsed) * outgoingRate, rate: outgoingRate)
        } else {
            let delta = max(0, (plan.exitAt - livePosition()) / outgoingRate)
            startHost = nowHost + AVAudioTime.hostTime(forSeconds: delta)
        }
        let earliest = nowHost + AVAudioTime.hostTime(forSeconds: 0.03)
        if startHost < earliest { startHost = earliest }
        incoming.play(at: AVAudioTime(hostTime: startHost))

        mixingInto = incomingTrack
        Task {
            await runMix(plan: plan, token: token, outgoing: outgoing, incoming: incoming,
                         track: incomingTrack, file: file, index: nextIndex,
                         start: AVAudioTime.seconds(forHostTime: startHost))
        }
    }

    /// Exécute les courbes de la transition (volumes, bass swap, filtre), bascule l'état sur le
    /// nouveau morceau au milieu, puis ramène tempo et niveau à la normale en douceur.
    private func runMix(plan: MixPlan, token: Int, outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode,
                        track: Track, file: AVAudioFile, index: Int, start: Double) async {
        let length = max(0.001, plan.length)
        let outFX = fx(for: outgoing)
        let inFX = fx(for: incoming)
        var switched = false

        while true {
            guard token == fadeToken else { return }
            let elapsed = hostNow() - start
            let t = elapsed / length
            if elapsed >= 0 {
                if plan.style != .gapless {
                    applyCurves(plan, t: min(1, t), outgoing: outgoing, incoming: incoming, outFX: outFX, inFX: inFX)
                }
                if !switched && (plan.style == .gapless || t >= 0.5) {
                    switched = true
                    activeDeck = incoming
                    activeFile = file
                    current = track
                    queuePosition = index
                    setAnchor(plan.entryAt + max(0, elapsed) * plan.tempoRatio, rate: plan.tempoRatio)
                    pausedPosition = nil
                    currentBPM = analyses[track.id]?.bpm
                    currentKey = analyses[track.id]?.key
                    clock.duration = duration
                    clock.position = livePosition()
                    remember(track)
                    extendQueueIfNeeded()
                    updateNowPlaying()
                }
                if plan.style == .gapless || t >= 1 { break }
            }
            try? await Task.sleep(nanoseconds: 12_000_000)
        }
        guard token == fadeToken else { return }

        if plan.style != .gapless {
            outgoing.stop()
        }
        outgoing.volume = 0
        resetFX(outFX)
        pitch(for: outgoing).rate = 1
        inFX.bands[0].gain = 0
        inFX.bands[1].bypass = true

        // Retour progressif au tempo d'origine et au niveau propre de l'entrante (6 s, courbe douce).
        let ratio = plan.tempoRatio
        let gain = plan.style == .gapless ? 1 : plan.levelGain
        if abs(ratio - 1) > 0.0005 || abs(gain - 1) > 0.01 {
            let glideStart = hostNow()
            while true {
                guard token == fadeToken else { return }
                let u = min(1, (hostNow() - glideStart) / 6)
                let smooth = u * u * (3 - 2 * u)
                let rate = ratio + (1 - ratio) * smooth
                let position = livePosition()
                pitch(for: incoming).rate = Float(rate)
                setAnchor(position, rate: rate)
                incoming.volume = Float(gain + (1 - gain) * smooth)
                if u >= 1 { break }
                try? await Task.sleep(nanoseconds: 30_000_000)
            }
        }
        guard token == fadeToken else { return }
        incoming.volume = 1
        pitch(for: incoming).rate = 1
        setAnchor(livePosition(), rate: 1)
        fading = false
        mixingInto = nil
        refreshPlan()
        analyzeAhead()
    }

    /// Courbes de transition, selon le style.
    private func applyCurves(_ plan: MixPlan, t: Double, outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode,
                             outFX: AVAudioUnitEQ, inFX: AVAudioUnitEQ) {
        let gain = plan.levelGain
        switch plan.style {
        case .beatmix:
            // L'entrante monte (basses coupées) pendant la 1re moitié ; BASS SWAP au milieu ;
            // la sortante descend pendant la 2nde moitié. Jamais deux grosses caisses à la fois.
            let rise = min(1, t / 0.5)
            incoming.volume = Float(sin(rise * .pi / 2) * gain)
            let fall = max(0, (t - 0.5) / 0.5)
            outgoing.volume = Float(t < 0.5 ? 1 - 0.12 * rise : 0.88 * cos(fall * .pi / 2))
            let swap = min(1, max(0, (t - 0.44) / 0.12))
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
        case .gapless:
            break
        }
    }

    /// Arrête net une transition : l'autre platine se tait, la platine active repart à plein.
    private func cancelFade() {
        fadeToken += 1
        if mixingInto != nil { mixingInto = nil }
        guard fading else { return }
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
