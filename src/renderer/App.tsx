import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme/tokens.css";
import { playerStore, usePlayer } from "./state/player";
import { libraryStore, useLibrary } from "./state/library";
import { startAudioRuntime, type AudioRuntime } from "./runtime/audioRuntime";
import { restorePlaybackState } from "./runtime/restore";
import {
  DEFAULT_SORT_FILTER,
  sortFilterAlbums,
  type Album,
  type AlbumSortFilter,
} from "./lib/library";
import type { TrackRow } from "../shared/types";
import { LibraryGrid } from "./components/LibraryGrid";
import { SortFilterBar } from "./components/SortFilterBar";
import { SearchResults } from "./components/SearchResults";
import { Playlists } from "./components/Playlists";
import { MiniPlayer } from "./components/MiniPlayer";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";
import { AddToPlaylistSheet } from "./components/AddToPlaylistSheet";

/**
 * Runtime audio de la page : demarre UNE SEULE fois (garde au niveau du module). Sous StrictMode,
 * React 18 re-monte les hooks lors du double rendu initial (un `useRef` seul ne suffirait pas a
 * empecher un second `AudioContext`) ; le runtime vit donc aussi longtemps que la page.
 */
let appRuntime: AudioRuntime | null = null;
const ensureAudioRuntime = (): AudioRuntime => (appRuntime ??= startAudioRuntime());

/**
 * HMR (dev uniquement ; `import.meta.hot` est absent en production). Une re-execution de ce module
 * remettrait la garde a zero et demarrerait un SECOND runtime (deux boucles tick(), deux
 * `AudioContext`, deux ecrivains de « player »). Le runtime vivant est donc transmis au nouveau
 * module via `hot.data` :
 *  - meme `startAudioRuntime` (seul App.tsx a change) : on le REPREND tel quel — la lecture
 *    continue, aucun contexte n'est cree ;
 *  - `audioRuntime.ts` (ou une de ses dependances, ex. le store) a ete recharge : l'ancien est
 *    dispose ET son contexte ferme AVANT que le nouveau ne soit cree au rendu suivant.
 */
interface HotRuntime {
  runtime: AudioRuntime;
  start: typeof startAudioRuntime;
}
const HOT_RUNTIME_KEY = "bentenAudioRuntime";
const carried = import.meta.hot?.data[HOT_RUNTIME_KEY] as HotRuntime | undefined;
if (carried) {
  if (carried.start === startAudioRuntime) appRuntime = carried.runtime;
  else carried.runtime.dispose({ closeContext: true });
}
import.meta.hot?.dispose((data) => {
  data[HOT_RUNTIME_KEY] = appRuntime
    ? ({ runtime: appRuntime, start: startAudioRuntime } satisfies HotRuntime)
    : undefined;
});

export function App(): JSX.Element {
  // UN SEUL moteur (AudioContext reel + NativeDecoder), cree une fois par le runtime audio. Lu a
  // chaque rendu (idempotent) plutot que fige dans un ref : apres un HMR qui remplace le runtime,
  // un ref preserve par Fast Refresh pointerait encore vers l'ancien moteur dispose.
  const { engine, controls } = ensureAudioRuntime();

  const albums = useLibrary((s) => s.albums);
  const loading = useLibrary((s) => s.loading);
  const query = useLibrary((s) => s.query);
  const results = useLibrary((s) => s.results);
  // `true` seulement quand une recherche a abouti pour le terme courant : empeche le clignotement de
  // « aucun resultat » pendant l'anti-rebond, avant que la premiere reponse ne soit arrivee.
  const searched = useLibrary((s) => s.searched);
  const scanning = useLibrary((s) => s.scanning);
  const scanMsg = useLibrary((s) => s.scanMsg);
  // Racines persistées (Task 5) : proposées en raccourci de ré-indexation sur l'écran d'accueil,
  // en remplacement de l'ancienne bibliothèque codée en dur.
  const sources = useLibrary((s) => s.sources);
  const setQuery = libraryStore.getState().setQuery;

  const [view, setView] = useState<"library" | "playlists">("library");
  const [sortFilter, setSortFilter] = useState<AlbumSortFilter>(DEFAULT_SORT_FILTER);
  const [scanPath, setScanPath] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  // Feuille « Ajouter à une playlist » : pistes a ajouter + libelle (titre d'album).
  const [plSheet, setPlSheet] = useState<{ open: boolean; trackIds: number[]; label?: string }>({
    open: false,
    trackIds: [],
  });

  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);
  const favoriteIds = usePlayer((s) => s.favoriteIds);

  useEffect(() => {
    const library = libraryStore.getState();
    void library.reload();
    // Amorce les favoris (ids) depuis la base : le cœur et le filtre favoris reflètent l'état persisté.
    void playerStore.getState().loadFavorites();
    // Charge les racines persistées (raccourcis de ré-indexation) et reprend l'état de lecture.
    void library.refreshSources();
    void restorePlaybackState(engine);
  }, [engine]);

  // Veille de dossiers (Task 14B) : seule la liste d'albums est re-fetchée (jamais le moteur).
  // Désabonnement au démontage.
  useEffect(() => libraryStore.getState().subscribeLibraryChanged(), []);

  const playAlbum = useCallback(
    (album: Album): void => {
      controls.playAlbum(album, 0);
      playerStore.getState().setNowPlayingOpen(true);
    },
    [controls],
  );

  // Lecture d'une playlist : on fabrique un album ephemere (id synthetique) a partir de ses pistes
  // et on reutilise exactement le chemin de file de `playAlbum` (store.setQueue + engine.setQueue).
  const playTracks = useCallback(
    (tracks: readonly TrackRow[], index = 0): void => {
      if (tracks.length === 0) return;
      const pseudo: Album = {
        id: -1,
        title: "Playlist",
        artist: "",
        artKey: tracks.find((t) => t.artKey)?.artKey ?? null,
        tracks,
      };
      controls.playAlbum(pseudo, index);
      playerStore.getState().setNowPlayingOpen(true);
    },
    [controls],
  );

  // Actions du menu « ⋯ » des cartes d'album (Task 11 / Task 10 replie). Memoisees : AlbumCard est
  // `memo`, donc des callbacks stables evitent de re-rendre toute la grille virtualisee.
  const albumPlayNext = useCallback((album: Album): void => {
    playerStore.getState().playNext(album.tracks);
  }, []);
  const albumAddToQueue = useCallback((album: Album): void => {
    playerStore.getState().addToQueue(album.tracks);
  }, []);
  const albumAddToPlaylist = useCallback((album: Album): void => {
    setPlSheet({ open: true, trackIds: album.tracks.map((t) => t.id), label: album.title });
  }, []);
  const closePlSheet = useCallback((): void => {
    setPlSheet((s) => ({ ...s, open: false }));
  }, []);

  // Indexation : chemin explicite (raccourci de source) ou champ de saisie.
  const runScan = useCallback(
    (pathArg?: string): Promise<void> => libraryStore.getState().scan(pathArg ?? scanPath),
    [scanPath],
  );

  // Selecteur de dossier natif (process Main) : chemin propose plutot que saisi a la main.
  const pickFolder = useCallback(
    (): Promise<void> => libraryStore.getState().pickFolderAndScan(setScanPath),
    [],
  );

  // Tri + filtres appliqués côté vue (la SortFilterBar pilote la liste affichée). Même liste
  // blanche que le repository `getAlbums` ; voir `sortFilterAlbums`.
  const shownAlbums = useMemo(
    () => sortFilterAlbums(albums, sortFilter, favoriteIds),
    [albums, sortFilter, favoriteIds],
  );

  const empty = !loading && albums.length === 0;
  const searching = query.trim().length > 0;

  return (
    <>
      <div className="ambient" aria-hidden="true">
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />
        <div className="seigaiha" />
      </div>

      <div id="app">
        <nav className="nav">
          <div className="brand">
            <div className="mark">弁</div>
            <div>
              <b>Benten</b>
              <small>lecture locale</small>
            </div>
          </div>
          <button
            className={"nav-item" + (view === "library" && !sortFilter.favoritesOnly ? " active" : "")}
            type="button"
            aria-current={view === "library" && !sortFilter.favoritesOnly ? "page" : undefined}
            onClick={() => {
              setView("library");
              setSortFilter((sf) => ({ ...sf, favoritesOnly: false }));
            }}
          >
            <svg viewBox="0 0 24 24">
              <path d="M3 11l9-8 9 8" />
              <path d="M5 10v10h14V10" />
            </svg>
            Accueil <span className="kanji">家</span>
          </button>
          <div className="nav-group">Ma bibliotheque</div>
          <button
            className={"nav-item" + (view === "library" && sortFilter.favoritesOnly ? " active" : "")}
            type="button"
            aria-current={view === "library" && sortFilter.favoritesOnly ? "page" : undefined}
            onClick={() => {
              setView("library");
              setSortFilter((sf) => ({ ...sf, favoritesOnly: true }));
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20.5l-1.3-1.2C5.4 14.5 2.5 11.9 2.5 8.6 2.5 6.2 4.4 4.3 6.8 4.3c1.4 0 2.7.65 3.6 1.7l1.6 1.9 1.6-1.9c.9-1.05 2.2-1.7 3.6-1.7 2.4 0 4.3 1.9 4.3 4.3 0 3.3-2.9 5.9-8.2 10.7L12 20.5z" />
            </svg>
            Favoris <span className="kanji">好</span>
          </button>
          <button
            className={"nav-item" + (view === "playlists" ? " active" : "")}
            type="button"
            aria-current={view === "playlists" ? "page" : undefined}
            onClick={() => setView("playlists")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h12" />
              <path d="M4 12h12" />
              <path d="M4 17h8" />
              <circle cx="19" cy="16" r="2.4" />
              <path d="M21.4 16V8.5l-3.4 1" />
            </svg>
            Playlists <span className="kanji">曲</span>
          </button>
        </nav>

        <main className="main" ref={mainRef}>
          <div className="topbar">
            <label className="search">
              <svg viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4-4" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Recherche"
                aria-label="Recherche"
                spellCheck={false}
                type="search"
              />
            </label>
            <div className="top-actions">
              <span className="chip">
                <span className="dot" />
                {albums.length} albums
              </span>
            </div>
          </div>

          <header className="hero">
            <div className="jp">今宵 · ce soir</div>
            <h1>Ta bibliotheque, lue en local</h1>
            <p>
              Chaque fichier est analyse pour afficher sa vraie qualite. Clique un album pour lancer
              la lecture gapless.
            </p>
          </header>

          {view === "playlists" ? (
            <Playlists onPlay={playTracks} />
          ) : searching ? (
            <SearchResults
              tracks={results}
              query={query}
              searched={searched}
              scrollRef={mainRef}
              playingAlbumId={currentAlbumId}
              onPlay={playAlbum}
            />
          ) : empty ? (
            <section className="section">
              <div className="empty">
                <div className="mark">弁</div>
                <h2>Aucune musique pour l'instant</h2>
                <p>
                  Indique le dossier de ta bibliotheque locale pour l'indexer. Benten lit les
                  fichiers sur place, hors-ligne.
                </p>
                <div className="scan-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void pickFolder()}
                    disabled={scanning}
                  >
                    {scanning ? "Analyse…" : "Choisir un dossier"}
                  </button>
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
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => void runScan()}
                    disabled={scanning}
                  >
                    Scanner
                  </button>
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
          ) : (
            <section className="section">
              <div className="section-head">
                <h2>{sortFilter.favoritesOnly ? "Favoris" : "Albums"}</h2>
                <SortFilterBar value={sortFilter} onChange={setSortFilter} />
                <span className="count">
                  {loading ? "chargement…" : `${shownAlbums.length} albums`}
                </span>
              </div>
              <LibraryGrid
                albums={shownAlbums}
                scrollRef={mainRef}
                playingAlbumId={currentAlbumId}
                onPlay={playAlbum}
                onPlayNext={albumPlayNext}
                onAddToQueue={albumAddToQueue}
                onAddToPlaylist={albumAddToPlaylist}
              />
            </section>
          )}
        </main>

        <MiniPlayer controls={controls} />
      </div>

      <NowPlaying controls={controls} />
      <QueuePanel />
      <AddToPlaylistSheet
        open={plSheet.open}
        onClose={closePlSheet}
        trackIds={plSheet.trackIds}
        label={plSheet.label}
      />
    </>
  );
}
