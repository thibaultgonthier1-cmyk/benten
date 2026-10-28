import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { AudioEngine, PlaybackState, PlaybackStatus } from "../audio/engine";
import type { TrackRow } from "../../shared/types";

/**
 * Etat de lecture pour l'UI (store Zustand), DERIVE des evenements du moteur.
 *
 * Le moteur (`AudioEngine`) reste la source de verite du son : le store ne declenche jamais de
 * lecture tout seul. Les actions `setQueue`/`next`/`prev` posent un etat OPTIMISTE (reponse UI
 * immediate) ; `applyEngineState` (branche sur `statechange`) reconcilie ensuite `currentIndex`
 * et `currentTrack` a partir du `trackId` reellement joue — indispensable pour l'enchainement
 * gapless, ou c'est le moteur qui fait avancer la file. `setPosition` est appele par la boucle
 * requestAnimationFrame (qui pompe aussi `engine.tick()`) pour animer la barre de progression.
 *
 * La logique est volontairement pure et sans React : `createPlayerStore()` cree un store vanilla
 * testable hors composant ; `usePlayer` l'adapte en hook pour les composants.
 */
export interface PlayerState {
  /** File d'attente courante (pistes d'un album, en general). */
  queue: readonly TrackRow[];
  /** Index de la piste courante dans `queue` (−1 si aucune). */
  currentIndex: number;
  /** Piste courante, `null` si aucune. */
  currentTrack: TrackRow | null;
  /** Statut de transport refflete depuis le moteur. */
  status: PlaybackStatus;
  /** Position de lecture (s). */
  positionSec: number;
  /** Duree de la piste courante (s). */
  durationSec: number;
  /** Vue « lecture plein ecran » ouverte. */
  nowPlayingOpen: boolean;

  // --- Actions (pures) ------------------------------------------------------------------------
  /** Fixe la file et la piste courante (etat optimiste ; le moteur confirmera via statechange). */
  setQueue(tracks: readonly TrackRow[], index?: number): void;
  /** Avance d'une piste (borne a la fin de file). */
  next(): void;
  /** Recule d'une piste (borne au debut de file). */
  prev(): void;
  /** Positionne `currentIndex`/`currentTrack` sur un index donne. */
  selectIndex(index: number): void;
  /** Met a jour position (et duree si fournie) — boucle rAF. */
  setPosition(positionSec: number, durationSec?: number): void;
  /** Reconcilie l'etat depuis un `PlaybackState` du moteur (handler de statechange). */
  applyEngineState(state: PlaybackState): void;
  /** Ouvre/ferme la vue lecture. */
  setNowPlayingOpen(open: boolean): void;
}

const clampIndex = (i: number, len: number): number =>
  len === 0 ? -1 : Math.min(Math.max(Math.floor(i), 0), len - 1);

export type PlayerStore = StoreApi<PlayerState>;

/** Cree un store de lecture independant (isole, pour tests ou multi-instances). */
export function createPlayerStore(): PlayerStore {
  return createStore<PlayerState>((set, get) => ({
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    status: "idle",
    positionSec: 0,
    durationSec: 0,
    nowPlayingOpen: false,

    setQueue(tracks, index = 0) {
      const queue = tracks.slice();
      const currentIndex = clampIndex(index, queue.length);
      set({
        queue,
        currentIndex,
        currentTrack: currentIndex >= 0 ? (queue[currentIndex] ?? null) : null,
        positionSec: 0,
        durationSec: currentIndex >= 0 ? (queue[currentIndex]?.durationSec ?? 0) : 0,
      });
    },

    next() {
      get().selectIndex(get().currentIndex + 1);
    },

    prev() {
      get().selectIndex(get().currentIndex - 1);
    },

    selectIndex(index) {
      const { queue } = get();
      const currentIndex = clampIndex(index, queue.length);
      if (currentIndex < 0) return;
      set({
        currentIndex,
        currentTrack: queue[currentIndex] ?? null,
        positionSec: 0,
        durationSec: queue[currentIndex]?.durationSec ?? 0,
      });
    },

    setPosition(positionSec, durationSec) {
      set(
        durationSec === undefined
          ? { positionSec }
          : { positionSec, durationSec },
      );
    },

    applyEngineState(state) {
      const { queue, currentIndex } = get();
      // Reconcilie l'index depuis le trackId reellement joue (promotion gapless, saut d'une
      // piste non lisible, etc.). On ne change l'index que si le moteur pointe une autre piste.
      let nextIndex = currentIndex;
      let nextTrack = get().currentTrack;
      if (state.trackId != null) {
        const found = queue.findIndex((t) => t.id === state.trackId);
        if (found >= 0) {
          nextIndex = found;
          nextTrack = queue[found] ?? nextTrack;
        }
      }
      set({
        status: state.status,
        positionSec: state.positionSec,
        durationSec: state.durationSec || nextTrack?.durationSec || 0,
        currentIndex: nextIndex,
        currentTrack: nextTrack,
      });
    },

    setNowPlayingOpen(open) {
      set({ nowPlayingOpen: open });
    },
  }));
}

/** Abonnement minimal au moteur, suffisant pour les tests. */
type EngineLike = Pick<AudioEngine, "on">;

/**
 * Branche un store sur un moteur : chaque `statechange` est reconcilie dans le store. Renvoie la
 * fonction de desabonnement. (La boucle rAF, cote composant, pousse la position en continu.)
 */
export function bindEngine(store: PlayerStore, engine: EngineLike): () => void {
  const off = engine.on("statechange", (state) => {
    store.getState().applyEngineState(state);
  });
  return off;
}

/** Store singleton de l'application. */
export const playerStore: PlayerStore = createPlayerStore();

/** Hook React selecteur sur le store singleton. */
export function usePlayer<T>(selector: (state: PlayerState) => T): T {
  return useStore(playerStore, selector);
}
