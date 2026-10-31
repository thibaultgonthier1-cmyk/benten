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
            List {
                ForEach(Array(results.enumerated()), id: \.element.id) { offset, track in
                    Button {
                        player.play(results, startingAt: offset)
                    } label: {
                        HStack(spacing: 12) {
                            ArtworkView(track: track)
                                .frame(width: 44, height: 44)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(track.title).lineLimit(1)
                                Text(track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Titre, artiste, album")
            .navigationTitle("Recherche")
        }
    }
}

/// Réglages : fondu, répétition, aléatoire, gestion de la bibliothèque.
struct SettingsView: View {
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var player: Player
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Lecture") {
                    Picker("Répéter", selection: $player.repeatMode) {
                        Text("Non").tag(Player.RepeatMode.off)
                        Text("Toute la liste").tag(Player.RepeatMode.all)
                        Text("Ce titre").tag(Player.RepeatMode.one)
                    }
                    Toggle("Aléatoire", isOn: $player.shuffle)

                    VStack(alignment: .leading) {
                        // Le fondu va de 0 à 12 s, comme Apple Music ; 0 = enchaînement sec.
                        Text("Fondu enchaîné : \(player.crossfade == 0 ? "désactivé" : "\(Int(player.crossfade)) s")")
                            .font(.subheadline)
                        Slider(value: $player.crossfade, in: 0...12, step: 1)
                            .tint(Palette.gold)
                    }
                }

                Section("Bibliothèque") {
                    LabeledContent("Morceaux", value: "\(library.tracks.count)")
                    LabeledContent(
                        "Espace utilisé",
                        value: ByteCountFormatter.string(
                            fromByteCount: Int64(library.tracks.reduce(0) { $0 + fileSize($1) }),
                            countStyle: .file
                        )
                    )
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Text("Vider la bibliothèque")
                    }
                }

                Section("À propos") {
                    LabeledContent("Version", value: Bundle.main.appVersion)
                    Text("Benten lit les fichiers de l'appareil, hors-ligne. iOS interdit à une app de parcourir un dossier : les morceaux s'importent depuis Fichiers ou iCloud.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Réglages")
            .confirmationDialog("Supprimer tous les morceaux ?", isPresented: $confirmDelete) {
                Button("Tout supprimer", role: .destructive) { library.deleteAll() }
                Button("Annuler", role: .cancel) {}
            }
        }
    }

    private func fileSize(_ track: Track) -> Int {
        (try? FileManager.default.attributesOfItem(atPath: track.fileURL.path)[.size] as? Int) ?? 0
    }
}

private extension Bundle {
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
