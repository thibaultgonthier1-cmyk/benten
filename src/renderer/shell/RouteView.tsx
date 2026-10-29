import { useCallback, useMemo, useState, type RefObject } from "react";
import { AnimatePresence, motion, type TargetAndTransition } from "framer-motion";
import { Construction, FolderOpen, Heart, Search, type LucideIcon } from "lucide-react";
import { routeKey, uiStore, useUi, type Route } from "../state/ui";
import { libraryStore, useLibrary } from "../state/library";
import { usePlayer } from "../state/player";
import { pageTransition } from "../theme/ds/motion";
import { sortFilterAlbums, type Album, type AlbumSortFilter } from "../lib/library";
import type { TrackRow } from "../../shared/types";
import { LibraryGrid } from "../components/LibraryGrid";
import { SortFilterBar } from "../components/SortFilterBar";
import { SearchResults } from "../components/SearchResults";
import { Playlists } from "../components/Playlists";
import { BentenMark } from "../ui/BentenMark";
import { Button } from "../ui/Button";
import { ICON_STROKE } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { useMotion } from "../ui/useMotion";

/** Actions de lecture / bibliothèque fournies par l'App (chemins de lecture inchangés). */
export interface RouteViewActions {
  playAlbum(album: Album): void;
  playTracks(tracks: readonly TrackRow[], index?: number): void;
  albumPlayNext(album: Album): void;
  albumAddToQueue(album: Album): void;
  albumAddToPlaylist(album: Album): void;
  /** Tri/filtres de la grille d'albums (hors « favoris », porté par la route). */
  sortFilter: AlbumSortFilter;
  setSortFilter(next: AlbumSortFilter): void;
}

interface PageProps {
  route: Route;
  scrollRef: RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/**
 * Rend la page de la route courante avec une transition animée (`AnimatePresence`) : la page
 * entrante monte de 8 px en fondu, la sortante s'efface ; durées via `motionFor` (réglage
 * d'intensité + préférence système). Le défilement revient en haut à chaque changement de page.
 *
 * Mapping TEMPORAIRE (Tâche 3) vers les anciennes vues tant que les nouveaux écrans n'existent pas :
 * home / albums / favorites → grille (`LibraryGrid` + `SortFilterBar`), playlists → `Playlists`,
 * search → `SearchResults` ; les autres routes → état vide neutre « En construction ».
 */
export function RouteView({ scrollRef, actions }: Omit<PageProps, "route">): JSX.Element {
  const route = useUi((s) => s.route);
  const m = useMotion();
  const t = pageTransition(m);
  const resetScroll = useCallback((): void => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollRef]);

  return (
    <AnimatePresence mode="wait" initial={false} onExitComplete={resetScroll}>
      <motion.div
        key={routeKey(route)}
        className={`route route--${route.name}`}
        initial={t.initial}
        animate={t.animate as TargetAndTransition}
        exit={t.exit as TargetAndTransition}
      >
        <RoutePage route={route} scrollRef={scrollRef} actions={actions} />
      </motion.div>
    </AnimatePresence>
  );
}

function RoutePage({ route, scrollRef, actions }: PageProps): JSX.Element {
  switch (route.name) {
    case "home":
      return <HomePage scrollRef={scrollRef} actions={actions} />;
    case "albums":
      return (
        <>
          <AlbumsHeader title="Albums" />
          <AlbumsSection scrollRef={scrollRef} actions={actions} favoritesOnly={false} />
        </>
      );
    case "favorites":
      return (
        <>
          <AlbumsHeader title="Favoris" favoritesOnly />
          <AlbumsSection scrollRef={scrollRef} actions={actions} favoritesOnly />
        </>
      );
    case "playlists":
      return (
        <>
          <PageHeader title="Playlists" sub="Crée, renomme et lis tes listes." />
          <Playlists onPlay={actions.playTracks} />
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
    case "tracks":
      return "Titres";
    case "album":
      return "Album";
    case "artists":
      return "Artistes";
    case "artist":
      return route.artist;
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

// --- Briques de page ---------------------------------------------------------------------------

function PageHeader({
  eyebrow,
  title,
  sub,
}: {
  eyebrow?: string;
  title: string;
  sub?: string | null;
}): JSX.Element {
  return (
    <header className="page-head">
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      <h1 className="page-title">{title}</h1>
      {sub ? <p className="page-sub num">{sub}</p> : null}
    </header>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}): JSX.Element {
  return (
    <div className="page-empty">
      <span className="page-empty-icon" aria-hidden="true">
        <Icon size={24} strokeWidth={ICON_STROKE} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
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

/** Grille de chargement : des pochettes fantômes au rythme de la vraie grille. */
function GridSkeleton({ count = 12 }: { count?: number }): JSX.Element {
  return (
    <div className="grid-skel" aria-busy="true" aria-label="Chargement">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid-skel-card">
          <div className="grid-skel-art">
            <Skeleton h="100%" radius={16} />
          </div>
          <Skeleton w="72%" h={12} radius={6} />
          <Skeleton w="46%" h={10} radius={5} />
        </div>
      ))}
    </div>
  );
}

// --- Pages (mapping temporaire vers les anciennes vues) ----------------------------------------

function AlbumsHeader({ title, favoritesOnly = false }: { title: string; favoritesOnly?: boolean }): JSX.Element {
  const loading = useLibrary((s) => s.loading);
  const count = useLibrary((s) => s.albums.length);
  const favCount = usePlayer((s) => s.favoriteIds.size);
  const sub = loading ? null : favoritesOnly ? `${favCount} titres favoris` : `${count} albums`;
  return <PageHeader title={title} sub={sub} />;
}

function AlbumsSection({
  scrollRef,
  actions,
  favoritesOnly,
  heading,
}: Omit<PageProps, "route"> & { favoritesOnly: boolean; heading?: string }): JSX.Element {
  const albums = useLibrary((s) => s.albums);
  const loading = useLibrary((s) => s.loading);
  const favoriteIds = usePlayer((s) => s.favoriteIds);
  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);
  const { sortFilter, setSortFilter } = actions;

  const value = useMemo<AlbumSortFilter>(
    () => ({ ...sortFilter, favoritesOnly }),
    [sortFilter, favoritesOnly],
  );
  const shown = useMemo(
    () => sortFilterAlbums(albums, value, favoriteIds),
    [albums, value, favoriteIds],
  );

  // Le filtre « Favoris » de la barre est porté par la route : le basculer navigue.
  const onChange = useCallback(
    (next: AlbumSortFilter): void => {
      setSortFilter({ ...next, favoritesOnly: false });
      if (next.favoritesOnly !== favoritesOnly) {
        uiStore.getState().navigate(next.favoritesOnly ? { name: "favorites" } : { name: "albums" });
      }
    },
    [setSortFilter, favoritesOnly],
  );

  return (
    <section className="section">
      <div className="section-head">
        {heading && <h2>{heading}</h2>}
        <SortFilterBar value={value} onChange={onChange} />
        <span className="count num">{loading ? "chargement…" : `${shown.length} albums`}</span>
      </div>
      {loading && albums.length === 0 ? (
        <GridSkeleton />
      ) : favoritesOnly && shown.length === 0 ? (
        <EmptyState
          icon={Heart}
          title="Aucun favori"
          text="Touche le cœur d'un titre pendant la lecture pour le retrouver ici."
        />
      ) : (
        <LibraryGrid
          albums={shown}
          scrollRef={scrollRef}
          playingAlbumId={currentAlbumId}
          onPlay={actions.playAlbum}
          onPlayNext={actions.albumPlayNext}
          onAddToQueue={actions.albumAddToQueue}
          onAddToPlaylist={actions.albumAddToPlaylist}
        />
      )}
    </section>
  );
}

function HomePage({ scrollRef, actions }: Omit<PageProps, "route">): JSX.Element {
  const loading = useLibrary((s) => s.loading);
  const albumCount = useLibrary((s) => s.albums.length);
  const trackCount = useLibrary((s) => s.tracks.length);

  if (!loading && albumCount === 0) return <Onboarding />;
  return (
    <>
      <PageHeader
        eyebrow="今宵 · ce soir"
        title="Ta bibliothèque, en local"
        sub={loading ? null : `${trackCount} titres · ${albumCount} albums`}
      />
      <AlbumsSection scrollRef={scrollRef} actions={actions} favoritesOnly={false} heading="Albums" />
    </>
  );
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

function SearchPage({ scrollRef, actions }: Omit<PageProps, "route">): JSX.Element {
  const query = useLibrary((s) => s.query);
  const results = useLibrary((s) => s.results);
  const searched = useLibrary((s) => s.searched);
  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);
  const q = query.trim();

  return (
    <>
      <PageHeader title="Recherche" sub={q ? `Résultats pour « ${q} »` : null} />
      {q ? (
        <SearchResults
          tracks={results}
          query={query}
          searched={searched}
          scrollRef={scrollRef}
          playingAlbumId={currentAlbumId}
          onPlay={actions.playAlbum}
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
