import SwiftUI

/// Recherche dans la bibliothèque locale (titre, artiste, album).
struct SearchView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @State private var query = ""

    private var results: [Track] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return library.tracks }
        return library.tracks.filter {
            $0.title.localizedCaseInsensitiveContains(trimmed)
                || $0.artist.localizedCaseInsensitiveContains(trimmed)
                || $0.album.localizedCaseInsensitiveContains(trimmed)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                List {
                    ForEach(Array(results.enumerated()), id: \.element.id) { offset, track in
                        Button {
                            player.play(results, startingAt: offset)
                        } label: {
                            HStack(spacing: 12) {
                                ArtworkView(track: track)
                                    .frame(width: 46, height: 46)
                                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(track.title)
                                        .font(.system(size: 14, weight: .medium))
                                        .foregroundStyle(Theme.ivory)
                                        .lineLimit(1)
                                    Text(track.artist)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(Theme.dim)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .listRowBackground(Theme.ink2)
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.plain)
            }
            .searchable(text: $query, prompt: "Titre, artiste, album")
            .navigationTitle("Recherche")
            .toolbarBackground(Theme.ink, for: .navigationBar)
        }
    }
}

/// Réglages : tout ce qui existe sur le bureau, au format téléphone.
///
/// Sections : synchronisation PC, lecture (aléatoire, répétition, fondu, minuteur), égaliseur
/// 10 bandes avec presets, bibliothèque, à propos.
struct SettingsView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @State private var confirmDelete = false
    @StateObject private var sync = SyncService()
    @AppStorage("sync.base") private var syncBase = ""
    @AppStorage("sync.token") private var syncToken = ""
    @AppStorage("sync.limit") private var syncLimit = 100
    @State private var sleepMinutes = 0

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()
                Form {
                    syncSection
                    playbackSection
                    equalizerSection
                    librarySection
                    aboutSection
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Réglages")
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .confirmationDialog("Supprimer tous les morceaux ?", isPresented: $confirmDelete) {
                Button("Tout supprimer", role: .destructive) { library.deleteAll() }
                Button("Annuler", role: .cancel) {}
            }
        }
    }

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
                Task { await sync.run(base: syncBase, token: syncToken, limit: syncLimit, library: library) }
            } label: {
                Label(sync.running ? "Récupération…" : "Récupérer depuis le PC", systemImage: "arrow.down.circle")
                    .foregroundStyle(Theme.gold)
            }
            .disabled(sync.running)

            if sync.running {
                ProgressView(value: sync.progress).tint(Theme.gold)
            }
            if !sync.status.isEmpty {
                Text(sync.status)
                    .font(.footnote)
                    .foregroundStyle(sync.status.localizedCaseInsensitiveContains("récupéré") ? .green : Theme.dim)
            }
        } header: {
            Text("Synchroniser avec le PC").foregroundStyle(Theme.gold.opacity(0.8))
        }
    }

    private var playbackSection: some View {
        Section {
            Toggle("Lecture aléatoire", isOn: $player.shuffle)
                .tint(Theme.gold)

            Picker("Répéter", selection: $player.repeatMode) {
                Text("Non").tag(Player.RepeatMode.off)
                Text("Toute la liste").tag(Player.RepeatMode.all)
                Text("Ce titre").tag(Player.RepeatMode.one)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Fondu enchaîné : \(player.crossfade == 0 ? "désactivé" : "\(Int(player.crossfade)) s")")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.ivory)
                Slider(value: $player.crossfade, in: 0...12, step: 1).tint(Theme.gold)
                Text("Les morceaux se chevauchent en égalité de puissance, sans variation de volume perçue.")
                    .font(.caption2)
                    .foregroundStyle(Theme.dim)
            }

            VStack(alignment: .leading, spacing: 4) {
                Stepper(
                    "Minuteur de sommeil : \(sleepMinutes == 0 ? "désactivé" : "\(sleepMinutes) min")",
                    value: $sleepMinutes,
                    in: 0...180,
                    step: 15
                )
                .onChange(of: sleepMinutes) { minutes in
                    player.setSleepTimer(minutes: minutes == 0 ? nil : minutes)
                }
                if let remaining = player.sleepRemaining {
                    Text("Arrêt dans \(remaining / 60) min \(remaining % 60) s")
                        .font(.caption2)
                        .foregroundStyle(Theme.gold)
                }
            }
        } header: {
            Text("Lecture").foregroundStyle(Theme.gold.opacity(0.8))
        }
    }

    private var equalizerSection: some View {
        Section {
            Toggle("Égaliseur", isOn: $player.eqEnabled).tint(Theme.gold)

            if player.eqEnabled {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(Player.presets.keys).sorted(), id: \.self) { name in
                            Button(name) { player.applyPreset(name) }
                                .font(.system(size: 12))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(Capsule().strokeBorder(Theme.gold.opacity(0.6), lineWidth: 1))
                                .foregroundStyle(Theme.gold)
                        }
                    }
                    .padding(.vertical, 4)
                }

                ForEach(Array(Player.equalizerFrequencies.enumerated()), id: \.offset) { index, frequency in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(frequency >= 1000 ? "\(Int(frequency / 1000)) kHz" : "\(Int(frequency)) Hz")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.dim)
                            Spacer()
                            Text(String(format: "%+.0f dB", player.eqGains[index]))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.ivory)
                        }
                        Slider(
                            value: Binding(
                                get: { player.eqGains[index] },
                                set: { value in
                                    var gains = player.eqGains
                                    gains[index] = value
                                    player.eqGains = gains
                                }
                            ),
                            in: -12...12,
                            step: 0.5
                        )
                        .tint(Theme.gold)
                    }
                }
            }
        } header: {
            Text("Égaliseur").foregroundStyle(Theme.gold.opacity(0.8))
        }
    }

    private var librarySection: some View {
        Section {
            LabeledContent("Morceaux", value: "\(library.tracks.count)")
            LabeledContent(
                "Espace utilisé",
                value: ByteCountFormatter.string(fromByteCount: Int64(totalBytes), countStyle: .file)
            )
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Text("Vider la bibliothèque")
            }
        } header: {
            Text("Bibliothèque").foregroundStyle(Theme.gold.opacity(0.8))
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("Version", value: Bundle.main.appVersion)
            Text("Benten lit les fichiers de l'appareil, hors-ligne. iOS interdit à une app de parcourir un dossier : les morceaux viennent de Fichiers, d'iCloud, ou du PC par synchronisation.")
                .font(.caption2)
                .foregroundStyle(Theme.dim)
        } header: {
            Text("À propos").foregroundStyle(Theme.gold.opacity(0.8))
        }
    }

    private var totalBytes: Int {
        library.tracks.reduce(0) { sum, track in
            let size = (try? FileManager.default.attributesOfItem(atPath: track.fileURL.path)[.size] as? Int) ?? 0
            return sum + size
        }
    }
}

private extension Bundle {
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
