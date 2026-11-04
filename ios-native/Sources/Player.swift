import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Fréquences des 10 bandes de l'égaliseur (Hz). Constante globale : lisible de partout.
let equalizerBandFrequencies: [Double] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/// Clés de sauvegarde des réglages du lecteur (UserDefaults).
fileprivate enum Keys {
    static let crossfade = "player.crossfade"
    static let beatMatched = "player.beatMatched"
    static let repeatMode = "player.repeat"
    static let shuffle = "player.shuffle"
    static let eqEnabled = "eq.enabled"
    static let eqGains = "eq.gains"
    static let eqPreamp = "eq.preamp"
    static let eqPreset = "eq.preset"
    static let eqCustom = "eq.custom"
    static let eqAutoHeadroom = "eq.autoHeadroom"
}

/// Lecteur audio natif, sur `AVAudioEngine`.
///
///     platine A ─► timePitch A ─┐
///                                ├─► mixeur de fondu ─► EQ 10 bandes ─► sortie
///     platine B ─► timePitch B ─┘
///
/// Deux platines = l'AUTOMIX (fondu enchaîné). Les `timePitch` accordent le tempo de la piste
/// entrante SANS changer la hauteur (beatmatch). Tout tourne en arrière-plan / écran verrouillé
/// grâce à la session `.playback` + le mode d'arrière-plan `audio`.
@MainActor
final class Player: NSObject, ObservableObject {
    // MARK: - Réglages persistés

    nonisolated private static func storedDouble(_ key: String, _ fallback: Double) -> Double {
        UserDefaults.standard.object(forKey: key) as? Double ?? fallback
    }

    nonisolated private static func storedBool(_ key: String, _ fallback: Bool) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? fallback
    }

    nonisolated private static func storedRepeat() -> RepeatMode {
        RepeatMode(rawValue: UserDefaults.standard.string(forKey: Keys.repeatMode) ?? "") ?? .all
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

    // MARK: - État observé par l'interface

    @Published private(set) var current: Track?
    @Published private(set) var playing = false
    /// Horloge séparée : la grille des pochettes ne se redessine pas à chaque tick.
    let clock = PlaybackClock()
    var position: Double { clock.position }
    @Published private(set) var currentBPM: Double?
    @Published var showFullScreen = false

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

    /// Durée de l'AUTOMIX en secondes (0 = enchaînement sec). Activé par défaut (8 s), et SAUVEGARDÉ :
    /// avant, il revenait à 0 à chaque lancement — l'automix était donc toujours coupé.
    @Published var crossfade: Double = Player.storedDouble(Keys.crossfade, 8) {
        didSet { UserDefaults.standard.set(crossfade, forKey: Keys.crossfade) }
    }

    /// Cale le fondu sur les temps et accorde le tempo (beatmatch).
    @Published var beatMatched: Bool = Player.storedBool(Keys.beatMatched, true) {
        didSet { UserDefaults.standard.set(beatMatched, forKey: Keys.beatMatched) }
    }

    var automixEnabled: Bool { crossfade > 0 }

    func setAutomix(_ on: Bool) {
        crossfade = on ? 8 : 0
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

    /// Préampli (dB), appliqué avant les bandes.
    @Published var eqPreamp: Double = Player.storedDouble(Keys.eqPreamp, 0) {
        didSet {
            applyEqualizer()
            UserDefaults.standard.set(eqPreamp, forKey: Keys.eqPreamp)
        }
    }

    /// Anti-saturation : baisse automatiquement le gain global quand des bandes sont poussées,
    /// pour que les basses d'un phonk ne grésillent pas.
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

    /// Préréglages intégrés, dans l'ordre d'affichage.
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

    /// Tous les préréglages (intégrés + perso).
    var allPresetNames: [String] {
        Self.builtInPresets.map(\.name) + customPresets.keys.sorted()
    }

    func gains(forPreset name: String) -> [Double]? {
        if let custom = customPresets[name] { return custom }
        return Self.builtInPresets.first { $0.name == name }?.gains
    }

    func applyPreset(_ name: String) {
        guard let gains = gains(forPreset: name) else { return }
        eqGains = gains
        eqPresetName = name
        if !eqEnabled { eqEnabled = true }
    }

    /// Réglage manuel d'une bande : le préréglage devient « Personnalisé ».
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

    private let analyzer = TrackAnalyzer()
    private var analyses: [UUID: TrackAnalysis] = [:]
    private var activeDeck: AVAudioPlayerNode?
    private var activeFile: AVAudioFile?

    /// Horloge murale de la lecture en cours (réajustée à chaque pause / reprise / seek).
    private var startedAt: Date?
    /// Position figée pendant la pause. Avant, la pause n'était pas comptée : à la reprise
    /// l'horloge sautait en avant et l'automix se déclenchait au mauvais moment.
    private var pausedPosition: Double?

    /// Jeton de programmation : un `stop()` (seek, chargement) déclenche le callback de fin de la
    /// programmation précédente ; on l'ignore si le jeton a changé.
    private var scheduleToken = 0
    /// Jeton de fondu : toute action manuelle l'incrémente, ce qui ANNULE proprement un fondu en
    /// cours. Avant, un « suivant » pendant un fondu laissait l'ancien fondu couper le nouveau titre.
    private var fadeToken = 0
    private var fading = false

    private var timer: Timer?
    private var order: [Int] = []
    private var queue: [Track] = []
    private var queuePosition = 0
    private var failedLoads = 0
    private var sleepDeadline: Date?
    private var wasPlayingBeforeInterruption = false

    private var artworkTrackID: UUID?
    private var nowPlayingArtwork: MPMediaItemArtwork?

    override init() {
        super.init()
        configureEngine()
        configureSession()
        configureRemoteCommands()
        observeAudioSession()
        applyEqualizer()
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // Mode .common : le minuteur continue PENDANT un défilement (sinon l'horloge et l'automix
        // se figeaient tant qu'on faisait défiler la bibliothèque).
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func configureEngine() {
        for node in [deckA, deckB, pitchA, pitchB, crossMixer, equalizer] as [AVAudioNode] {
            engine.attach(node)
        }

        let last = Self.equalizerFrequencies.count - 1
        for (index, frequency) in Self.equalizerFrequencies.enumerated() {
            let band = equalizer.bands[index]
            // Plateaux aux extrémités (rendu naturel), cloches au milieu.
            band.filterType = index == 0 ? .lowShelf : (index == last ? .highShelf : .parametric)
            band.frequency = Float(frequency)
            band.bandwidth = 1.0
            band.gain = 0
            band.bypass = true
        }

        engine.connect(deckA, to: pitchA, format: nil)
        engine.connect(deckB, to: pitchB, format: nil)
        engine.connect(pitchA, to: crossMixer, fromBus: 0, toBus: 0, format: nil)
        engine.connect(pitchB, to: crossMixer, fromBus: 0, toBus: 1, format: nil)
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

    /// Suit la vie de la session audio, comme Apple Music :
    /// - appel / Siri : pause, puis reprise seulement si on jouait ;
    /// - casque débranché : pause ;
    /// - changement de matériel (AirPods, Bluetooth, AirPlay) : iOS ARRÊTE le moteur audio — on le
    ///   relance et on reprend au même endroit (avant : silence jusqu'à relancer l'app).
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
            startedAt = Date().addingTimeInterval(-resumeAt)
            pausedPosition = nil
        } else {
            pausedPosition = resumeAt
        }
        clock.position = resumeAt
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

    // MARK: - Commandes distantes (écran verrouillé, casque, CarPlay, Centre de contrôle)

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

    /// Infos de l'écran verrouillé. Mises à jour aux CHANGEMENTS d'état seulement (iOS extrapole le
    /// temps tout seul) — avant, tout le dictionnaire, pochette comprise, était renvoyé 4×/s.
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
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
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
    }

    private var nextIndexInOrder: Int? {
        guard let at = order.firstIndex(of: queuePosition) else { return nil }
        if at + 1 < order.count { return order[at + 1] }
        return repeatMode == .all ? order.first : nil
    }

    private var upcomingTrack: Track? {
        nextIndexInOrder.flatMap { queue.indices.contains($0) ? queue[$0] : nil }
    }

    func play(_ tracks: [Track], startingAt startIndex: Int) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        queuePosition = min(max(0, startIndex), tracks.count - 1)
        rebuildOrder()
        failedLoads = 0
        load(track: queue[queuePosition])
    }

    /// Lecture aléatoire d'une liste (bouton « Aléatoire » des albums / playlists).
    func playShuffled(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        shuffle = true
        play(tracks, startingAt: Int.random(in: 0..<tracks.count))
    }

    private func load(track: Track, at seconds: Double = 0) {
        cancelFade()
        guard let file = try? AVAudioFile(forReading: track.fileURL) else {
            // Fichier illisible : on passe au suivant, sans boucler à l'infini si tout est cassé.
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
        deckA.volume = 1
        deckB.volume = 0
        activeDeck = deckA
        activeFile = file
        current = track
        currentBPM = analyses[track.id]?.bpm

        let start = max(0, seconds)
        schedule(on: deckA, file: file, from: start)
        deckA.play()
        playing = true
        startedAt = Date().addingTimeInterval(-start)
        pausedPosition = nil
        clock.position = start
        clock.duration = duration
        updateNowPlaying()
        analyzeCurrentAndUpcoming()
    }

    /// Analyse (tempo, niveau, silences) du morceau en cours ET du suivant, en avance : quand
    /// l'automix arrive, tout est déjà prêt — le fondu démarre pile au bon moment.
    private func analyzeCurrentAndUpcoming() {
        guard let current else { return }
        let upcoming = upcomingTrack
        let analyzer = self.analyzer
        Task { [weak self] in
            let mine = await analyzer.analysis(of: current)
            guard let self else { return }
            self.analyses[current.id] = mine
            if self.current?.id == current.id { self.currentBPM = mine.bpm }
            if let upcoming {
                let next = await analyzer.analysis(of: upcoming)
                self.analyses[upcoming.id] = next
                // Pochettes du suivant préparées en avance : au changement de morceau (automix
                // compris), la nouvelle pochette s'affiche instantanément, sans clignotement.
                for size in [CGFloat(180), 260, 1000] {
                    _ = await ArtworkCache.shared.load(for: upcoming, maxPixel: size)
                }
            }
        }
    }

    private func schedule(on deck: AVAudioPlayerNode, file: AVAudioFile, from seconds: Double) {
        let rate = file.processingFormat.sampleRate
        let frame = AVAudioFramePosition(max(0, seconds) * rate)
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        scheduleToken += 1
        let token = scheduleToken
        guard remaining > 0 else { return }
        deck.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                // Seule une fin NATURELLE enchaîne : un callback périmé (stop provoqué par un
                // seek / un chargement / un fondu) est ignoré.
                guard let self, self.activeDeck === deck, self.scheduleToken == token else { return }
                self.handleFinished()
            }
        }
    }

    /// Fin naturelle d'un morceau (sans automix, ou automix désactivé).
    private func handleFinished() {
        if fading { return }
        if repeatMode == .one, let current {
            load(track: current)
            return
        }
        advance(manual: false)
    }

    /// Passe au morceau suivant. `manual` : bouton « suivant » — on avance TOUJOURS, même en
    /// « répéter ce titre » (avant, « suivant » relançait le même morceau).
    private func advance(manual: Bool) {
        guard !queue.isEmpty, let at = order.firstIndex(of: queuePosition) else { return }
        if at + 1 < order.count {
            queuePosition = order[at + 1]
        } else if repeatMode != .off || manual {
            if shuffle { rebuildOrder() }
            queuePosition = order.first ?? 0
        } else {
            // Fin de la file, sans répétition : on s'arrête au début du dernier titre.
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
            // Le moteur a été coupé (appel, Siri, changement de sortie) : on reprogramme.
            ensureEngineRunning()
            deck.stop()
            schedule(on: deck, file: file, from: resumeAt)
        }
        deck.volume = 1
        deck.play()
        startedAt = Date().addingTimeInterval(-resumeAt)
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
            startedAt = Date().addingTimeInterval(-clamped)
            pausedPosition = nil
        } else {
            pausedPosition = clamped
        }
        clock.position = clamped
        updateNowPlaying()
    }

    func next() {
        advance(manual: true)
    }

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

    // MARK: - Horloge et automix

    private func livePosition() -> Double {
        if !playing { return pausedPosition ?? clock.position }
        guard let startedAt else { return clock.position }
        return min(duration, max(0, Date().timeIntervalSince(startedAt)))
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
        if abs(clock.position - now) > 0.05 { clock.position = now }
        let total = duration
        if clock.duration != total { clock.duration = total }
        maybeStartAutomix(at: now, duration: total)
    }

    /// Déclenche l'automix : AVANT la queue silencieuse du morceau (comme AutoMix d'Apple), sur
    /// une durée calée sur les temps, jamais plus d'un quart du morceau.
    private func maybeStartAutomix(at now: Double, duration total: Double) {
        guard crossfade > 0, !fading, total > 8, repeatMode != .one,
              let current, upcomingTrack != nil else { return }
        let end = min(total, analyses[current.id]?.end ?? total)
        let wanted = beatMatched ? AudioMath.quantizeFadeToBeats(crossfade, bpm: currentBPM) : crossfade
        let length = min(wanted, max(2, end * 0.25))
        guard end - now <= length else { return }
        fading = true
        fadeToken += 1
        let token = fadeToken
        let fadeLength = max(1, end - now)
        Task { await crossfadeNext(fadeLength: fadeLength, token: token) }
    }

    /// Fondu enchaîné : égalité de puissance, tempo accordé (hauteur préservée), volumes égalisés,
    /// intro silencieuse de l'entrante sautée. Annulable à tout moment via `fadeToken`.
    private func crossfadeNext(fadeLength: Double, token: Int) async {
        guard let nextIndex = nextIndexInOrder, queue.indices.contains(nextIndex) else {
            fading = false
            return
        }
        let outgoingTrack = queue[queuePosition]
        let incomingTrack = queue[nextIndex]
        guard let file = try? AVAudioFile(forReading: incomingTrack.fileURL) else {
            fading = false
            return
        }

        var cachedOutgoing = analyses[outgoingTrack.id]
        if cachedOutgoing == nil {
            let value = await analyzer.analysis(of: outgoingTrack)
            analyses[outgoingTrack.id] = value
            cachedOutgoing = value
        }
        var cachedIncoming = analyses[incomingTrack.id]
        if cachedIncoming == nil {
            let value = await analyzer.analysis(of: incomingTrack)
            analyses[incomingTrack.id] = value
            cachedIncoming = value
        }
        guard token == fadeToken, let outgoingInfo = cachedOutgoing, let incomingInfo = cachedIncoming else { return }

        let tempoRatio = beatMatched ? AudioMath.tempoMatchRatio(outgoing: outgoingInfo.bpm, incoming: incomingInfo.bpm) : 1
        let levelGain = AudioMath.loudnessGain(outgoing: outgoingInfo.level, incoming: incomingInfo.level)
        let startAt = min(incomingInfo.start, 8)

        let outgoing = activeDeck
        let outgoingPitch: AVAudioUnitTimePitch = (outgoing === deckA) ? pitchA : pitchB
        let incoming: AVAudioPlayerNode = (outgoing === deckA) ? deckB : deckA
        let incomingPitch: AVAudioUnitTimePitch = (outgoing === deckA) ? pitchB : pitchA

        ensureEngineRunning()
        incoming.stop()
        incoming.volume = 0
        incomingPitch.rate = Float(tempoRatio)
        schedule(on: incoming, file: file, from: startAt)
        incoming.play()

        activeDeck = incoming
        activeFile = file
        current = incomingTrack
        queuePosition = nextIndex
        startedAt = Date().addingTimeInterval(-startAt)
        pausedPosition = nil
        currentBPM = incomingInfo.bpm
        clock.position = startAt
        clock.duration = duration
        updateNowPlaying()
        analyzeCurrentAndUpcoming()

        // Rampes : cos sur la sortante, sin sur l'entrante (puissance constante), 25 pas/s.
        let steps = max(10, Int(fadeLength * 25))
        let interval = fadeLength / Double(steps)
        for step in 1...steps {
            guard token == fadeToken else { return }
            let t = Double(step) / Double(steps)
            outgoing?.volume = Float(cos(t * .pi / 2))
            incoming.volume = Float(sin(t * .pi / 2) * levelGain)
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
        guard token == fadeToken else { return }
        outgoing?.stop()
        outgoing?.volume = 0
        outgoingPitch.rate = 1

        // Retour en douceur au tempo et au niveau d'origine de l'entrante (3 s).
        let settleSteps = 30
        for step in 1...settleSteps {
            guard token == fadeToken else { return }
            let t = Double(step) / Double(settleSteps)
            incoming.volume = Float(levelGain + (1 - levelGain) * t)
            incomingPitch.rate = Float(tempoRatio + (1 - tempoRatio) * t)
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        guard token == fadeToken else { return }
        incoming.volume = 1
        incomingPitch.rate = 1
        fading = false
    }

    /// Arrête net un fondu en cours : la platine sortante se tait, l'entrante passe à plein volume.
    private func cancelFade() {
        fadeToken += 1
        guard fading else { return }
        fading = false
        let other: AVAudioPlayerNode = (activeDeck === deckA) ? deckB : deckA
        other.stop()
        other.volume = 0
        activeDeck?.volume = 1
        pitchA.rate = 1
        pitchB.rate = 1
    }

    // MARK: - Minuteur de sommeil

    /// Avant : le compteur baissait d'une « seconde » à chaque tick de 0,25 s → minuteur 4× trop
    /// rapide. Maintenant : une échéance réelle.
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
