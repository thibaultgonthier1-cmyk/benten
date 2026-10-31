import AVFoundation
import Foundation
import MediaPlayer

/// Lecteur audio natif.
///
/// Utilise `AVAudioPlayer` (fichiers locaux) avec :
/// - session audio `playback` : la musique continue écran verrouillé et en arrière-plan ;
/// - `MPNowPlayingInfoCenter` : pochette, titre, artiste sur l'écran verrouillé et dans la voiture ;
/// - commandes distantes : boutons du casque, écran verrouillé, CarPlay.
///
/// Le fondu entre morceaux (durée réglable) est appliqué ici : on baisse l'ancien et on monte le
/// nouveau en parallèle, en égalité de puissance — la même math que la version PC.
@MainActor
final class Player: NSObject, ObservableObject {
    @Published private(set) var current: Track?
    @Published private(set) var playing = false
    @Published private(set) var position: Double = 0
    @Published var showFullScreen = false
    @Published var repeatMode: RepeatMode = .all
    @Published var shuffle = false
    @Published var crossfade: Double = 0 // secondes ; 0 = enchaînement sec

    enum RepeatMode: String, Codable { case off, all, one }

    private var audio: AVAudioPlayer?
    private var timer: Timer?
    private var queue: [Track] = []
    private var index = 0
    private var fading = false

    override init() {
        super.init()
        configureSession()
        configureRemoteCommands()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    // MARK: - Session audio

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        // `.playback` : l'app continue de jouer quand l'écran se verrouille ou qu'une autre app passe
        // au premier plan — c'est ce que fait Apple Music.
        try? session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetoothA2DP])
        try? session.setActive(true)
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

    private func updateNowPlaying(_ track: Track?) {
        var info: [String: Any] = [:]
        if let track {
            info[MPMediaItemPropertyTitle] = track.title
            info[MPMediaItemPropertyArtist] = track.artist
            info[MPMediaItemPropertyAlbumTitle] = track.album
            info[MPMediaItemPropertyPlaybackDuration] = track.duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
            if let url = track.artworkURL, let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            }
        }
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1 : 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // MARK: - Lecture

    func play(_ tracks: [Track], startingAt startIndex: Int) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        index = min(max(0, startIndex), tracks.count - 1)
        start(track: queue[index])
    }

    private func start(track: Track, at time: Double = 0) {
        audio?.stop()
        guard let player = try? AVAudioPlayer(contentsOf: track.fileURL) else {
            // Fichier illisible : on passe au suivant plutôt que de bloquer la file.
            next()
            return
        }
        player.delegate = self
        player.prepareToPlay()
        player.currentTime = time
        player.volume = 1
        player.play()
        audio = player
        current = track
        position = time
        playing = true
        updateNowPlaying(track)
    }

    func resume() {
        audio?.play()
        playing = true
        updateNowPlaying(current)
    }

    func pause() {
        audio?.pause()
        playing = false
        updateNowPlaying(current)
    }

    func toggle() {
        playing ? pause() : resume()
    }

    func seek(to seconds: Double) {
        guard let audio else { return }
        audio.currentTime = min(max(0, seconds), audio.duration)
        position = audio.currentTime
        updateNowPlaying(current)
    }

    func next() {
        guard !queue.isEmpty else { return }
        if repeatMode == .one {
            start(track: queue[index])
            return
        }
        let nextIndex = index + 1
        if nextIndex < queue.count {
            index = nextIndex
        } else if repeatMode == .all {
            index = 0
        } else {
            pause()
            return
        }
        start(track: queue[index])
    }

    func previous() {
        guard !queue.isEmpty else { return }
        // Comportement iOS : un appui ramène au début si on est déjà loin dans le morceau.
        if position > 3 {
            seek(to: 0)
            return
        }
        index = index > 0 ? index - 1 : (repeatMode == .all ? queue.count - 1 : 0)
        start(track: queue[index])
    }

    private func tick() {
        guard let audio, playing else { return }
        position = audio.currentTime

        // Fondu enchaîné : on déclenche le morceau suivant `crossfade` secondes avant la fin.
        if crossfade > 0, !fading, audio.duration - audio.currentTime <= crossfade, repeatMode != .one {
            fading = true
            Task { await crossfadeToNext(duration: crossfade) }
        }

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = 1
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Fondu en égalité de puissance : `cos/sin` pour que la somme des carrés reste constante.
    private func crossfadeToNext(duration: Double) async {
        guard index + 1 < queue.count || repeatMode == .all else { return }
        let nextTrack = queue[index + 1 < queue.count ? index + 1 : 0]
        guard let incoming = try? AVAudioPlayer(contentsOf: nextTrack.fileURL) else { return }
        incoming.delegate = self
        incoming.prepareToPlay()
        incoming.volume = 0
        incoming.play()

        let steps = 24
        let interval = duration / Double(steps)
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let outgoingGain = Float(cos(t * .pi / 2))
            let incomingGain = Float(sin(t * .pi / 2))
            audio?.volume = outgoingGain
            incoming.volume = incomingGain
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }

        audio?.stop()
        audio = incoming
        index = index + 1 < queue.count ? index + 1 : 0
        current = nextTrack
        position = 0
        playing = true
        fading = false
        updateNowPlaying(nextTrack)
    }

    var progress: Double {
        guard let audio, audio.duration > 0 else { return 0 }
        return min(1, max(0, position / audio.duration))
    }

    var duration: Double { audio?.duration ?? current?.duration ?? 0 }
}

extension Player: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            if self.crossfade > 0 { self.fading = false; return } // déjà enchaîné par le fondu
            self.next()
        }
    }
}
