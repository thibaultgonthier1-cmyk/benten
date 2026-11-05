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
    @StateObject private var favorites = FavoritesStore()
    @StateObject private var playlists = PlaylistStore()
    // La palette est persistée ; changer sa valeur force la reconstruction de la coquille
    // (Theme utilise une variable statique, sans objet observable).
    @AppStorage("palette") private var paletteRaw = Palette.or.rawValue
    @AppStorage("design") private var designRaw = "apple"

    var body: some Scene {
        WindowGroup {
            RootView()
                // Plus de reconstruction à chaque changement de couleur : le thème est observé,
                // l'interface se recolore sur place (on reste où on était).
                .onAppear {
                  Theme.apply(Palette(rawValue: paletteRaw) ?? .or)
                  Theme.appleStyle = designRaw == "apple"
                  // Lecture continue : le lecteur pioche dans toute la bibliothèque.
                  let library = library
                  player.libraryProvider = { library.tracks }
                  // Listes et onglets suivent le lecteur via cet état fin (pas via `Player`
                  // entier) : un play/pause ne redessine plus que les lignes concernées.
                  NowPlayingState.shared.bind(to: player)
                  // Moteur haptique prêt dès le lancement : le premier toucher vibre sans retard.
                  Haptics.warmUp()
                }
                .onChange(of: paletteRaw) { value in Theme.apply(Palette(rawValue: value) ?? .or) }
                .environmentObject(library)
                .environmentObject(player)
                .environmentObject(router)
                .environmentObject(favorites)
                .environmentObject(playlists)
                .environmentObject(player.clock)
                .environmentObject(player.spectrum)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
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
    @EnvironmentObject private var library: Library
    @EnvironmentObject private var playlists: PlaylistStore
    @EnvironmentObject private var favorites: FavoritesStore
    @State private var tabBarHeight: CGFloat = 49
    @State private var keyboardVisible = false

    var body: some View {
        ZStack(alignment: .bottom) {
            shell

            if player.current != nil && player.showFullScreen {
                NowPlayingView()
                    .transition(.move(edge: .bottom))
                    .zIndex(10)
            }
        }
        .tint(Theme.accent)
        .animation(Motion.spring, value: player.current == nil)
        .animation(Motion.quick, value: keyboardVisible)
        .onAppear {
            tabBarHeight = TabBarMetrics.height()
            // La barre UIKit n'est mesurable qu'une fois affichée : seconde lecture juste après.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { tabBarHeight = TabBarMetrics.height() }
        }
        // Préparation du plein écran dès qu'un morceau démarre (fond flouté + grande pochette) :
        // l'ouverture du lecteur est instantanée, sans à-coup.
        #if DEBUG
        .task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            DemoMode.run(library: library, player: player, router: router, playlists: playlists)
        }
        #endif
        .task(id: player.current?.id) {
            guard let track = player.current else { return }
            _ = await ArtworkCache.shared.load(for: track, maxPixel: 1000)
            if BlurredArtwork.cached(track) == nil { _ = await BlurredArtwork.make(track) }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardVisible = false
        }
        // Playlist Phonk / Funk tenue à jour TOUTE SEULE : au lancement et à chaque changement de
        // la bibliothèque (synchro, import, suppression). Regroupé : une passe 1 s après la rafale.
        .task(id: library.tracks.count) {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            // Bibliothèque vide = rien à faire. Surtout : ne JAMAIS « nettoyer » favoris et playlists
            // contre une bibliothèque vide (sinon un index illisible effacerait tout).
            guard !Task.isCancelled, !library.tracks.isEmpty else { return }
            favorites.prune(keeping: library.tracks)
            playlists.prune(keeping: library.tracks)
            playlists.buildGenrePlaylists(library: library)
        }
    }

    /// iOS 26 : la VRAIE barre d'Apple Music — barre d'onglets en verre (Liquid Glass) qui se
    /// réduit quand on fait défiler, et mini-lecteur intégré au-dessus d'elle par le système
    /// (placement, animation et défilement gérés par iOS : plus aucun décalage ni saut).
    /// iOS 17–18 : mini-lecteur maison posé au-dessus des onglets.
    @ViewBuilder private var shell: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            tabs
                .tabBarMinimizeBehavior(.onScrollDown)
                .tabViewBottomAccessory { MiniPlayerAccessory() }
        } else {
            legacyShell
        }
        #else
        legacyShell
        #endif
    }

    @ViewBuilder private var legacyShell: some View {
        ZStack(alignment: .bottom) {
            tabs
            // UN SEUL mini-lecteur, permanent, posé juste au-dessus de la barre d'onglets.
            // Il RESTE affiché sous le lecteur plein écran : à la fermeture, plus de saut.
            if player.current != nil && !keyboardVisible {
                MiniPlayer()
                    .padding(.bottom, tabBarHeight + 6)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(5)
            }
        }
    }

    private var tabs: some View {
            TabView(selection: $router.tab) {
                // Chaque onglet réserve en bas la place du mini-lecteur (posé une seule fois,
                // plus bas) : la barre d'onglets reste toujours accessible, réglages compris.
                LibraryView()
                    .miniPlayerSpacer()
                    .tabItem { Label("Bibliothèque", systemImage: "square.stack.fill") }
                    .tag(AppRouter.Tab.library)

                FavoritesView()
                    .miniPlayerSpacer()
                    .tabItem { Label("Favoris", systemImage: "heart.fill") }
                    .tag(AppRouter.Tab.favorites)

                PlaylistsView()
                    .miniPlayerSpacer()
                    .tabItem { Label("Playlists", systemImage: "music.note.list") }
                    .tag(AppRouter.Tab.playlists)

                SearchView()
                    .miniPlayerSpacer()
                    .tabItem { Label("Recherche", systemImage: "magnifyingglass") }
                    .tag(AppRouter.Tab.search)

                SettingsView()
                    .miniPlayerSpacer()
                    .tabItem { Label("Réglages", systemImage: "gearshape.fill") }
                    .tag(AppRouter.Tab.settings)
            }
            .tint(Theme.accent)
            .onChange(of: router.tab) { _, _ in Haptics.choose() }
    }
}





