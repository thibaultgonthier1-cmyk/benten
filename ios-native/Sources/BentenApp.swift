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
    @StateObject private var router = AppRouter()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(library)
                .environmentObject(player)
                .environmentObject(router)
                .environmentObject(player.clock)
                .preferredColorScheme(.dark)
                .tint(Theme.gold)
        }
    }
}

/// Coquille : onglets + lecteur.
///
/// La vue Lecture n'est PAS un `sheet` : c'est un panneau posé par-dessus la coquille, refermable
/// au chevron ou en le faisant glisser vers le bas. Un `sheet` capturait toute l'interaction et
/// empêchait d'atteindre les onglets tant qu'il était ouvert — d'où l'impression que l'app restait
/// bloquée sur le morceau en cours, sans accès aux réglages ni à la recherche.
struct RootView: View {
    @EnvironmentObject private var player: Player
    @EnvironmentObject private var router: AppRouter

    var body: some View {
        ZStack {
            TabView(selection: $router.tab) {
                LibraryView()
                    .tabItem { Label("Bibliothèque", systemImage: "music.note.list") }
                    .tag(AppRouter.Tab.library)

                SearchView()
                    .tabItem { Label("Recherche", systemImage: "magnifyingglass") }
                    .tag(AppRouter.Tab.search)

                SettingsView()
                    .tabItem { Label("Réglages", systemImage: "gearshape") }
                    .tag(AppRouter.Tab.settings)
            }
            .tint(Theme.gold)

            if player.current != nil && player.showFullScreen {
                NowPlayingView()
                    .transition(.move(edge: .bottom))
                    .zIndex(10)
            }
        }
        .animation(Motion.spring, value: player.showFullScreen)
        .safeAreaInset(edge: .bottom) {
            // Le mini-lecteur n'apparaît que la vue Lecture fermée : sinon il ferait doublon.
            if player.current != nil && !player.showFullScreen {
                MiniPlayer()
            }
        }
    }
}
