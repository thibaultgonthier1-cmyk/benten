import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme/tokens.css";
import { AudioEngine, qualitySampleRate } from "./audio/engine";
import { NativeDecoder } from "./audio/decoder";
import { bindEngine, playerStore, usePlayer } from "./state/player";
import { createControls } from "./components/controls";
import {
  DEFAULT_SORT_FILTER,
  groupTracksToAlbums,
  sortFilterAlbums,
  type Album,
  type AlbumSortFilter,
} from "./lib/library";
import { makeThrottle } from "./lib/throttle";
import type { QualityMode, TrackRow } from "../shared/types";
import { LibraryGrid } from "./components/LibraryGrid";
import { SortFilterBar } from "./components/SortFilterBar";
import { SearchResults } from "./components/SearchResults";
import { Playlists } from "./components/Playlists";
import { MiniPlayer } from "./components/MiniPlayer";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";
import { AddToPlaylistSheet } from "./components/AddToPlaylistSheet";

const PAGE = 1000;
/** Nombre max de pistes renvoyees par une recherche (regroupees ensuite en albums). */
const SEARCH_LIMIT = 200;
/** Anti-rebond de la barre de recherche (ms) : une frappe rapide ne lance qu'une requete. */
const SEARCH_DEBOUNCE_MS = 150;

/** Bibliotheque locale connue : proposee en raccourci sur l'ecran d'accueil. */
const KNOWN_LIBRARY = "C:\\Users\\Dream\\Downloads\\REA DS\\.prism-profile\\documents\\Prism Library";

/** Charge TOUTES les pistes (pagine) puis les regroupe en albums. */
async function fetchAllAlbums(): Promise<Album[]> {
  const all: TrackRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await window.benten.library.query({ view: "tracks", limit: PAGE, offset });
    const rows = res.rows as TrackRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return groupTracksToAlbums(all);
}

export function App(): JSX.Element {
  // UN SEUL moteur (AudioContext reel + NativeDecoder), cree une fois.
  const engineRef = useRef<AudioEngine>();
  if (!engineRef.current) {
    const ctx = new AudioContext();
    engineRef.current = new AudioEngine(ctx, new NativeDecoder(ctx));
  }
  const engine = engineRef.current!;
  const controls = useMemo(() => createControls(engine, playerStore), [engine]);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [view, setView] = useState<"library" | "playlists">("library");
  const [sortFilter, setSortFilter] = useState<AlbumSortFilter>(DEFAULT_SORT_FILTER);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrackRow[]>([]);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Feuille « Ajouter à une playlist » : pistes a ajouter + libelle (titre d'album).
  const [plSheet, setPlSheet] = useState<{ open: boolean; trackIds: number[]; label?: string }>({
    open: false,
    trackIds: [],
  });

  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);
  const favoriteIds = usePlayer((s) => s.favoriteIds);

  // Branche le store sur le moteur + boucle rAF (pompe tick() et anime la position).
  useEffect(() => {
    const unbind = bindEngine(playerStore, engine);
    // Rattache le moteur au store pour les mutations de file A CHAUD (updateQueue / jumpTo).
    playerStore.getState().attachEngine(engine);

    // Recreation PROPRE du contexte au changement de mode (Task 13). L'App est la SEULE a creer un
    // `AudioContext` : le store appelle ce gestionnaire, qui fabrique le nouveau contexte a la
    // frequence du mode, demande au moteur de reconstruire son graphe dessus (hors-lecture, en
    // pause, sans clic), PUIS ferme l'ANCIEN contexte — il n'y a donc jamais plus d'UN contexte
    // vivant. L'instance du moteur ne change pas : `window.__benten.engine` reste valide.
    const rebuildForQuality = async (mode: QualityMode): Promise<void> => {
      const oldCtx = engine.getContext();
      const rate = qualitySampleRate(mode, oldCtx.sampleRate);
      let newCtx: AudioContext;
      try {
        newCtx = new AudioContext({ sampleRate: rate });
      } catch {
        newCtx = new AudioContext(); // frequence refusee par la plateforme : repli au defaut
      }
      await engine.rebuildContext(newCtx, new NativeDecoder(newCtx));
      if (oldCtx !== newCtx) {
        void oldCtx.close?.(); // un seul contexte vivant : l'ancien est ferme (pas de fuite)
      }
    };
    playerStore.getState().attachQualityRebuild((mode) => {
      void rebuildForQuality(mode);
    });
    // Pont de verification DEV-ONLY : expose le VRAI moteur + le store pour piloter/observer le
    // gapless/shuffle/repeat via CDP (Runtime.evaluate). `import.meta.env.DEV` est `false` dans un
    // build de production -> ce pont n'est JAMAIS attache en prod. Nettoye au demontage.
    if (import.meta.env.DEV) {
      (window as unknown as { __benten?: unknown }).__benten = { engine, store: playerStore };
    }
    let raf = 0;
    // La boucle rAF tourne a la frequence ecran (~60 Hz) mais on ne pompe tick()+setPosition qu'a
    // ~15 Hz (66 ms) via une porte pure pilotee par le timestamp rAF : PRELOAD_LEAD_SEC = 10 s dans
    // le moteur, donc 15 Hz suffit largement aux decisions de preload gapless, sans reveiller React
    // 60x/s. Un seul AudioContext, une seule boucle tick() : on ne change QUE la cadence.
    const gate = makeThrottle(66);
    const loop = (ts: number): void => {
      if (gate(ts)) {
        engine.tick();
        const st = engine.getState();
        if (st.status === "playing") playerStore.getState().setPosition(st.positionSec, st.durationSec);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unbind();
      playerStore.getState().attachEngine(null);
      playerStore.getState().attachQualityRebuild(null);
      if (import.meta.env.DEV) {
        delete (window as unknown as { __benten?: unknown }).__benten;
      }
    };
  }, [engine]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setAlbums(await fetchAllAlbums());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Amorce les favoris (ids) depuis la base : le cœur et le filtre favoris reflètent l'état persisté.
    void playerStore.getState().loadFavorites();
  }, [reload]);

  // Recherche avec anti-rebond : terme vide -> on vide les resultats sans interroger. Un drapeau
  // `cancelled` ignore une reponse qui arrive apres un nouveau terme (course de frappe rapide).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      window.benten.library
        .search({ q, limit: SEARCH_LIMIT })
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

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

  const runScan = useCallback(
    async (pathArg?: string): Promise<void> => {
      const path = (pathArg ?? scanPath).trim();
      if (!path || scanning) return;
      setScanning(true);
      setScanMsg("Analyse en cours…");
      try {
        const summary = await window.benten.library.scan([path]);
        setScanMsg(`Indexation : ${summary.added} ajoutes, ${summary.skipped} ignores.`);
        await reload();
      } catch (err) {
        setScanMsg(`Echec : ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setScanning(false);
      }
    },
    [scanPath, scanning, reload],
  );

  // Selecteur de dossier natif (process Main) : chemin propose plutot que saisi a la main.
  const pickFolder = useCallback(async (): Promise<void> => {
    if (scanning) return;
    try {
      const path = await window.benten.dialog.pickFolder();
      if (path) {
        setScanPath(path);
        await runScan(path);
      }
    } catch (err) {
      setScanMsg(`Echec : ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [scanning, runScan]);

  // Raccourci : pre-remplit et indexe la bibliotheque locale connue.
  const useKnownLibrary = useCallback((): void => {
    if (scanning) return;
    setScanPath(KNOWN_LIBRARY);
    void runScan(KNOWN_LIBRARY);
  }, [scanning, runScan]);

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
                <button
                  className="scan-hint"
                  type="button"
                  onClick={useKnownLibrary}
                  disabled={scanning}
                >
                  utiliser ma bibliotheque
                </button>
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
