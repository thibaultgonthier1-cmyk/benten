import SwiftUI
import UIKit

/// Journal de bord du lecteur : chaque événement audio important (chargement, mix, coupure du
/// moteur, changement de sortie, relance…) avec l'heure exacte. Gardé en mémoire (300 lignes).
///
/// Sert à diagnostiquer un problème qu'on ne peut pas reproduire à distance : on le copie depuis
/// les Réglages et on le colle — on voit exactement ce qui s'est passé, dans l'ordre.
@MainActor
final class DiagnosticsLog: ObservableObject {
    static let shared = DiagnosticsLog()

    struct Entry: Identifiable {
        let id = UUID()
        let date: Date
        let text: String
    }

    @Published private(set) var entries: [Entry] = []
    private let limit = 300

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()

    func add(_ text: String) {
        entries.append(Entry(date: Date(), text: text))
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
    }

    func clear() { entries.removeAll() }

    func line(_ entry: Entry) -> String {
        "\(Self.formatter.string(from: entry.date))  \(entry.text)"
    }

    var exportText: String {
        let version = Bundle.main.appVersion
        let device = DeviceLayout.current.deviceName
        let header = "Benten \(version) · \(device) · iOS \(UIDevice.current.systemVersion)"
        return ([header] + entries.map(line)).joined(separator: "\n")
    }
}

/// Raccourci pour écrire dans le journal depuis n'importe où sur le fil principal.
@MainActor
func diag(_ text: String) {
    DiagnosticsLog.shared.add(text)
}

/// Écran « Diagnostic » : le journal, et un bouton pour le copier.
struct DiagnosticsView: View {
    @ObservedObject private var log = DiagnosticsLog.shared
    @State private var copied = false

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = log.exportText
                        Haptics.press()
                        withAnimation(Motion.quick) { copied = true }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                            withAnimation(Motion.quick) { copied = false }
                        }
                    } label: {
                        Label(copied ? "Copié" : "Copier le journal", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Capsule().fill(Theme.accentGradient))
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .buttonStyle(PressableStyle())

                    Button {
                        Haptics.tap()
                        log.clear()
                    } label: {
                        Label("Vider", systemImage: "trash")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.ivory)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 11)
                            .background(Capsule().fill(Color.white.opacity(0.08)))
                    }
                    .buttonStyle(PressableStyle())
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

                if log.entries.isEmpty {
                    Spacer()
                    Text("Aucun événement pour l'instant.\nÉcoute de la musique, puis reviens ici.")
                        .font(.footnote)
                        .foregroundStyle(Theme.dim)
                        .multilineTextAlignment(.center)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(log.entries.reversed()) { entry in
                                Text(log.line(entry))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(Theme.ivory.opacity(0.85))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 20)
                    }
                }
            }
        }
        .navigationTitle("Diagnostic")
        .navigationBarTitleDisplayMode(.inline)
    }
}
