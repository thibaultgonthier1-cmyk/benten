import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme/tokens.css";
import { AudioEngine, qualitySampleRate } from "./audio/engine";
import { NativeDecoder } from "./audio/decoder";
import { AUDIO_LATENCY_HINT, createAudioContext } from "./audio/context";
import { createDiagnosticsSink, startAudioDiagnostics } from "./audio/diagnostics";
import { bindEngine, playerStore, usePlayer, type PlayerState } from "./state/player";
import { createControls } from "./components/controls";
import {
  DEFAULT_SORT_FILTER,
  groupTracksToAlbums,
  sortFilterAlbums,
  type Album,
  type AlbumSortFilter,
} from "./lib/library";
import { makeThrottle } from "./lib/throttle";
import { restoreState, serializeState } from "./lib/persist";
import type { QualityMode, SourceRow, TrackRow } from "../shared/types";
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

/** Clé `app_state` sous laquelle l'état de lecture est persisté. */
const PLAYER_STATE_KEY = "player";
/** Anti-rebond de la sauvegarde d'état (ms) : les changements structurels sont coalescés. */
const SAVE_DEBOUNCE_MS = 1000;
/** Throttle de sauvegarde de la position de lecture (ms) : on ne persiste pas chaque frame rAF. */
const SAVE_POSITION_THROTTLE_MS = 5000;

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

/**
 * L'entree `session` du journal audio n'est ecrite qu'UNE fois par processus renderer : sous
 * React.StrictMode (dev), l'effet moteur est monte/demonte/remonte et ecrirait sinon 2 sessions.
 */
let audioSessionLogged = false;

export function App(): JSX.Element {
  // UN SEUL moteur (AudioContext reel + NativeDecoder), cree une fois.
  const engineRef = useRef<AudioEngine>();
  if (!engineRef.current) {
    // `latencyHint: "playback"` (tampon de sortie plus robuste) : voir `createAudioContext`.
    const ctx = createAudioContext();
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
  // `true` seulement quand une recherche a abouti pour le terme courant : empeche le clignotement de
  // « aucun resultat » pendant l'anti-rebond, avant que la premiere reponse ne soit arrivee.
  const [searched, setSearched] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  // Racines persistées (Task 5) : proposées en raccourci de ré-indexation sur l'écran d'accueil,
  // en remplacement de l'ancienne bibliothèque codée en dur.
  const [sources, setSources] = useState<SourceRow[]>([]);
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
      // "playback" + frequence du mode ; frequence refusee par la plateforme : repli au defaut.
      const newCtx = createAudioContext(rate);
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
      (window as unknown as { __benten?: unknown }).__benten = {
        engine,
        store: playerStore,
        persist: { serializeState, restoreState },
      };
    }
    // Journal audio (diagnostic des micro-coupures, actif en PRODUCTION) : OBSERVE seulement le
    // contexte courant (getter : la reconstruction de qualite le remplace) et les transitions du
    // moteur ; n'appelle aucun mutateur, ne cree aucun noeud audio, ses erreurs restent chez lui.
    // Les entrees partent par lots vers le Main (au plus toutes les 2 s, immediatement sur glitch).
    const diagSink = createDiagnosticsSink({
      send: (entries) => window.benten?.diagnostics?.append(entries),
    });
    const diagnostics = startAudioDiagnostics({
      getContext: () => engine.getContext(),
      engine,
      append: diagSink.append,
      latencyHint: AUDIO_LATENCY_HINT,
      logSession: !audioSessionLogged,
      mediaDevices: typeof navigator !== "undefined" ? (navigator.mediaDevices ?? null) : null,
      win: window,
      doc: document,
    });
    audioSessionLogged = true;
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

    // --- Persistance de l'état (Task 14A) : sauvegarde debouncée + throttle de position. --------
    const persistNow = (): void => {
      const api = window.benten?.state;
      if (!api) return; // hors fenêtre (tests) : no-op.
      const s = playerStore.getState();
      const payload = JSON.stringify(
        serializeState({
          queue: s.queue,
          currentIndex: s.currentIndex,
          positionSec: s.positionSec,
          shuffle: s.shuffle,
          repeat: s.repeat,
          volume: s.volume,
          qualityMode: s.qualityMode,
          nowPlayingOpen: s.nowPlayingOpen,
        }),
      );
      void api.set(PLAYER_STATE_KEY, payload).catch(() => {
        /* best-effort : un échec d'écriture ne doit jamais casser la lecture */
      });
    };
    // Signature STRUCTURELLE : tout sauf la position (qui bouge en continu). Un changement ici
    // (file, index, shuffle, repeat, volume, qualité, vue, statut) planifie une sauvegarde
    // debouncée (≥1 s) ; un trailing debounce suffit car ces changements sont discrets, pas rAF.
    const structuralKey = (s: PlayerState): string =>
      [
        s.queue.map((t) => t.id).join(","),
        s.currentIndex,
        s.shuffle,
        s.repeat,
        s.volume,
        s.qualityMode,
        s.nowPlayingOpen,
        s.status,
      ].join("|");
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = structuralKey(playerStore.getState());
    const unsubscribeSave = playerStore.subscribe((s) => {
      const key = structuralKey(s);
      if (key === lastKey) return; // changement de position pure : ignoré ici (voir le throttle).
      lastKey = key;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        persistNow();
      }, SAVE_DEBOUNCE_MS);
    });
    // La position avance en continu en lecture : on la persiste à faible cadence (throttle), plutôt
    // qu'une écriture par frame — complète les sauvegardes sur pause / changement de piste ci-dessus.
    const positionSaver = setInterval(() => {
      if (playerStore.getState().status === "playing") persistNow();
    }, SAVE_POSITION_THROTTLE_MS);

    return () => {
      cancelAnimationFrame(raf);
      diagnostics.stop();
      diagSink.stop();
      unbind();
      unsubscribeSave();
      if (saveTimer) clearTimeout(saveTimer);
      clearInterval(positionSaver);
      persistNow(); // capture finale (best-effort) de la position au démontage
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

  // Racines persistées : chargées au démarrage et après chaque scan (une source peut s'ajouter).
  const refreshSources = useCallback(async (): Promise<void> => {
    try {
      setSources(await window.benten.sources.list());
    } catch {
      /* best-effort : l'absence de sources ne bloque pas l'écran d'accueil. */
    }
  }, []);

  // Reprise de l'état de lecture au lancement (Task 14A) — EN PAUSE, sans aucun son automatique.
  // Ne s'exécute qu'une fois. Applique d'abord les préférences scalaires (volume/aléatoire/
  // répétition/qualité/vue), puis re-résout les ids de file en `TrackRow` via la DB et charge la
  // piste courante en pause à la position mémorisée. File vide ou tous les ids disparus : démarrage
  // propre. (Démarrer une veille de dossiers sur les sources est la Task 14B — pas ici.)
  const restoredRef = useRef(false);
  const restorePlaybackState = useCallback(async (): Promise<void> => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let raw: string | undefined;
    try {
      raw = await window.benten.state.get(PLAYER_STATE_KEY);
    } catch {
      return;
    }
    if (!raw) return; // rien de sauvé : défauts propres.
    const restored = restoreState(raw);
    if (!restored) return; // état corrompu : défauts propres.

    const store = playerStore.getState();
    // Préférences scalaires : appliquées même si la file a disparu. `setShuffle`/`setRepeat`/
    // `setVolume` configurent aussi le moteur ; `qualityMode`/`nowPlayingOpen` ne sont posés que
    // dans le store (pas de recréation de contexte au lancement : on reste muet et sans course).
    store.setVolume(restored.volume);
    store.setShuffle(restored.shuffle);
    store.setRepeat(restored.repeat);
    playerStore.setState({
      qualityMode: restored.qualityMode,
      nowPlayingOpen: restored.nowPlayingOpen,
    });

    if (restored.queueTrackIds.length === 0) return;
    let tracks: TrackRow[] = [];
    try {
      tracks = await window.benten.library.tracksByIds(restored.queueTrackIds);
    } catch {
      return;
    }
    if (tracks.length === 0) return; // tous les ids disparus : file vide, démarrage propre.
    // Index courant re-mappé sur la file filtrée (des ids ont pu disparaître) : par identité si
    // possible, sinon borné à ce qui reste.
    const savedId = restored.queueTrackIds[restored.currentIndex];
    let index = savedId != null ? tracks.findIndex((t) => t.id === savedId) : -1;
    if (index < 0) index = Math.min(Math.max(restored.currentIndex, 0), tracks.length - 1);

    store.setQueue(tracks, index);
    // Reprise EN PAUSE à la position mémorisée : le moteur ne démarre AUCUNE source.
    await engine.restoreQueue(tracks, index, restored.positionSec);
  }, [engine]);

  useEffect(() => {
    void reload();
    // Amorce les favoris (ids) depuis la base : le cœur et le filtre favoris reflètent l'état persisté.
    void playerStore.getState().loadFavorites();
    // Charge les racines persistées (raccourcis de ré-indexation) et reprend l'état de lecture.
    void refreshSources();
    void restorePlaybackState();
  }, [reload, refreshSources, restorePlaybackState]);

  // Veille de dossiers (Task 14B) : à chaque lot de re-scan incrémental côté Main, on re-interroge
  // la DB pour rafraîchir la grille. CRUCIAL : on ne touche PAS au moteur/à la file — la lecture
  // continue sans interruption ; seule la liste d'albums est re-fetchée. Désabonnement au démontage.
  useEffect(() => {
    const api = window.benten?.onLibraryChanged;
    if (!api) return; // hors fenêtre (tests) : no-op.
    const unsubscribe = api(() => {
      void reload();
    });
    return unsubscribe;
  }, [reload]);

  // Recherche avec anti-rebond : terme vide -> on vide les resultats sans interroger. Un drapeau
  // `cancelled` ignore une reponse qui arrive apres un nouveau terme (course de frappe rapide).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      return;
    }
    // Nouveau terme : la recherche n'a pas encore abouti -> on masque la note « aucun resultat »
    // jusqu'a la reponse (pas de clignotement du vide pendant l'anti-rebond).
    setSearched(false);
    let cancelled = false;
    const id = setTimeout(() => {
      window.benten.library
        .search({ q, limit: SEARCH_LIMIT })
        .then((rows) => {
          if (!cancelled) {
            setResults(rows);
            setSearched(true);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearched(true);
          }
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
        // La racine scannée devient une source persistée : on rafraîchit la liste des raccourcis.
        try {
          setSources(await window.benten.sources.list());
        } catch {
          /* best-effort */
        }
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
