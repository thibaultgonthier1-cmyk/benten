import AVKit
import MediaPlayer
import SwiftUI
import UniformTypeIdentifiers

/// Destinations de navigation de la bibliothèque (pages poussées, comme Apple Music).
enum LibraryRoute: Hashable {
    case album(String)
    case artist(String)
}

// MARK: - Bibliothèque

struct LibraryView: View {
    // FLUIDITÉ : la bibliothèque n'observe NI le lecteur, NI le routeur, NI les favoris. Avant,
    // chaque play/pause, changement d'onglet ou cœur recalculait toute la grille. Les cellules
    // lisent elles-mêmes ce qui les concerne (`NowPlayingState`, favoris) : seules les cellules
    // VISIBLES et CONCERNÉES se redessinent.
    @EnvironmentObject private var library: Library
    @State private var showImporter = false
    @State private var mode: BrowseMode = LibraryView.initialMode
    @Namespace private var modeChip
    private var nowPlaying: NowPlayingState { .shared }

    private static var initialMode: BrowseMode {
        #if DEBUG
        if DemoMode.value("demoScreen") == "tracks" { return .tracks }
        #endif
        return .albums
    }
    @State private var deletion: DeletionRequest?

    enum BrowseMode: String, CaseIterable {
        case albums = "Albums", artists = "Artistes", tracks = "Titres"
        var icon: String {
            switch self {
            case .albums: return "square.stack.fill"
            case .artists: return "music.mic"
            case .tracks: return "music.note"
            }
        }
    }

    private let layout = DeviceLayout.current

    var body: some View {
        NavigationStack {
            ZStack {
                AnimatedBackdrop()

                if library.tracks.isEmpty {
                    emptyState
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                if !Theme.appleStyle { header }
                                modePicker
                                content
                            }
                            .padding(.horizontal, layout.pagePadding)
                            .padding(.trailing, mode == .tracks ? 14 : 0)
                            .padding(.bottom, 20)
                        }
                        // Index A–Z sur le bord droit, comme la liste des titres d'Apple Music.
                        .overlay(alignment: .trailing) {
                            if mode == .tracks, library.tracks.count > 30 {
                                // Ancres pré-calculées par la bibliothèque (hors fil principal) :
                                // avant, 1000+ titres « repliés » (accents, casse) à CHAQUE rendu.
                                let anchors = library.letterAnchors
                                AlphabetIndex(letters: anchors.map(\.letter)) { letter in
                                    if let id = anchors.first(where: { $0.letter == letter })?.id {
                                        proxy.scrollTo(id, anchor: .top)
                                    }
                                }
                                .padding(.vertical, 120)
                                .padding(.trailing, 2)
                                .transition(.opacity)
                            }
                        }
                    }
                }
            }
            .swipeBackEverywhere()
            .navigationTitle(Theme.appleStyle ? "Bibliothèque" : "")
            .navigationBarTitleDisplayMode(Theme.appleStyle ? .large : .inline)
            .navigationDestination(for: LibraryRoute.self) { route in
                switch route {
                case .album(let id): AlbumDetailView(albumID: id)
                case .artist(let id): ArtistDetailView(artistID: id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .fill(Theme.accentGradient)
                                .frame(width: 28, height: 28)
                                .shadow(color: Theme.accent.opacity(0.45), radius: 6)
                            Text("B")
                                .font(.system(size: 15, weight: .bold, design: .serif))
                                .foregroundStyle(Theme.ink)
                        }
                        if !Theme.appleStyle {
                            Text("Benten")
                                .font(.system(size: 18, design: .serif))
                                .foregroundStyle(Theme.ivory)
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        Button {
                            Haptics.tap()
                            AppRouter.shared?.tab = .search
                        } label: {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(Theme.ivory.opacity(0.9))
                        }
                        Button {
                            Haptics.press()
                            showImporter = true
                        } label: {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 22))
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
            }
            .toolbarBackground(Theme.ink, for: .navigationBar)
            .deletionConfirmation($deletion)
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav, .aiff],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case .success(let urls):
                    Task { await library.importFiles(urls) }
                case .failure(let error):
                    library.lastError = error.localizedDescription
                }
            }
            .alert("Impossible", isPresented: Binding(
                get: { library.lastError != nil },
                set: { if !$0 { library.lastError = nil } }
            )) {
                Button("OK", role: .cancel) { library.lastError = nil }
            } message: {
                Text(library.lastError ?? "")
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch mode {
        case .albums:
            RecentShelf()
            LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 8) {
                ForEach(library.albums) { album in
                    NavigationLink(value: LibraryRoute.album(album.id)) {
                        LiveAlbumTile(album: album)
                    }
                    .buttonStyle(PressableStyle())
                    .contextMenu {
                        Button { nowPlaying.play(album.tracks, startingAt: 0) } label: { Label("Lire", systemImage: "play.fill") }
                        Button { nowPlaying.playShuffled(album.tracks) } label: { Label("Aléatoire", systemImage: "shuffle") }
                        DeleteFromDeviceButton("Supprimer l'album de l'iPhone") {
                            deletion = DeletionRequest(tracks: album.tracks, name: album.title)
                        }
                    }
                }
            }

        case .artists:
            LazyVGrid(columns: layout.columns, spacing: layout.gridSpacing + 8) {
                ForEach(library.artists) { artist in
                    NavigationLink(value: LibraryRoute.artist(artist.id)) {
                        ArtistTileView(artist: artist)
                    }
                    .buttonStyle(PressableStyle())
                    .contextMenu {
                        // Liste des titres calculée AU TOUCHER (avant : à chaque rendu, par artiste).
                        Button { nowPlaying.play(artist.albums.flatMap(\.tracks), startingAt: 0) } label: { Label("Tout lire", systemImage: "play.fill") }
                        Button { nowPlaying.playShuffled(artist.albums.flatMap(\.tracks)) } label: { Label("Aléatoire", systemImage: "shuffle") }
                        DeleteFromDeviceButton("Supprimer l'artiste de l'iPhone") {
                            deletion = DeletionRequest(tracks: artist.albums.flatMap(\.tracks), name: artist.name)
                        }
                    }
                }
            }

        case .tracks:
            // LazyVStack : seules les lignes visibles sont construites (fluide avec 1000+ titres).
            LazyVStack(spacing: 2) {
                let list = library.tracksByTitle
                ForEach(list) { track in
                    LibraryTrackRow(track: track) { nowPlaying.play(list, from: track) }
                        .contextMenu {
                            DeleteFromDeviceButton { deletion = DeletionRequest(track: track) }
                        }
                        .id(track.id)
                }
            }
        }
    }

    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ForEach(BrowseMode.allCases, id: \.self) { value in
                    let selected = mode == value
                    Button {
                        guard mode != value else { return }
                        Haptics.choose()
                        // Contenu échangé IMMÉDIATEMENT (pas de fondu croisé de deux grilles
                        // entières, coûteux et mou) ; seule la pastille glisse, comme Apple.
                        mode = value
                    } label: {
                        Label(value.rawValue, systemImage: value.icon)
                            .font(.system(size: 13.5, weight: selected ? .semibold : .medium))
                            .foregroundStyle(selected ? Theme.ink : Theme.ivory.opacity(0.9))
                            .padding(.horizontal, 13)
                            .padding(.vertical, 8)
                            .background {
                                ZStack {
                                    Capsule().fill(Color.white.opacity(0.08))
                                    if selected {
                                        Capsule()
                                            .fill(Theme.accentGradient)
                                            .matchedGeometryEffect(id: "chip", in: modeChip)
                                    }
                                }
                            }
                    }
                    .buttonStyle(PressableStyle(scale: 0.92))
                }
            }
            .animation(Motion.quick, value: mode)
            Text("\(library.tracks.count) morceaux · \(library.albums.count) albums · v\(Bundle.main.appVersion)")
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundStyle(Theme.dim)
        }
        .padding(.top, Theme.appleStyle ? 0 : 4)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("今宵 · ce soir")
                .font(.system(size: 11, weight: .medium))
                .tracking(2.2)
                .foregroundStyle(Theme.accent.opacity(0.75))
            Text("Ta bibliothèque,\nen local")
                .serifTitle(30)
        }
        .padding(.top, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Theme.accentGradient)
                    .frame(width: 84, height: 84)
                    .shadow(color: Theme.accent.opacity(0.35), radius: 22)
                Image(systemName: "music.note")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(Theme.ink)
                    .symbolEffect(.pulse)
            }
            Text("Aucune musique")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(Theme.ivory)
            Text("Touche + pour choisir des fichiers, ou récupère ta bibliothèque du PC depuis les Réglages.")
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 44)
        }
    }
}

// MARK: - Cellules « vivantes »

/// Étagère « Écoutés récemment » : reprendre en un geste ce qu'on écoutait. Vue À PART : elle
/// seule se redessine quand l'historique change (avant : toute la bibliothèque).
private struct RecentShelf: View {
    @EnvironmentObject private var library: Library
    private var nowPlaying: NowPlayingState { .shared }

    var body: some View {
        let recent = nowPlaying.history.prefix(16).compactMap { library.track(withID: $0) }
        let currentID = nowPlaying.currentID
        if recent.count > 1 {
            VStack(alignment: .leading, spacing: 10) {
                Text("Écoutés récemment")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Theme.ivory)
                ScrollView(.horizontal, showsIndicators: false) {
                    // HStack (16 tuiles maximum) : aucune tuile qui « saute » en apparaissant,
                    // et défilement aimanté tuile par tuile comme les étagères d'Apple Music.
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(recent) { track in
                            Button {
                                Haptics.tap()
                                playFromItsAlbum(track)
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    ZStack(alignment: .bottomTrailing) {
                                        ArtworkView(track: track, maxPixel: 560)
                                            .frame(width: 132, height: 132)
                                            .clipShape(RoundedRectangle(cornerRadius: Theme.coverRadius, style: .continuous))
                                        if currentID == track.id {
                                            LiveNowPlayingBars(color: Theme.ink)
                                                .frame(width: 13, height: 11)
                                                .padding(7)
                                                .background(Circle().fill(Theme.accentGradient))
                                                .padding(6)
                                        }
                                    }
                                    Text(track.title)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(Theme.ivory)
                                        .lineLimit(1)
                                    Text(track.artist)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.dim)
                                        .lineLimit(1)
                                }
                                .frame(width: 132, alignment: .leading)
                            }
                            .buttonStyle(PressableStyle())
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollClipDisabled()
            }
            .padding(.bottom, 6)
        }
    }

    /// Lit un morceau dans le contexte de son album (la suite enchaîne naturellement).
    private func playFromItsAlbum(_ track: Track) {
        if let album = library.albums.first(where: { $0.tracks.contains { $0.id == track.id } }),
           let index = album.tracks.firstIndex(where: { $0.id == track.id }) {
            nowPlaying.play(album.tracks, startingAt: index)
        } else {
            nowPlaying.play([track], startingAt: 0)
        }
    }
}

/// Tuile d'album de grille qui sait SEULE si elle est en cours : un changement de morceau ne
/// redessine que les tuiles visibles, jamais la grille.
struct LiveAlbumTile: View {
    let album: Library.AlbumGroup
    private var nowPlaying: NowPlayingState { .shared }

    var body: some View {
        let isCurrent = nowPlaying.currentID.map { id in album.tracks.contains { $0.id == id } } ?? false
        AlbumTileView(album: album, isCurrent: isCurrent)
    }
}

/// Ligne de la liste « Titres » : lit elle-même son cœur (un favori ne redessine qu'elle).
private struct LibraryTrackRow: View {
    let track: Track
    let onPlay: () -> Void
    @EnvironmentObject private var favorites: FavoritesStore

    var body: some View {
        TrackRow(
            track: track,
            isFavorite: favorites.contains(track.id),
            onPlay: onPlay,
            onToggleFavorite: { favorites.toggle(track.id) }
        )
    }
}

/// Barres « en lecture » qui lisent ELLES-MÊMES lecture/pause : une pause ne redessine que ce
/// petit badge, pas la ligne ni la liste.
struct LiveNowPlayingBars: View {
    var color: Color = .white

    var body: some View {
        NowPlayingBars(animating: NowPlayingState.shared.playing, color: color)
    }
}

// MARK: - Tuiles

/// Tuile d'album (contenu seul : la navigation est portée par le `NavigationLink` parent).
struct AlbumTileView: View {
    let album: Library.AlbumGroup
    let isCurrent: Bool

    private var glow: Color {
        Theme.appleStyle ? .clear : (ArtworkCache.shared.cachedTint(for: album.artworkTrack) ?? Theme.accent)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                if !Theme.appleStyle {
                    CoverGlow(color: glow, intensity: isCurrent ? 0.95 : 0.6)
                }
                ArtworkView(track: album.artworkTrack, maxPixel: 560)
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.coverRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.coverRadius, style: .continuous)
                            .strokeBorder(Theme.hairline)
                    )
                if isCurrent {
                    LiveNowPlayingBars(color: Theme.ink)
                        .frame(width: 15, height: 13)
                        .padding(8)
                        .background(Circle().fill(Theme.accentGradient))
                        .padding(8)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(album.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.ivory)
                    .lineLimit(1)
                Text(album.artist)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }
}

/// Tuile d'artiste : photo ronde, comme Apple Music.
struct ArtistTileView: View {
    let artist: Library.ArtistGroup

    var body: some View {
        VStack(spacing: 8) {
            ArtworkView(track: artist.artworkTrack, maxPixel: 560)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.hairline))
            Text(artist.name)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.ivory)
                .lineLimit(1)
            Text("\(artist.trackCount) titre\(artist.trackCount > 1 ? "s" : "")")
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)
        }
        .contentShape(Rectangle())
    }
}

/// Pochette : image extraite du fichier, ou repli dessiné (dégradé de l'accent).
///
/// Décodage + redimensionnement HORS du fil principal (`ArtworkCache.load`). Le fil principal ne
/// décode jamais d'image : le défilement reste lisse. `maxPixel` : 180 (lignes, mini-lecteur),
/// 560 (tuiles, en-têtes), 1000 (lecteur plein écran).
///
/// POCHETTES NON CARRÉES (16:9…) — elles s'affichaient ROGNÉES au centre. Cause : elles étaient
/// dessinées dans un `ZStack { flou .scaledToFill ; net .scaledToFit }`. Le calque « fill »
/// déborde du cadre (356 × 200 pour une case de 200 × 200), le `ZStack` prend cette taille, puis
/// PLACE chacun de ses enfants en leur proposant SA propre taille : le calque « fit » recevait donc
/// 356 × 200, devenait aussi grand que le flou et le recouvrait exactement — résultat identique à
/// un simple rognage, flou invisible. Désormais chaque calque est un `overlay` distinct de
/// `Color.clear` : chacun reçoit le cadre EXACT, le « fit » tient entier dedans, quoi qu'il arrive.
struct ArtworkView: View {
    let track: Track
    var maxPixel: CGFloat = 560
    @State private var loaded: Loaded?

    /// Clé de chargement : morceau + fichier de pochette + taille.
    private struct LoadKey: Equatable {
        let id: UUID
        let artwork: String?
        let pixels: Int
    }

    /// Image chargée, AVEC la clé pour laquelle elle l'a été : quand la vue est réutilisée pour un
    /// autre morceau (mini-lecteur, changement de titre), on n'affiche jamais une image périmée,
    /// et une pochette déjà en cache apparaît dans la MÊME image que le changement.
    private struct Loaded {
        let key: LoadKey
        let image: UIImage
        let backdrop: UIImage?
    }

    private var loadKey: LoadKey {
        LoadKey(id: track.id, artwork: track.artworkName, pixels: Int(maxPixel))
    }

    var body: some View {
        let cache = ArtworkCache.shared
        let key = loadKey
        let fresh = loaded?.key == key ? loaded : nil
        let image = fresh?.image ?? cache.cached(for: track, maxPixel: maxPixel)
        let wide = image.map(ArtworkCache.isNonSquare) ?? false

        // `Color.clear` prend EXACTEMENT la place proposée ; chaque calque est un overlay séparé
        // qui reçoit ce cadre exact (jamais la taille d'un voisin qui déborde).
        Color.clear
            .overlay {
                if let image {
                    if wide {
                        // Fond : la pochette floutée, PRÉ-CALCULÉE (aucun flou en direct).
                        if let fill = fresh?.backdrop ?? cache.cachedBackdrop(for: track, maxPixel: maxPixel) {
                            Image(uiImage: fill)
                                .resizable()
                                .interpolation(.medium)
                                .scaledToFill()
                                .opacity(0.75)
                                .transition(.opacity)
                        } else {
                            Theme.ink3
                        }
                    } else {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .transition(.opacity)
                    }
                } else {
                    Theme.accentGradient
                        .overlay(
                            Image(systemName: "music.note")
                                .font(.system(size: 22, weight: .light))
                                .foregroundStyle(Theme.ink.opacity(0.55))
                        )
                }
            }
            .overlay {
                // Pochette rectangulaire : ENTIÈRE, rien n'est coupé.
                if let image, wide {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .transition(.opacity)
                }
            }
            .clipped()
            .task(id: key) {
                let cache = ArtworkCache.shared
                if let hit = cache.cached(for: track, maxPixel: maxPixel),
                   !ArtworkCache.isNonSquare(hit) || cache.cachedBackdrop(for: track, maxPixel: maxPixel) != nil {
                    // Déjà prête : affichée dès le premier rendu (via le cache), sans animation.
                    loaded = Loaded(key: key, image: hit, backdrop: cache.cachedBackdrop(for: track, maxPixel: maxPixel))
                    return
                }
                let alreadyShown = cache.cached(for: track, maxPixel: maxPixel) != nil
                guard let image = await cache.load(for: track, maxPixel: maxPixel), !Task.isCancelled else { return }
                let ready = Loaded(key: key, image: image, backdrop: cache.cachedBackdrop(for: track, maxPixel: maxPixel))
                if alreadyShown {
                    loaded = ready
                } else {
                    // Fondu court (comme Apple Music) seulement quand la pochette arrive vraiment.
                    withAnimation(.easeOut(duration: 0.18)) { loaded = ready }
                }
            }
    }
}

// MARK: - Mini-lecteur

/// Barre de lecture réduite, posée JUSTE AU-DESSUS des onglets (dans chaque onglet).
struct MiniPlayer: View {
    @EnvironmentObject private var player: Player
    @State private var nextTaps = 0

    var body: some View {
        if let track = player.current {
            HStack(spacing: 12) {
                ArtworkView(track: track, maxPixel: 180)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .shadow(color: .black.opacity(0.3), radius: 4, y: 2)

                VStack(alignment: .leading, spacing: 1) {
                    Text(track.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .lineLimit(1)
                    Text(track.artist)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                }
                .id(track.id)
                .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))

                Spacer(minLength: 6)

                Button {
                    Haptics.press()
                    player.toggle()
                } label: {
                    Image(systemName: player.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(TransportStyle(haloSize: 42))

                Button {
                    Haptics.tap()
                    nextTaps += 1
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .symbolEffect(.bounce, value: nextTaps)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(TransportStyle(haloSize: 42))
            }
            .animation(Motion.spring, value: track.id)
            .animation(Motion.quick, value: player.playing)
            // Glisser : gauche = suivant, droite = précédent, haut = ouvrir le lecteur.
            .trackSwipe(
                onNext: { player.next() },
                onPrevious: { player.previous(force: true) },
                onUp: { withAnimation(Motion.sheet) { player.showFullScreen = true } }
            )
            .padding(.leading, 8)
            .padding(.trailing, 6)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.ink2.opacity(0.55)))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.hairline))
                    .shadow(color: .black.opacity(0.45), radius: 16, y: 6)
            )
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
            .onTapGesture {
                Haptics.tap()
                withAnimation(Motion.sheet) { player.showFullScreen = true }
            }
        }
    }
}

/// Réserve, en bas de chaque onglet, la place du mini-lecteur (pour que le dernier élément d'une
/// liste ne passe pas dessous). Simple espace vide : le mini-lecteur lui-même est UNIQUE et posé
/// une seule fois par-dessus les onglets (voir `RootView`).
struct MiniPlayerSpacer: ViewModifier {
    // Plus d'abonnement au lecteur entier : ce modificateur (un par onglet) était réévalué à
    // chaque play/pause/BPM… Il ne dépend plus que de « y a-t-il un morceau ? ».
    private var nowPlaying: NowPlayingState { .shared }

    func body(content: Content) -> some View {
        // iOS 26 : le système réserve lui-même la place de la barre et du mini-lecteur (et on ne
        // lit alors même pas l'état du lecteur : aucune dépendance).
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: ShellStyle.systemAccessory || nowPlaying.currentID == nil ? 0 : 70)
        }
    }
}

enum ShellStyle {
    /// Vrai quand la barre d'onglets d'iOS 26 (verre, mini-lecteur intégré) est utilisée.
    static var systemAccessory: Bool {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { return true }
        #endif
        return false
    }
}

#if compiler(>=6.2)
/// Mini-lecteur d'iOS 26, intégré à la barre d'onglets comme dans Apple Music : le système le
/// place, l'anime, et le replie à côté des onglets quand on fait défiler vers le bas.
@available(iOS 26.0, *)
struct MiniPlayerAccessory: View {
    @EnvironmentObject private var player: Player
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    @State private var nextTaps = 0

    var body: some View {
        let inline = placement == .inline
        HStack(spacing: 10) {
            Group {
                if let track = player.current {
                    ArtworkView(track: track, maxPixel: 180)
                } else {
                    ZStack {
                        Color.white.opacity(0.08)
                        Image(systemName: "music.note")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.dim)
                    }
                }
            }
            .frame(width: inline ? 26 : 32, height: inline ? 26 : 32)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

            VStack(alignment: .leading, spacing: 0) {
                Text(player.current?.title ?? "Aucune lecture")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.ivory)
                    .lineLimit(1)
                if !inline, let artist = player.current?.artist {
                    Text(artist)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                }
            }
            .id(player.current?.id)
            .transition(.opacity)

            Spacer(minLength: 4)

            Button {
                Haptics.press()
                player.toggle()
            } label: {
                Image(systemName: player.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Theme.ivory)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(player.current == nil)

            if !inline {
                Button {
                    Haptics.tap()
                    nextTaps += 1
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.ivory)
                        .symbolEffect(.bounce, value: nextTaps)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(player.current == nil)
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 4)
        .contentShape(Rectangle())
        // Comme Apple Music : glisser le mini-lecteur change de morceau ; vers le haut, il s'ouvre.
        .trackSwipe(
            onNext: { if player.current != nil { player.next() } },
            onPrevious: { if player.current != nil { player.previous(force: true) } },
            onUp: { if player.current != nil { withAnimation(Motion.sheet) { player.showFullScreen = true } } }
        )
        .onTapGesture {
            guard player.current != nil else { return }
            Haptics.tap()
            withAnimation(Motion.sheet) { player.showFullScreen = true }
        }
        .animation(Motion.quick, value: player.current?.id)
        .animation(Motion.quick, value: player.playing)
    }
}
#endif

extension View {
    func miniPlayerSpacer() -> some View { modifier(MiniPlayerSpacer()) }
}

/// Hauteur réelle de la barre d'onglets (lue sur la vraie barre UIKit sous la TabView).
enum TabBarMetrics {
    @MainActor static func height() -> CGFloat {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows {
            if let bar = findTabBar(in: window.rootViewController) {
                let height = bar.frame.height - window.safeAreaInsets.bottom
                if height > 30 { return height }
            }
        }
        return 49
    }

    @MainActor private static func findTabBar(in controller: UIViewController?) -> UITabBar? {
        guard let controller else { return nil }
        if let tabs = controller as? UITabBarController { return tabs.tabBar }
        for child in controller.children {
            if let bar = findTabBar(in: child) { return bar }
        }
        return findTabBar(in: controller.presentedViewController)
    }
}

// MARK: - Pages album et artiste

struct AlbumDetailView: View {
    let albumID: String
    // Pas d'abonnement au lecteur : la page (en-tête, pochette holographique, liste) ne se
    // reconstruit plus à chaque play/pause ; seules les lignes concernées se redessinent.
    @EnvironmentObject private var library: Library
    @Environment(\.dismiss) private var dismiss
    @State private var deletion: DeletionRequest?
    @State private var leaveAfter = false

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            if let album = library.albums.first(where: { $0.id == albumID }) {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        VStack(spacing: 12) {
                            ArtworkView(track: album.artworkTrack, maxPixel: 560)
                                .frame(width: 250, height: 250)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .holographic()
                                .shadow(color: .black.opacity(0.55), radius: 24, y: 12)
                                .padding(.top, 8)
                            VStack(spacing: 3) {
                                Text(album.title)
                                    .font(.system(size: 22, weight: .bold))
                                    .foregroundStyle(Theme.ivory)
                                    .multilineTextAlignment(.center)
                                Text(album.artist)
                                    .font(.system(size: 18))
                                    .foregroundStyle(Theme.accent)
                                Text("\(album.tracks.count) titre\(album.tracks.count > 1 ? "s" : "") · \(TimeFormatting.minutes(album.tracks.reduce(0) { $0 + $1.duration }))")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.dim)
                                    .padding(.top, 2)
                            }
                            .padding(.horizontal, 20)
                            PlayShuffleButtons(tracks: album.tracks)
                        }
                        .padding(.bottom, 14)

                        ForEach(Array(album.tracks.enumerated()), id: \.element.id) { offset, track in
                            NumberedTrackRow(number: offset + 1, track: track) {
                                NowPlayingState.shared.play(album.tracks, startingAt: offset)
                            }
                            .contextMenu {
                                DeleteFromDeviceButton {
                                    leaveAfter = album.tracks.count <= 1
                                    deletion = DeletionRequest(track: track)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            } else {
                Text("Album introuvable").foregroundStyle(Theme.dim)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.ink, for: .navigationBar)
        .toolbar {
            if let album = library.albums.first(where: { $0.id == albumID }) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        DeleteFromDeviceButton("Supprimer l'album de l'iPhone") {
                            leaveAfter = true
                            deletion = DeletionRequest(tracks: album.tracks, name: album.title)
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").foregroundStyle(Theme.accent)
                    }
                }
            }
        }
        .deletionConfirmation($deletion) {
            if leaveAfter { dismiss() }
        }
    }
}

struct ArtistDetailView: View {
    let artistID: String
    @EnvironmentObject private var library: Library
    @Environment(\.dismiss) private var dismiss
    @State private var deletion: DeletionRequest?
    @State private var leaveAfter = false

    var body: some View {
        ZStack {
            AnimatedBackdrop()
            if let artist = library.artists.first(where: { $0.id == artistID }) {
                let all = artist.albums.flatMap(\.tracks)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(spacing: 10) {
                            ArtworkView(track: artist.artworkTrack, maxPixel: 560)
                                .frame(width: 170, height: 170)
                                .clipShape(Circle())
                                .holographic()
                                .shadow(color: .black.opacity(0.55), radius: 20, y: 10)
                            Text(artist.name)
                                .font(.system(size: 26, weight: .bold))
                                .foregroundStyle(Theme.ivory)
                                .multilineTextAlignment(.center)
                            PlayShuffleButtons(tracks: all)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)

                        Text("Albums")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(Theme.ivory)
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 14) {
                                ForEach(artist.albums) { album in
                                    NavigationLink(value: LibraryRoute.album(album.id)) {
                                        LiveAlbumTile(album: album)
                                            .frame(width: 150)
                                    }
                                    .buttonStyle(PressableStyle())
                                }
                            }
                        }

                        Text("Titres")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(Theme.ivory)
                        LazyVStack(spacing: 2) {
                            ForEach(all) { track in
                                TrackRow(track: track, onPlay: { NowPlayingState.shared.play(all, from: track) })
                                    .contextMenu {
                                        DeleteFromDeviceButton {
                                            leaveAfter = all.count <= 1
                                            deletion = DeletionRequest(track: track)
                                        }
                                    }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            } else {
                Text("Artiste introuvable").foregroundStyle(Theme.dim)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.ink, for: .navigationBar)
        .toolbar {
            if let artist = library.artists.first(where: { $0.id == artistID }) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        DeleteFromDeviceButton("Supprimer l'artiste de l'iPhone") {
                            leaveAfter = true
                            deletion = DeletionRequest(tracks: artist.albums.flatMap(\.tracks), name: artist.name)
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").foregroundStyle(Theme.accent)
                    }
                }
            }
        }
        .deletionConfirmation($deletion) {
            if leaveAfter { dismiss() }
        }
    }
}

/// Boutons « Lecture » / « Aléatoire » des pages album, artiste.
struct PlayShuffleButtons: View {
    let tracks: [Track]

    var body: some View {
        HStack(spacing: 10) {
            button("Lecture", icon: "play.fill") { NowPlayingState.shared.play(tracks, startingAt: 0) }
            button("Aléatoire", icon: "shuffle") { NowPlayingState.shared.playShuffled(tracks) }
        }
        .disabled(tracks.isEmpty)
    }

    private func button(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.press()
            action()
        } label: {
            Label(title, systemImage: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.08)))
        }
        .buttonStyle(PressableStyle())
    }
}

/// Ligne numérotée d'un album ; le morceau en cours montre des barres animées à la place du n°.
struct NumberedTrackRow: View {
    let number: Int
    let track: Track
    let onPlay: () -> Void

    var body: some View {
        // Lu ICI (pas dans la page) : un changement de morceau ne redessine que deux lignes.
        let isCurrent = NowPlayingState.shared.currentID == track.id
        Button {
            Haptics.tap()
            onPlay()
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    ZStack {
                        if isCurrent {
                            LiveNowPlayingBars(color: Theme.accent)
                                .frame(width: 15, height: 13)
                        } else {
                            Text("\(number)")
                                .font(.system(size: 14).monospacedDigit())
                                .foregroundStyle(Theme.dim)
                        }
                    }
                    .frame(width: 26)
                    Text(track.title)
                        .font(.system(size: 15.5))
                        .foregroundStyle(isCurrent ? Theme.accent : Theme.ivory)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(TimeFormatting.short(track.duration))
                        .font(.system(size: 12.5).monospacedDigit())
                        .foregroundStyle(Theme.dim)
                }
                .padding(.vertical, 12)
                Divider().overlay(Theme.hairline).padding(.leading, 38)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.98))
    }
}

/// Formatage des durées, partagé.
enum TimeFormatting {
    static func short(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func minutes(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0 min" }
        let minutes = Int((seconds / 60).rounded())
        return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(minutes) min"
    }
}
