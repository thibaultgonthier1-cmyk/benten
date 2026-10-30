import { Suspense, lazy, useCallback, useEffect, useMemo } from "react";
import "./theme/tokens.css";
import { playerStore } from "./state/player";
import { libraryStore } from "./state/library";
import { startAudioRuntime, type AudioRuntime } from "./runtime/audioRuntime";
import { restorePlaybackState } from "./runtime/restore";
import type { Album } from "./lib/library";
import { Shell } from "./shell/Shell";
import type { RouteViewActions } from "./shell/RouteView";
import { MiniPlayer } from "./components/MiniPlayer";
import type { TrackRow } from "../shared/types";
import { Intro } from "./components/Intro";
import { CompactPlayer } from "./components/CompactPlayer";
import { configureSleepTimer } from "./runtime/sleepTimerHost";
import { applyEqualizer, bindEqualizer } from "./components/EqualizerPanel";
import { useUi } from "./state/ui";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";

/**
 * Vitrine DEV-ONLY des composants signature DA2 (`window.__benten.signature.show()`). Chargée
 * paresseusement derrière `import.meta.env.DEV` : absente du build de production.
 */
const SignatureShowcase = import.meta.env.DEV ? lazy(() => import("./dev/SignatureShowcase")) : null;

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

  // Lecture d'un album depuis les nouvelles vues (grille, page album, menus) : la lecture démarre
  // SUR PLACE, comme dans Apple Music / Spotify — l'écran de lecture ne s'ouvre plus d'office
  // (il reste à un clic, depuis le mini-lecteur).
  const playAlbum = useCallback(
    (album: Album, index = 0): void => {
      controls.playAlbum(album, index);
    },
    [controls],
  );

  // « Lecture » d'un album entier (en-tête, tuile, menu) : DANS L'ORDRE, comme Apple Music — le
  // mélange éventuel est coupé (action existante du store) AVANT de poser la file.
  const playAlbumInOrder = useCallback(
    (album: Album): void => {
      if (playerStore.getState().shuffle) playerStore.getState().setShuffle(false);
      controls.playAlbum(album, 0);
    },
    [controls],
  );

  // « Aléatoire total » (T17) : toute la bibliothèque, mélange activé, départ au hasard.
  const shuffleAll = useCallback(async (): Promise<void> => {
    const result = await window.benten.library.query({ view: "tracks", limit: 20000 });
    const tracks = result.rows as unknown as TrackRow[];
    if (tracks.length === 0) return;
    playerStore.getState().setShuffle(true);
    controls.playTracks(tracks, Math.floor(Math.random() * tracks.length));
  }, [controls]);
  // « Aléatoire » : active le mélange du moteur (action existante du store), puis lance l'album
  // depuis une piste tirée au hasard (elle devient la tête de l'ordre mélangé).
  const shuffleAlbum = useCallback(
    (album: Album): void => {
      if (album.tracks.length === 0) return;
      playerStore.getState().setShuffle(true);
      controls.playAlbum(album, Math.floor(Math.random() * album.tracks.length));
    },
    [controls],
  );

  const togglePlay = useCallback((): void => controls.toggle(), [controls]);

  // Actions des menus d'album (clic droit / « ⋯ »). Memoisees : les tuiles (`AlbumTile`) sont
  // `memo`, donc des callbacks stables evitent de re-rendre toute la grille virtualisee.
  const albumPlayNext = useCallback((album: Album): void => {
    playerStore.getState().playNext(album.tracks);
  }, []);
  const albumAddToQueue = useCallback((album: Album): void => {
    playerStore.getState().addToQueue(album.tracks);
  }, []);

  const views = useMemo<RouteViewActions>(
    () => ({
      playAlbum,
      playAlbumInOrder,
      shuffleAlbum,
      togglePlay,
      albumPlayNext,
      albumAddToQueue,
    }),
    [playAlbum, playAlbumInOrder, shuffleAlbum, togglePlay, albumPlayNext, albumAddToQueue],
  );

  // Minuteur de sommeil : fondu sur le nœud de volume du moteur, pause par le store, et
  // restauration du volume après la pause (sinon l'app se réveillerait muette).
  useEffect(() => {
    configureSleepTimer({
      fade: (to, seconds) => engine.rampVolume(to, seconds),
      pause: () => {
        if (playerStore.getState().status === "playing") controls.toggle();
      },
      getVolume: () => playerStore.getState().volume,
      setVolume: (v) => playerStore.getState().setVolume(v),
      // « Fin du titre » : le moteur émet `ended` au changement de piste — c'est le signal exact.
      onTrackEnd: (cb) => engine.on("ended", () => cb()),
    });
  }, [engine, controls]);

  // T17B : le moteur reçoit les gains de l'égaliseur (0 dB partout quand il est inactif).
  useEffect(() => {
    bindEqualizer(engine);
    applyEqualizer();
  }, [engine]);

  const compact = useUi((s) => s.compact);

  if (compact) {
    return (
      <>
        <Intro onDone={() => undefined} />
        <CompactPlayer controls={controls} />
      </>
    );
  }

  return (
    <>
      <Intro onDone={() => undefined} />
      <Shell views={views} controls={controls} player={<MiniPlayer controls={controls} />} />

      <NowPlaying controls={controls} />
      <QueuePanel />
      {SignatureShowcase && (
        <Suspense fallback={null}>
          <SignatureShowcase engine={engine} controls={controls} />
        </Suspense>
      )}
    </>
  );
}






