import AVFoundation
import Foundation
import MediaPlayer

/// Lecteur audio natif, sur `AVAudioEngine` — même architecture que le moteur du bureau.
///
///     platine A ─► timePitch A ─┐
///                                ├─► mixeur de fondu ─► EQ 10 bandes ─► sortie
///     platine B ─► timePitch B ─┘
///
/// Deux platines permettent le fondu enchaîné ; les `timePitch` permettent d'ACCORDER le tempo de
/// la piste entrante **sans changer la hauteur** (le PC, lui, devait se limiter à ±6 % avec
/// `playbackRate`, qui déforme le pitch).
@MainActor
final class Player: NSObject, ObservableObject {
    // MARK: - État observé par l'interface

    @Published private(set) var current: Track?
    @Published private(set) var playing = false
    /// Horloge séparée : la grille des pochettes ne se redessine plus à chaque tick.
    let clock = PlaybackClock()
    /// Position courante, en lecture seule (lue par les vues qui ne veulent qu'un instantané).
    var position: Double { clock.position }
    @Published private(set) var currentBPM: Double?
    @Published var showFullScreen = false
    @Published var repeatMode: RepeatMode = .all { didSet { rebuildOrder() } }
    @Published var shuffle = false { didSet { rebuildOrder() } }
    /// Durée de fondu demandée (0 = enchaînement sec).
    @Published var crossfade: Double = 0
    /// Cale la durée du fondu sur une mesure et accorde le tempo (comme le PC).
    @Published var beatMatched = true

    @Published var eqGains: [Double] = Array(repeating: 0, count: Player.equalizerFrequencies.count) {
        didSet { applyEqualizer() }
    }
    @Published var eqEnabled = false { didSet { applyEqualizer() } }
    @Published private(set) var sleepRemaining: Int?

    enum RepeatMode: String, Codable, CaseIterable { case off, all, one }

    static let equalizerFrequencies: [Double] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    static let presets: [String: [Double]] = [
        "Plat": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "Koto": [3, 2, 0, -1, -2, 0, 2, 3, 2, 1],
        "Basses": [6, 5, 3, 1, 0, 0, 0, 0, 0, 0],
        "Voix": [-2, -1, 0, 2, -2, -2, 0, 2, 3, 2],
        "Nuit": [-3, -2, -1, 0, 1, 1, 0, -2, -3, -4],
    ]

    // MARK: - Moteur

    private let engine = AVAudioEngine()
    private let equalizer = AVAudioUnitEQ(numberOfBands: 10)
    private let crossMixer = AVAudioMixerNode()
    private let deckA = AVAudioPlayerNode()
    private let deckB = AVAudioPlayerNode()
    private let pitchA = AVAudioUnitTimePitch()
    private let pitchB = AVAudioUnitTimePitch()

    private let analyzer = TrackAnalyzer()
    private var fileA: AVAudioFile?
    private var fileB: AVAudioFile?
    private var activeDeck: AVAudioPlayerNode?
    private var activeFile: AVAudioFile?
    private var startedAt: Date?
    // Jeton de programmation : incrémenté à CHAQUE programmation. Un `stop()` (ex. pendant un
    // seek) déclenche le callback de la programmation précédente ; on l'ignore si le jeton a changé.
    private var scheduleToken = 0
    private var timer: Timer?
    private var fading = false
    private var order: [Int] = []
    private var queue: [Track] = []
    private var queuePosition = 0

    /// État avant une interruption système (appel, Siri, réveil) : sert à reprendre après.
    private var wasPlayingBeforeInterruption = false

    override init() {
        super.init()
        configureEngine()
        configureSession()
        configureRemoteCommands()
        observeAudioSession()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func configureEngine() {
        for node in [deckA, deckB, pitchA, pitchB, crossMixer, equalizer] as [AVAudioNode] {
            engine.attach(node)
        }

        for (index, frequency) in Self.equalizerFrequencies.enumerated() {
            let band = equalizer.bands[index]
            band.filterType = .parametric
            band.frequency = Float(frequency)
            band.bandwidth = 1.0
            band.gain = 0
            band.bypass = true
        }

        // Deux entrées dans le mixeur de fondu (bus 0 et 1), puis l'égaliseur commun.
        engine.connect(deckA, to: pitchA, format: nil)
        engine.connect(deckB, to: pitchB, format: nil)
        engine.connect(pitchA, to: crossMixer, fromBus: 0, toBus: 0, format: nil)
        engine.connect(pitchB, to: crossMixer, fromBus: 0, toBus: 1, format: nil)
        engine.connect(crossMixer, to: equalizer, format: nil)
        engine.connect(equalizer, to: engine.mainMixerNode, format: nil)

        deckA.volume = 1
        deckB.volume = 0
        deckA.rate = 1
        deckB.rate = 1

        do {
            try engine.start()
        } catch {
            print("[benten] moteur audio indisponible : \(error.localizedDescription)")
        }
    }

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        // `.playback` est la catégorie des apps de musique : le son continue écran verrouillé et
        // quand une autre app passe au premier plan. `.mixWithOthers` serait l'inverse.
        try? session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetoothA2DP])
        try? session.setActive(true)
    }

    /// Suit la vie de la session audio : c'est ce qui distingue « ça joue » de « ça joue comme
    /// Apple Music ».
    ///
    /// - INTERRUPTION (appel, Siri) : on met en pause, et on reprend seulement si on jouait ;
    /// - FIN D'INTERRUPTION : on réactive la session et le moteur (iOS les a coupés) ;
    /// - DÉBRANCHEMENT DU CASQUE : on met en pause, comme le fait Apple (le son ne part pas dans
    ///   le haut-parleur du téléphone).
    private func observeAudioSession() {
        let center = NotificationCenter.default
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                guard let self else { return }
                guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                switch type {
                case .began:
                    self.wasPlayingBeforeInterruption = self.playing
                    self.pause()
                case .ended:
                    let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
                    if options.contains(.shouldResume) || self.wasPlayingBeforeInterruption {
                        try? AVAudioSession.sharedInstance().setActive(true)
                        if !self.engine.isRunning { try? self.engine.start() }
                        self.resume()
                    }
                @unknown default:
                    break
                }
            }
        }

        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                guard let self else { return }
                guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                      let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
                // Casque débranché : on met en pause (comportement iOS attendu).
                if reason == .oldDeviceUnavailable {
                    self.pause()
                }
            }
        }
    }

    private func applyEqualizer() {
        for (index, band) in equalizer.bands.enumerated() {
            band.bypass = !eqEnabled
            band.gain = Float(eqGains.indices.contains(index) ? eqGains[index] : 0)
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
            Task { @MainActor in self?.seek(to: event.positionTime) }
            return .success
        }
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [:]
        if let current {
            info[MPMediaItemPropertyTitle] = current.title
            info[MPMediaItemPropertyArtist] = current.artist
            info[MPMediaItemPropertyAlbumTitle] = current.album
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
            if let url = current.artworkURL, let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            }
        }
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1 : 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
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

    func play(_ tracks: [Track], startingAt startIndex: Int) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        queuePosition = min(max(0, startIndex), tracks.count - 1)
        rebuildOrder()
        load(track: queue[queuePosition], at: 0)
    }

    private func load(track: Track, at seconds: Double) {
        guard let file = try? AVAudioFile(forReading: track.fileURL) else {
            next()
            return
        }
        deckA.stop()
        deckB.stop()
        pitchA.rate = 1
        pitchB.rate = 1
        deckA.volume = 1
        deckB.volume = 0
        activeDeck = deckA
        activeFile = file
        fileA = file
        current = track
        startedAt = Date().addingTimeInterval(-seconds)
        schedule(on: deckA, file: file, from: AVAudioFramePosition(max(0, seconds) * file.processingFormat.sampleRate))
        deckA.play()
        playing = true
        fading = false
        syncClock(seconds)
        updateNowPlaying()
        refreshTempo(for: track)
    }

    private func refreshTempo(for track: Track) {
        Task { [weak self] in
            guard let self else { return }
            let bpm = await self.analyzer.bpm(of: track)
            self.currentBPM = bpm
        }
    }

    private func schedule(on deck: AVAudioPlayerNode, file: AVAudioFile, from frame: AVAudioFramePosition) {
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        guard remaining > 0 else { return }
        scheduleToken += 1
        let token = scheduleToken
        deck.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                // Seule une fin NATURELLE enchaîne : si le jeton a changé (stop provoqué par un
                // seek/un chargement), ce callback est périmé et on l'ignore.
                guard let self, self.activeDeck === deck, self.scheduleToken == token else { return }
                self.handleFinished()
            }
        }
    }

    private func handleFinished() {
        if fading { return }
        next()
    }

    // MARK: - Transport

    func resume() {
        if !engine.isRunning { try? engine.start() }
        activeDeck?.play()
        playing = true
        updateNowPlaying()
    }

    func pause() {
        activeDeck?.pause()
        playing = false
        updateNowPlaying()
    }

    func toggle() { playing ? pause() : resume() }

    func seek(to seconds: Double) {
        guard let file = activeFile else { return }
        let wasPlaying = playing
        activeDeck?.stop()
        let clamped = max(0, min(seconds, duration))
        clock.position = clamped
        startedAt = Date().addingTimeInterval(-clamped)
        if let deck = activeDeck {
            schedule(on: deck, file: file, from: AVAudioFramePosition(clamped * file.processingFormat.sampleRate))
            if wasPlaying { deck.play() }
        }
        updateNowPlaying()
    }

    func next() {
        guard !queue.isEmpty else { return }
        fading = false // une action manuelle annule un fondu en cours
        pitchA.rate = 1
        pitchB.rate = 1
        if repeatMode == .one {
            load(track: queue[queuePosition], at: 0)
            return
        }
        guard let positionInOrder = order.firstIndex(of: queuePosition) else { return }
        let nextPosition = positionInOrder + 1
        if nextPosition < order.count {
            queuePosition = order[nextPosition]
        } else if repeatMode == .all {
            rebuildOrder()
            queuePosition = order.first ?? 0
        } else {
            pause()
            return
        }
        load(track: queue[queuePosition], at: 0)
    }

    func previous() {
        guard !queue.isEmpty else { return }
        if position > 3 {
            seek(to: 0)
            return
        }
        guard let positionInOrder = order.firstIndex(of: queuePosition) else { return }
        queuePosition = positionInOrder > 0 ? order[positionInOrder - 1] : (order.last ?? 0)
        load(track: queue[queuePosition], at: 0)
    }

    // MARK: - Horloge et fondu

    private func tick() {
        guard playing, let startedAt else { return }
        clock.position = min(duration, max(0, Date().timeIntervalSince(startedAt)))
        clock.duration = duration

        if crossfade > 0, !fading, duration > 0, repeatMode != .one {
            // La durée est ARRONDIE À UNE MESURE de la piste sortante, comme sur le PC : le fondu
            // tombe sur un temps, pas au hasard.
            let planned = beatMatched ? AudioMath.quantizeFadeToBeats(crossfade, bpm: currentBPM) : crossfade
            if duration - position <= planned {
                fading = true
                Task { await crossfadeNext(plannedSeconds: planned) }
            }
        }

        if let remaining = sleepRemaining {
            sleepRemaining = remaining - 1
            if sleepRemaining ?? 0 <= 0 {
                sleepRemaining = nil
                pause()
            }
        }

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Fondu enchaîné : égalité de puissance, accord de tempo et égalisation de niveau.
    ///
    /// - durée : déjà quantifiée sur une mesure ;
    /// - tempo : l'entrante est accordée sur la sortante via `timePitch` (hauteur préservée) ;
    /// - niveau : l'entrante est corrigée pour ne pas éclipser la sortante, puis revient à son
    ///   niveau propre une fois le fondu passé.
    private func crossfadeNext(plannedSeconds: Double) async {
        guard let positionInOrder = order.firstIndex(of: queuePosition) else { return }
        let nextPosition = positionInOrder + 1
        guard nextPosition < order.count || repeatMode == .all else { return }
        let nextIndex = nextPosition < order.count ? order[nextPosition] : (order.first ?? 0)
        let outgoingTrack = queue[queuePosition]
        let incomingTrack = queue[nextIndex]
        guard let file = try? AVAudioFile(forReading: incomingTrack.fileURL) else { return }

        let outgoing = activeDeck
        let outgoingPitch: AVAudioUnitTimePitch = (outgoing === deckA) ? pitchA : pitchB
        let incoming: AVAudioPlayerNode = (outgoing === deckA) ? deckB : deckA
        let incomingPitch: AVAudioUnitTimePitch = (outgoing === deckA) ? pitchB : pitchA

        // --- Tempo et niveau, calculés avant de démarrer (les deux analyses sont mémorisées)
        let outgoingBPM = await analyzer.bpm(of: outgoingTrack)
        let incomingBPM = await analyzer.bpm(of: incomingTrack)
        let tempoRatio = beatMatched ? AudioMath.tempoMatchRatio(outgoing: outgoingBPM, incoming: incomingBPM) : 1
        let outgoingLevel = await analyzer.level(of: outgoingTrack)
        let incomingLevel = await analyzer.level(of: incomingTrack)
        let levelGain = AudioMath.loudnessGain(outgoing: outgoingLevel, incoming: incomingLevel)

        incoming.stop()
        incoming.volume = 0
        incomingPitch.rate = Float(tempoRatio)
        fileB = file
        schedule(on: incoming, file: file, from: 0)
        incoming.play()

        activeDeck = incoming
        activeFile = file
        current = incomingTrack
        queuePosition = nextIndex
        startedAt = Date()
        currentBPM = incomingBPM
        // La DURÉE doit suivre : sans ça la barre de progression gardait la longueur du morceau
        // précédent après un fondu, et le curseur se bloquait au mauvais endroit.
        syncClock(0)
        updateNowPlaying()

        // --- Rampes : cos sur la sortante, sin sur l'entrante (somme des carrés = 1)
        let steps = 30
        let interval = plannedSeconds / Double(steps)
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let fadeOut = Float(cos(t * .pi / 2))
            let fadeIn = Float(sin(t * .pi / 2))
            outgoing?.volume = fadeOut
            incoming.volume = fadeIn * Float(levelGain)
            try? await Task.sleep(nanoseconds: UInt64(max(0, interval) * 1_000_000_000))
        }

        outgoing?.stop()
        outgoing?.volume = 1
        outgoingPitch.rate = 1

        // Retour au niveau propre de l'entrante, en 2 s : sinon le morceau resterait atténué.
        let settleSteps = 10
        for step in 1...settleSteps {
            let t = Double(step) / Double(settleSteps)
            incoming.volume = Float(levelGain + (1 - levelGain) * t)
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        incoming.volume = 1
        incomingPitch.rate = 1
        fading = false
    }

    // MARK: - Minuteur et égaliseur

    func setSleepTimer(minutes: Int?) {
        sleepRemaining = (minutes ?? 0) > 0 ? (minutes! * 60) : nil
    }

    func applyPreset(_ name: String) {
        guard let preset = Self.presets[name] else { return }
        eqGains = preset
    }

    var duration: Double {
        guard let file = activeFile, file.processingFormat.sampleRate > 0 else { return current?.duration ?? 0 }
        return Double(file.length) / file.processingFormat.sampleRate
    }

    /// Met l'horloge à jour pour un nouveau morceau.
    private func syncClock(_ seconds: Double) {
        clock.position = seconds
        clock.duration = duration
    }

    var progress: Double { clock.progress }
}




