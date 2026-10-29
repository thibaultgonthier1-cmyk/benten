import type React from "react";
import { useCallback, useInsertionEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion, type TargetAndTransition } from "framer-motion";
import { Construction, FolderOpen, Search } from "lucide-react";
import { routeKey, sameRoute, uiStore, useUi, type Route } from "../state/ui";
import { planScroll, rememberScroll, savedScroll } from "./scrollMemory";
import { exitIsInstant } from "./routeTransition";
import { DetachedPresence } from "../ui/DetachedPresence";
import { libraryStore, useLibrary } from "../state/library";
import { playerStore } from "../state/player";
import { pageTransition } from "../theme/ds/motion";
import type { Album } from "../lib/library";
import { canResume } from "../lib/viewModels";
import type { TrackRow } from "../../shared/types";
import { SearchResults } from "../components/SearchResults";
import { Playlists } from "../components/Playlists";
import { BentenMark } from "../ui/BentenMark";
import { Button } from "../ui/Button";
import { useMotion } from "../ui/useMotion";
import { AlbumsView } from "../views/AlbumsView";
import { AlbumView } from "../views/AlbumView";
import { ArtistsView } from "../views/ArtistsView";
import { ArtistView } from "../views/ArtistView";
import { TracksView } from "../views/TracksView";
import { EmptyState, PageHeader } from "../views/common";
import { anchorFromEvent, useViewMenus } from "../views/menus";

/** Actions de lecture / bibliothèque fournies par l'App (chemins de lecture inchangés). */
export interface RouteViewActions {
  /** Joue l'album depuis `index` (file = pistes de l'album). */
  playAlbum(album: Album, index?: number): void;
  /** « Lecture » d'un album entier : dans l'ordre (coupe le mélange), depuis la 1re piste. */
  playAlbumInOrder(album: Album): void;
  /** Lecture aléatoire de l'album (active le mélange, départ au hasard). */
  shuffleAlbum(album: Album): void;
  /** Lecture / pause de la piste courante. */
  togglePlay(): void;
  playTracks(tracks: readonly TrackRow[], index?: number): void;
  albumPlayNext(album: Album): void;
  albumAddToQueue(album: Album): void;
  /** Ouvre la feuille « Ajouter à une playlist » existante pour l'album. */
  albumAddToPlaylist(album: Album): void;
  /** Ouvre la même feuille pour des pistes quelconques (menu d'un titre). */
  openPlaylistSheet(trackIds: readonly number[], label?: string): void;
}

interface PageProps {
  route: Route;
  scrollRef: RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/**
 * Rend la page de la route courante avec une transition animée (`AnimatePresence`) : la page
 * entrante monte de 8 px en fondu, la sortante s'efface ; durées via `motionFor` (réglage
 * d'intensité + préférence système). Le défilement revient en haut à chaque changement de page
 * (ou reprend sa position au retour par « Précédent »).
 *
 * Mode `popLayout` : la page sortante est sortie du flux pendant son effacement (~100 ms) et la
 * nouvelle se monte dans le MÊME rendu — condition pour qu'un élément partagé (`layoutId`) passe
 * de l'une à l'autre. Grille ↔ album : la page quittée disparaît d'un coup et l'album n'entre pas
 * en fondu global — la pochette voyage de la tuile à l'en-tête et doit rester visible ; le reste
 * de la page album (titre, boutons, liste) joue sa propre entrée.
 *
 * Routes : home (grille d'albums, ou accueil/scan si la bibliothèque est vide — jusqu'à la
 * Tâche 11), tracks (tous les titres), albums, favorites (même grille filtrée), album, artists
 * (grille d'artistes), artist, playlists (ancienne vue), search ;
 * les autres → état vide neutre « En construction ».
 */
export function RouteView({ scrollRef, actions }: Omit<PageProps, "route">): JSX.Element {
  const route = useUi((s) => s.route);
  const m = useMotion();
  const t = pageTransition(m);
  const key = routeKey(route);
  const prevRef = useRef<Route>(route);

  // Calculé une fois par changement de page : transition partagée (grille ↔ album) et position de
  // défilement à restaurer (retour par « Précédent »), annoncée à la grille virtualisée.
  const nav = useMemo(() => {
    const prev = prevRef.current;
    const prevKey = routeKey(prev);
    const { future } = uiStore.getState();
    const back = prevKey !== key && future.length > 0 && sameRoute(future[0]!, prev);
    const restore = back ? savedScroll(key) : null;
    planScroll(key, restore);
    const shared = m.enabled && prevKey !== key && isSharedPair(prev, route);
    // Lecture seule pendant le rendu : position encore celle de la page quittée.
    const prevScroll = scrollRef.current?.scrollTop ?? 0;
    const instant = prevKey !== key && exitIsInstant({ shared, prevScroll, nextScroll: restore ?? 0 });
    return { prevKey, restore, shared, instant };
  }, [key]);

  // Phase de MUTATION (avant toute mesure de layout) : on relève le défilement de la page quittée
  // puis on place la nouvelle (haut, ou position restaurée). L'instantané de la pochette (avant
  // mutation) est déjà pris à l'ancienne position ; l'en-tête album est mesuré à la nouvelle.
  useInsertionEffect(() => {
    const el = scrollRef.current;
    if (el && nav.prevKey !== key) {
      rememberScroll(nav.prevKey, el.scrollTop);
      el.scrollTop = nav.restore ?? 0;
    }
    prevRef.current = route;
  }, [key]);

  // La page quittée s'efface d'un coup quand la pochette voyage OU quand le défilement change
  // (sinon elle sauterait pendant son fondu) ; la page album n'entre pas en fondu global.
  const variants = useMemo(
    () => ({
      exit: (instant: boolean) => (instant ? INSTANT_EXIT : t.exit) as TargetAndTransition,
    }),
    [t],
  );
  // Les pages à en-tête teinté (album, artiste) jouent leur propre entrée (pas de fondu global).
  const initial = nav.shared || route.name === "album" || route.name === "artist" ? { opacity: 1, y: 0 } : t.initial;

  return (
    <AnimatePresence mode="popLayout" initial={false} custom={nav.instant}>
      <motion.div
        key={key}
        className={`route route--${route.name}`}
        initial={initial}
        animate={t.animate as TargetAndTransition}
        exit="exit"
        variants={variants}
        custom={nav.instant}
      >
        {/* Le contenu de la page ne retient jamais sa sortie : un élément `layoutId` démonté
            pendant que la page est présente (tuile virtualisée, pochette d'un album retiré de la
            bibliothèque) bloquerait sinon le démontage (cf. DetachedPresence). */}
        <DetachedPresence>
          <RoutePage route={route} scrollRef={scrollRef} actions={actions} />
        </DetachedPresence>
      </motion.div>
    </AnimatePresence>
  );
}

const INSTANT_EXIT = { opacity: 0, transition: { duration: 0 } };

/** Pages qui affichent des tuiles d'album (source / cible de la pochette partagée). */
const GRID_ROUTES: ReadonlySet<Route["name"]> = new Set(["home", "albums", "favorites", "search", "artist"]);

/**
 * Navigation grille → album (ou retour album → grille) : la pochette voyage ; grille Artistes →
 * page artiste (et retour) : l'avatar voyage.
 */
function isSharedPair(from: Route, to: Route): boolean {
  return (
    (GRID_ROUTES.has(from.name) && to.name === "album") ||
    (from.name === "album" && GRID_ROUTES.has(to.name)) ||
    (from.name === "artists" && to.name === "artist") ||
    (from.name === "artist" && to.name === "artists")
  );
}

function RoutePage({ route, scrollRef, actions }: PageProps): JSX.Element {
  switch (route.name) {
    case "home":
      return <HomePage scrollRef={scrollRef} actions={actions} />;
    case "tracks":
      return <TracksView scrollRef={scrollRef} actions={actions} />;
    case "albums":
      return <AlbumsView scrollRef={scrollRef} actions={actions} variant="albums" />;
    case "favorites":
      return <AlbumsView scrollRef={scrollRef} actions={actions} variant="favorites" />;
    case "album":
      return <AlbumView id={route.id} scrollRef={scrollRef} actions={actions} />;
    case "artists":
      return <ArtistsView scrollRef={scrollRef} actions={actions} />;
    case "artist":
      return <ArtistView name={route.artist} scrollRef={scrollRef} actions={actions} />;
    case "playlists":
      return (
        <>
          <PageHeader title="Playlists" sub="Crée, renomme et lis tes listes." />
          <PlaylistsPage onPlay={actions.playTracks} />
        </>
      );
    case "search":
      return <SearchPage scrollRef={scrollRef} actions={actions} />;
    default:
      return <UnderConstruction title={titleOf(route)} />;
  }
}

function titleOf(route: Route): string {
  switch (route.name) {
    case "playlist":
      return "Playlist";
    case "downloads":
      return "Téléchargements";
    case "settings":
      return "Réglages";
    default:
      return "Benten";
  }
}

function UnderConstruction({ title }: { title: string }): JSX.Element {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        icon={Construction}
        title="En construction"
        text="Cette page arrive avec la nouvelle interface de Benten."
      />
    </>
  );
}

// --- Pages ---------------------------------------------------------------------------------------

/** Ancienne vue Playlists + demande de création venue de la barre latérale (bouton +). */
function PlaylistsPage({ onPlay }: { onPlay: RouteViewActions["playTracks"] }): JSX.Element {
  const createRequested = useUi((s) => s.playlistCreateRequested);
  const consume = useCallback((): void => {
    uiStore.getState().consumePlaylistCreate();
  }, []);
  return (
    <Playlists onPlay={onPlay} createFocusRequested={createRequested} onCreateFocused={consume} />
  );
}

/**
 * Accueil provisoire (jusqu'à la Tâche 11) : la grille d'albums sous l'en-tête d'accueil, ou
 * l'écran de premier lancement (choix du dossier + scan) quand la bibliothèque est vide.
 */
function HomePage({ scrollRef, actions }: Omit<PageProps, "route">): JSX.Element {
  const loading = useLibrary((s) => s.loading);
  const albumCount = useLibrary((s) => s.albums.length);
  if (!loading && albumCount === 0) return <Onboarding />;
  return <AlbumsView scrollRef={scrollRef} actions={actions} variant="home" />;
}

/** Premier lancement / bibliothèque vide : choix du dossier + scan (ancien écran d'accueil). */
function Onboarding(): JSX.Element {
  const scanning = useLibrary((s) => s.scanning);
  const scanMsg = useLibrary((s) => s.scanMsg);
  const sources = useLibrary((s) => s.sources);
  const [scanPath, setScanPath] = useState("");

  const runScan = (pathArg?: string): Promise<void> =>
    libraryStore.getState().scan(pathArg ?? scanPath);
  const pickFolder = (): Promise<void> => libraryStore.getState().pickFolderAndScan(setScanPath);

  return (
    <section className="section">
      <div className="empty onboarding">
        <BentenMark size={72} />
        <h2>Aucune musique pour l'instant</h2>
        <p>
          Indique le dossier de ta bibliothèque locale pour l'indexer. Benten lit les fichiers sur
          place, hors-ligne.
        </p>
        <div className="scan-actions">
          <Button variant="primary" icon={FolderOpen} onClick={() => void pickFolder()} disabled={scanning}>
            {scanning ? "Analyse…" : "Choisir un dossier"}
          </Button>
        </div>
        <div className="scan-row">
          <input
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="… ou colle un chemin ici"
            spellCheck={false}
            disabled={scanning}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runScan();
            }}
          />
          <Button variant="ghost" onClick={() => void runScan()} disabled={scanning}>
            Scanner
          </Button>
        </div>
        {sources.length > 0 && (
          <div className="scan-sources">
            {sources.map((s) => (
              <button
                key={s.id}
                className="scan-hint"
                type="button"
                onClick={() => void runScan(s.path)}
                disabled={scanning}
                title={s.path}
              >
                {s.path}
              </button>
            ))}
          </div>
        )}
        {scanMsg && <div className="scan-note">{scanMsg}</div>}
      </div>
    </section>
  );
}

/** Recherche (ancienne vue de résultats, désormais rendue avec la grille d'albums de la Tâche 6). */
function SearchPage({ scrollRef, actions }: Omit<PageProps, "route">): JSX.Element {
  const query = useLibrary((s) => s.query);
  const results = useLibrary((s) => s.results);
  const searched = useLibrary((s) => s.searched);
  const menus = useViewMenus(actions);
  const q = query.trim();

  const onPlay = useCallback(
    (album: Album): void => {
      const p = playerStore.getState();
      if (p.currentTrack?.albumId === album.id && canResume(p.status)) actions.togglePlay();
      else actions.playAlbumInOrder(album);
    },
    [actions],
  );
  const onContextMenu = useCallback(
    (album: Album, e: React.MouseEvent<HTMLElement>): void => {
      void menus.openAlbumMenu(album, anchorFromEvent(e));
    },
    [menus],
  );

  return (
    <>
      <PageHeader title="Recherche" sub={q ? `Résultats pour « ${q} »` : null} />
      {q ? (
        <SearchResults
          tracks={results}
          query={query}
          searched={searched}
          scrollRef={scrollRef}
          onPlay={onPlay}
          onContextMenu={onContextMenu}
        />
      ) : (
        <EmptyState
          icon={Search}
          title="Que veux-tu écouter ?"
          text="Tape un titre, un artiste ou un album dans le champ de recherche."
        />
      )}
    </>
  );
}
