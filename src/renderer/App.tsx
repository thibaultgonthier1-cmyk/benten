import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme/tokens.css";
import { AudioEngine } from "./audio/engine";
import { NativeDecoder } from "./audio/decoder";
import { bindEngine, playerStore, usePlayer } from "./state/player";
import { createControls } from "./components/controls";
import { groupTracksToAlbums, type Album } from "./lib/library";
import { makeThrottle } from "./lib/throttle";
import type { TrackRow } from "../shared/types";
import { LibraryGrid } from "./components/LibraryGrid";
import { SearchResults } from "./components/SearchResults";
import { MiniPlayer } from "./components/MiniPlayer";
import { NowPlaying } from "./components/NowPlaying";

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
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrackRow[]>([]);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);

  // Branche le store sur le moteur + boucle rAF (pompe tick() et anime la position).
  useEffect(() => {
    const unbind = bindEngine(playerStore, engine);
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
          <button className="nav-item active" type="button">
            <svg viewBox="0 0 24 24">
              <path d="M3 11l9-8 9 8" />
              <path d="M5 10v10h14V10" />
            </svg>
            Accueil <span className="kanji">家</span>
          </button>
          <div className="nav-group">Ma bibliotheque</div>
          <button className="nav-item soon-item" type="button" disabled aria-disabled="true">
            <svg viewBox="0 0 24 24">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            Albums <span className="soon">bientot</span>
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

          {searching ? (
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
                <h2>Albums</h2>
                <span className="count">{loading ? "chargement…" : `${albums.length} albums`}</span>
              </div>
              <LibraryGrid
                albums={albums}
                scrollRef={mainRef}
                playingAlbumId={currentAlbumId}
                onPlay={playAlbum}
              />
            </section>
          )}
        </main>

        <MiniPlayer controls={controls} />
      </div>

      <NowPlaying controls={controls} />
    </>
  );
}
