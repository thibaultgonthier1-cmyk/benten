import SwiftUI

/// Point d'entrée de Benten pour iPhone.
///
/// L'app est NATIVE (SwiftUI + AVFoundation), pas une page web emballée : c'est ce qui donne
/// l'écran verrouillé, les commandes du casque, la vraie pochette extraite des fichiers, et le
/// rendu iOS authentique.
@main
struct BentenApp: App {
    @StateObject private var library = Library()
    @StateObject private var player = Player()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(library)
                .environmentObject(player)
                .environmentObject(player.clock)
                .preferredColorScheme(.dark)
                .tint(Theme.gold)
        }
    }
}



/// Trois onglets, comme une app de musique : bibliothèque, recherche, réglages.
struct RootView: View {
    @EnvironmentObject private var player: Player
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            LibraryView()
                .tabItem { Label("Bibliothèque", systemImage: "music.note.list") }
                .tag(0)

            SearchView()
                .tabItem { Label("Recherche", systemImage: "magnifyingglass") }
                .tag(1)

            SettingsView()
                .tabItem { Label("Réglages", systemImage: "gearshape") }
                .tag(2)
        }
        .safeAreaInset(edge: .bottom) {
            if player.current != nil {
                MiniPlayer()
            }
        }
        .sheet(isPresented: Binding(
            get: { player.current != nil && player.showFullScreen },
            set: { player.showFullScreen = $0 }
        )) {
            NowPlayingView()
        }
    }
}


