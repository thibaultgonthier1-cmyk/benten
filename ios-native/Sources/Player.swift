import AVFoundation
import Foundation
import MediaPlayer

/// Lecteur audio natif, sur `AVAudioEngine`.
///
/// POURQUOI CE MOTEUR ET PAS `AVAudioPlayer`
/// `AVAudioPlayer` ne permet pas d'insérer un traitement : impossible d'y brancher un égaliseur.
/// `AVAudioEngine` donne la chaîne complète — deux platines (pour le fondu), l'égaliseur 10 bandes,
/// puis la sortie — exactement comme le graphe du bureau :
///
///     platine A ─┐
///                ├─► EQ 10 bandes ─► mixeur ─► sortie
///     platine B ─┘
///
/// Deux platines servent au fondu enchaîné : la suivante démarre pendant que l'ancienne s'efface.
@MainActor
final class Player: NSObject, ObservableObject {
    // MARK: - État observé par l'interface

    @Published private(set) var current: Track?
    @Published private(set) var playing = false
    @Published private(set) var position: Double = 0
    @Published var showFullScreen = false
    @Published var repeatMode: RepeatMode = .all {
        didSet { rebuildOrder() }
    }
    @Published var shuffle = false {
        didSet { rebuildOrder() }
    }
    @Published var crossfade: Double = 0

    /// Gains de l'égaliseur, en dB, pour 31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz.
    @Published var eqGains: [Double] = Array(repeating: 0, count: Player.equalizerFrequencies.count) {
        didSet { applyEqualizer() }
    }
    @Published var eqEnabled = false {
        didSet { applyEqualizer() }
    }

    /// Minuteur de sommeil : minutes restantes, `nil` si désactivé.
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
    private let deckA = AVAudioPlayerNode()
    private let deckB = AVAudioPlayerNode()

    private var fileA: AVAudioFile?
    private var fileB: AVAudioFile?
    private var activeDeck: AVAudioPlayerNode?
    private var activeFile: AVAudioFile?
    private var startFrame: AVAudioFramePosition = 0
    private var startedAt: Date?
    private var timer: Timer?
    private var fading = false
    private var order: [Int] = []

    override init() {
        super.init()
        configureEngine()
        configureSession()
        configureRemoteCommands()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func configureEngine() {
        engine.attach(deckA)
        engine.attach(deckB)
        engine.attach(equalizer)

        for (index, frequency) in Self.equalizerFrequencies.enumerated() {
            let band = equalizer.bands[index]
            band.filterType = .parametric
            band.frequency = Float(frequency)
            band.bandwidth = 1.0
            band.gain = 0
            band.bypass = true
        }

        engine.connect(deckA, to: equalizer, format: nil)
        engine.connect(deckB, to: equalizer, format: nil)
        engine.connect(equalizer, to: engine.mainMixerNode, format: nil)
        engine.mainMixerNode.outputVolume = 1

        do {
            try engine.start()
        } catch {
            // Pas de moteur = pas de son : on garde l'app utilisable mais on le signale.
            print("[benten] moteur audio indisponible : \(error.localizedDescription)")
        }
    }

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetoothA2DP])
        try? session.setActive(true)
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

    private var queue: [Track] = []
    private var queuePosition = 0

    /// Reconstruit l'ordre de lecture (mélangé si demandé), en gardant le morceau courant en tête.
    private func rebuildOrder() {
        var indices = Array(queue.indices)
        if shuffle {
            indices.shuffle()
            if let at = indices.firstIndex(of: queuePosition), at != 0 {
                indices.swapAt(0, at)
            }
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
        deckA.volume = 1
        deckB.volume = 0
        activeDeck = deckA
        activeFile = file
        fileA = file
        current = track
        startFrame = AVAudioFramePosition(max(0, seconds) * file.processingFormat.sampleRate)
        startedAt = Date().addingTimeInterval(-seconds)
        schedule(on: deckA, file: file, from: startFrame)
        deckA.play()
        playing = true
        fading = false
        updateNowPlaying()
    }

    private func schedule(on deck: AVAudioPlayerNode, file: AVAudioFile, from frame: AVAudioFramePosition) {
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        guard remaining > 0 else { return }
        deck.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.activeDeck === deck else { return }
                self.handleFinished()
            }
        }
    }

    private func handleFinished() {
        if fading { return } // le fondu a déjà enchaîné
        next()
    }

    // MARK: - Transport

    func resume() {
        if !engine.isRunning { try? engine.start() }
        activeDeck?.play()
        if startedAt == nil { startedAt = Date() }
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
        startFrame = AVAudioFramePosition(max(0, min(seconds, duration)) * file.processingFormat.sampleRate)
        startedAt = Date().addingTimeInterval(-seconds)
        position = seconds
        if let deck = activeDeck {
            schedule(on: deck, file: file, from: startFrame)
            if wasPlaying { deck.play() }
        }
        updateNowPlaying()
    }

    func next() {
        guard !queue.isEmpty else { return }
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

    // MARK: - Horloge

    private func tick() {
        guard playing, let startedAt else { return }
        position = min(duration, max(0, Date().timeIntervalSince(startedAt)))

        // Fondu : on démarre la suivante avant la fin, en égalité de puissance.
        if crossfade > 0, !fading, duration - position <= crossfade, duration > 0, repeatMode != .one {
            fading = true
            Task { await crossfadeNext(duration: crossfade) }
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

    /// Fondu en égalité de puissance : `cos` sur la sortante, `sin` sur l'entrante.
    private func crossfadeNext(duration fade: Double) async {
        guard let positionInOrder = order.firstIndex(of: queuePosition) else { return }
        let nextPosition = positionInOrder + 1
        guard nextPosition < order.count || repeatMode == .all else { return }
        let nextIndex = nextPosition < order.count ? order[nextPosition] : (order.first ?? 0)
        let track = queue[nextIndex]
        guard let file = try? AVAudioFile(forReading: track.fileURL) else { return }

        let outgoing = activeDeck
        let incoming: AVAudioPlayerNode = (outgoing === deckA) ? deckB : deckA
        incoming.stop()
        incoming.volume = 0
        fileB = file
        schedule(on: incoming, file: file, from: 0)
        incoming.play()

        activeDeck = incoming
        activeFile = file
        current = track
        queuePosition = nextIndex
        startFrame = 0
        startedAt = Date()
        updateNowPlaying()

        let steps = 24
        let interval = fade / Double(steps)
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            outgoing?.volume = Float(cos(t * .pi / 2))
            incoming.volume = Float(sin(t * .pi / 2))
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
        outgoing?.stop()
        outgoing?.volume = 1
        incoming.volume = 1
        fading = false
    }

    // MARK: - Minuteur de sommeil

    func setSleepTimer(minutes: Int?) {
        sleepRemaining = (minutes ?? 0) > 0 ? (minutes! * 60) : nil
    }

    // MARK: - Égaliseur

    func applyPreset(_ name: String) {
        guard let preset = Self.presets[name] else { return }
        eqGains = preset
    }

    var duration: Double {
        guard let file = activeFile, file.processingFormat.sampleRate > 0 else { return current?.duration ?? 0 }
        return Double(file.length) / file.processingFormat.sampleRate
    }

    var progress: Double {
        guard duration > 0 else { return 0 }
        return min(1, max(0, position / duration))
    }
}
