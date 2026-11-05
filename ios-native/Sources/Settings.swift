import SwiftUI

/// Recherche dans la bibliothèque locale (titre, artiste, album).
struct SearchView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @State private var query = ""
    @State private var deletion: DeletionRequest?

    private var results: [Track] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return library.tracksByTitle }
        return library.tracksByTitle.filter {
            $0.title.localizedCaseInsensitiveContains(trimmed)
                || $0.artist.localizedCaseInsensitiveContains(trimmed)
                || $0.album.localizedCaseInsensitiveContains(trimmed)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                let list = results
                if list.isEmpty && !query.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 36, weight: .light))
                            .foregroundStyle(Theme.dim)
                            .symbolEffect(.pulse)
                        Text("Aucun résultat pour « \(query) »")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.ivory)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(Array(list.enumerated()), id: \.element.id) { offset, track in
                                TrackRow(
                                    track: track,
                                    isCurrent: player.current?.id == track.id,
                                    isPlaying: player.playing,
                                    onPlay: { player.play(list, startingAt: offset) }
                                )
                                .contextMenu {
                                    DeleteFromDeviceButton { deletion = DeletionRequest(track: track) }
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 20)
                    }
                    .scrollDismissesKeyboard(.immediately)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Titres, artistes, albums")
            .swipeBackEverywhere()
            .navigationTitle("Recherche")
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .deletionConfirmation($deletion)
        }
    }
}

/// Réglages.
struct SettingsView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var clock: PlaybackClock
    @EnvironmentObject private var playlists: PlaylistStore
    @State private var confirmDelete = false
    @StateObject private var sync = SyncService()
    @AppStorage("sync.base") private var syncBase = ""
    @AppStorage("sync.token") private var syncToken = ""
    @AppStorage("sync.limit") private var syncLimit = 100
    @State private var sleepMinutes = 0
    @State private var usedBytes: Int64 = 0
    @State private var genreMessage: String?
    @AppStorage("palette") private var paletteRaw = Palette.or.rawValue
    @AppStorage("design") private var designRaw = "apple"
    @AppStorage("visualizer") private var visualizerOn = true
    @AppStorage("livingArtwork") private var livingArtwork = true

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                Form {
                    automixSection
                    soundSection
                    playbackSection
                    designSection
                    paletteSection
                    syncSection
                    librarySection
                    aboutSection
                }
                .scrollContentBackground(.hidden)
            }
            .swipeBackEverywhere()
            .navigationTitle("Réglages")
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .confirmationDialog("Supprimer tous les morceaux ?", isPresented: $confirmDelete) {
                Button("Tout supprimer", role: .destructive) {
                    player.stopAndClear()
                    library.deleteAll()
                }
                Button("Annuler", role: .cancel) {}
            }
            .alert("Playlist Phonk / Funk", isPresented: Binding(get: { genreMessage != nil }, set: { if !$0 { genreMessage = nil } })) {
                Button("OK", role: .cancel) { genreMessage = nil }
            } message: {
                Text(genreMessage ?? "")
            }
            // Espace disque : calculé UNE fois en arrière-plan, et seulement quand le nombre de
            // morceaux change (avant : 1019 lectures de fichier à chaque play / pause).
            .task(id: library.tracks.count) {
                let urls = library.tracks.map(\.fileURL)
                usedBytes = await Task.detached(priority: .utility) {
                    urls.reduce(Int64(0)) { sum, url in
                        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
                        return sum + size
                    }
                }.value
            }
        }
    }

    // MARK: AutoMix

    private var automixSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { player.automixEnabled },
                set: { on in
                    Haptics.choose()
                    withAnimation(Motion.quick) { player.setAutomix(on) }
                }
            )) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("AutoMix")
                            .font(.system(size: 16, weight: .semibold))
                        Text("Enchaîne les morceaux comme un DJ")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.dim)
                    }
                } icon: {
                    Image(systemName: "dial.high.fill")
                        .foregroundStyle(Theme.accent)
                        .symbolEffect(.bounce, value: player.automixEnabled)
                }
            }
            .tint(Theme.accent)

            if player.automixEnabled {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Longueur des transitions")
                    Picker("Longueur", selection: $player.mixLength) {
                        ForEach(Player.MixLength.allCases) { length in
                            Text(length.label).tag(length)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text("\(player.mixLength.beats / 4) mesures (jusqu'au double si l'outro et l'intro sont longues), \(Int(player.mixLength.seconds)) s si le rythme n'est pas détecté.")
                        .font(.caption2)
                        .foregroundStyle(Theme.dim)
                }
                Toggle("Mix calé (beatmatch + bass swap)", isOn: $player.beatMatched)
                    .tint(Theme.accent)
                if let bpm = player.currentBPM {
                    HStack(spacing: 8) {
                        Label("\(Int(bpm.rounded())) BPM", systemImage: "metronome.fill")
                        if let key = AudioMath.camelotLabel(player.currentKey) {
                            Label(key, systemImage: "tuningfork")
                        }
                    }
                    .font(.system(size: 13, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Theme.accent)
                }
                Text(player.beatMatched
                     ? "Comme un DJ : les deux morceaux jouent ensemble, l'un monte pendant que l'autre descend, et leurs tempos glissent ensemble de l'un vers l'autre en restant sur les mêmes temps. Le suivant démarre sur un temps fort, calé sur la fin de son intro ; le mix se fait sur la fin musicale (outro), les basses sont échangées sur la mesure du milieu, tous les morceaux sont au même volume. Le calage est mesuré et corrigé en direct pendant chaque mix. Tonalités qui jurent → transition plus courte ; tempos trop éloignés → fondu filtré ; même album → enchaînement sans blanc."
                     : "Fondu simple à puissance constante, sans calage rythmique.")
                    .font(.caption2)
                    .foregroundStyle(Theme.dim)
            }
        } header: {
            Text("Enchaînement").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    // MARK: Son

    private var soundSection: some View {
        Section {
            NavigationLink {
                EqualizerView()
            } label: {
                HStack {
                    Label("Égaliseur", systemImage: "slider.vertical.3")
                    Spacer()
                    Text(player.eqEnabled ? player.eqPresetName : "Désactivé")
                        .foregroundStyle(Theme.dim)
                }
            }
        } header: {
            Text("Son").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    // MARK: Lecture

    private var playbackSection: some View {
        Section {
            Toggle(isOn: $player.shuffle) {
                Label("Lecture aléatoire", systemImage: "shuffle")
            }
            .tint(Theme.accent)

            Toggle(isOn: $player.autoplay) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Lecture continue")
                        Text("À la fin de la file : même genre, tempo proche")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.dim)
                    }
                } icon: {
                    Image(systemName: "infinity")
                }
            }
            .tint(Theme.accent)

            Toggle(isOn: $visualizerOn) {
                Label("Visualiseur audio", systemImage: "waveform")
            }
            .tint(Theme.accent)

            VStack(alignment: .leading, spacing: 4) {
                Stepper(value: $sleepMinutes, in: 0...180, step: 15) {
                    Label(sleepMinutes == 0 ? "Minuteur : désactivé" : "Minuteur : \(sleepMinutes) min", systemImage: "moon.zzz")
                }
                .onChange(of: sleepMinutes) { _, minutes in
                    player.setSleepTimer(minutes: minutes == 0 ? nil : minutes)
                }
                if let remaining = clock.sleepRemaining {
                    Text("Arrêt dans \(remaining / 60) min \(String(format: "%02d", remaining % 60)) s")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Theme.accent)
                }
            }
        } header: {
            Text("Lecture").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    // MARK: Interface

    private var designSection: some View {
        Section {
            Picker("Style", selection: $designRaw) {
                Text("Apple Music").tag("apple")
                Text("Benten").tag("benten")
            }
            .pickerStyle(.segmented)
            .onChange(of: designRaw) { _, value in
                Haptics.choose()
                Theme.appleStyle = value == "apple"
            }
            Toggle(isOn: $livingArtwork) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pochette animée")
                        Text("Plein écran, holographique, suit l'inclinaison du téléphone")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.dim)
                    }
                } icon: {
                    Image(systemName: "sparkles.rectangle.stack")
                }
            }
            .tint(Theme.accent)
            Text(designRaw == "apple"
                 ? "Grandes pochettes, fond animé tiré de la pochette, comme Apple Music."
                 : "Titres en sérif, halos colorés, disque laqué en lecture.")
                .font(.caption2)
                .foregroundStyle(Theme.dim)
        } header: {
            Text("Interface").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    private var paletteSection: some View {
        Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 10)], spacing: 10) {
                ForEach(Palette.allCases) { palette in
                    Button {
                        guard palette.rawValue != paletteRaw else { return }
                        let previous = Palette(rawValue: paletteRaw) ?? .or
                        // Un courant de couleur traverse l'écran de gauche à droite et révèle
                        // l'interface aux nouvelles couleurs.
                        ThemeSweep.run(from: previous, to: palette) {
                            paletteRaw = palette.rawValue
                            Theme.apply(palette)
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Circle().fill(palette.swatch).frame(width: 14, height: 14)
                            Text(palette.label)
                                .font(.system(size: 12.5))
                                .foregroundStyle(paletteRaw == palette.rawValue ? Theme.ivory : Theme.dim)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(paletteRaw == palette.rawValue ? palette.accent.opacity(0.16) : Color.clear)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .strokeBorder(paletteRaw == palette.rawValue ? palette.accent : Theme.hairline)
                                )
                        )
                    }
                    .buttonStyle(PressableStyle())
                }
            }
            .padding(.vertical, 4)
        } header: {
            Text("Couleur d'accent").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    // MARK: Synchronisation

    private var syncSection: some View {
        Section {
            TextField("http://192.168.1.10:4321", text: $syncBase)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            SecureField("jeton du PC", text: $syncToken)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Stepper("Morceaux à récupérer : \(syncLimit)", value: $syncLimit, in: 1...5000, step: 50)

            Button {
                Haptics.press()
                Task { await sync.run(base: syncBase, token: syncToken, limit: syncLimit, library: library) }
            } label: {
                Label(sync.running ? "Récupération…" : "Récupérer depuis le PC", systemImage: "arrow.down.circle")
                    .foregroundStyle(Theme.accent)
            }
            .disabled(sync.running)

            if sync.running {
                ProgressView(value: sync.progress).tint(Theme.accent)
            }
            if !sync.status.isEmpty {
                Text(sync.status)
                    .font(.footnote)
                    .foregroundStyle(sync.status.localizedCaseInsensitiveContains("récupéré") ? .green : Theme.dim)
            }
        } header: {
            Text("Synchroniser avec le PC").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    // MARK: Bibliothèque

    private var librarySection: some View {
        Section {
            LabeledContent("Morceaux", value: "\(library.tracks.count)")
            LabeledContent("Espace utilisé", value: ByteCountFormatter.string(fromByteCount: usedBytes, countStyle: .file))
            Button {
                Haptics.press()
                let added = playlists.buildGenrePlaylists(library: library)
                genreMessage = added > 0
                    ? "\(added) morceau\(added > 1 ? "x" : "") ajouté\(added > 1 ? "s" : "")."
                    : "La playlist est déjà à jour (elle se met à jour toute seule)."
            } label: {
                Label("Mettre à jour Phonk / Funk", systemImage: "wand.and.stars")
                    .foregroundStyle(Theme.accent)
            }
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Text("Vider la bibliothèque")
            }
        } header: {
            Text("Bibliothèque").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("Version", value: Bundle.main.appVersion)
            NavigationLink {
                DiagnosticsView()
            } label: {
                Label("Diagnostic (journal du lecteur)", systemImage: "stethoscope")
            }
            LabeledContent("Appareil", value: DeviceLayout.current.deviceName)
            Text("Benten lit tes morceaux hors-ligne, écran verrouillé compris. Les morceaux viennent de Fichiers, d'iCloud, ou du PC par synchronisation.")
                .font(.caption2)
                .foregroundStyle(Theme.dim)
        } header: {
            Text("À propos").foregroundStyle(Theme.accent.opacity(0.8))
        }
    }
}

extension Bundle {
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
