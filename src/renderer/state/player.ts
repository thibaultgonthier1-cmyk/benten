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
/**
 * Sous-ensemble du moteur dont le store a besoin pour piloter la file A CHAUD (Task 11). Branche
 * via `attachEngine` (App) ; absent en tests node, ou les mutations restent de pures operations de
 * liste (le moteur est alors stube ou simplement non rattache).
 */
export interface QueueEngineApi {
  /** Mutation de file sans couper la courante (editions futures). */
  updateQueue(tracks: readonly TrackRow[], opts?: { keepCurrent?: boolean }): void;
  /** Saut manuel vers un index (chemin anti-clic). */
  jumpTo(index: number): void | Promise<void>;
}

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
  /** Panneau « file d'attente » ouvert. */
  queueOpen: boolean;
  /** Ensemble des ids de pistes favorites — source de verite UI pour le rendu instantane du cœur. */
  favoriteIds: ReadonlySet<number>;

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
  /** Ouvre/ferme le panneau de file d'attente. */
  setQueueOpen(open: boolean): void;

  // --- Mutations de file A CHAUD (Task 11) ----------------------------------------------------
  /** Rattache le moteur (pilotage de file). `null` detache (nettoyage). */
  attachEngine(engine: QueueEngineApi | null): void;
  /** Insere des pistes juste apres la courante (la courante ne bouge pas). */
  playNext(tracks: readonly TrackRow[]): void;
  /** Ajoute des pistes en fin de file. */
  addToQueue(tracks: readonly TrackRow[]): void;
  /** Retire la piste a `index` (recale la courante si besoin, la preserve si possible). */
  removeFromQueue(index: number): void;
  /** Deplace la piste de `from` vers `to` (la courante est preservee par identite). */
  moveInQueue(from: number, to: number): void;
  /** Saute a la piste `index` (saut anti-clic via le moteur). */
  jumpTo(index: number): void;
  /**
   * Bascule l'appartenance de `trackId` a `favoriteIds` (etat optimiste, nouvelle reference de Set),
   * puis persiste via IPC si `window.benten` est present ; en cas d'echec de persistance, l'etat
   * local est reconcilie (la bascule est annulee). Hors fenetre (tests node), seul l'etat local change.
   */
  toggleFavorite(trackId: number): void;
  /** Amorce `favoriteIds` depuis `favorites:list` (no-op hors `window.benten`). */
  loadFavorites(): Promise<void>;
}

/** Acces defensif a l'API favoris : `undefined` hors fenetre (tests node) ou si non exposee. */
function favoritesApi(): { toggle(id: number, on: boolean): Promise<void>; list(): Promise<number[]> } | undefined {
  return typeof window !== "undefined" ? window.benten?.favorites : undefined;
}

const clampIndex = (i: number, len: number): number =>
  len === 0 ? -1 : Math.min(Math.max(Math.floor(i), 0), len - 1);

export type PlayerStore = StoreApi<PlayerState>;

/** Cree un store de lecture independant (isole, pour tests ou multi-instances). */
export function createPlayerStore(): PlayerStore {
  // Moteur rattache hors de l'etat rendu (objet mutable, jamais serialise/affiche). Absent en node.
  let queueEngine: QueueEngineApi | null = null;

  return createStore<PlayerState>((set, get) => ({
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    status: "idle",
    positionSec: 0,
    durationSec: 0,
    nowPlayingOpen: false,
    queueOpen: false,
    favoriteIds: new Set<number>(),

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

    setQueueOpen(open) {
      set({ queueOpen: open });
    },

    // --- Mutations de file A CHAUD (Task 11) --------------------------------------------------
    // Chaque mutation FUTURE met a jour la file du store PUIS pilote le moteur via
    // `updateQueue(nextQueue, {keepCurrent:true})` : le moteur garde la source courante intacte si
    // son id persiste (zero coupure), et ne reprogramme le gapless que si la suivante a change. La
    // reconciliation `applyEngineState` (statechange) reste la verite finale sur index/piste.

    attachEngine(engine) {
      queueEngine = engine;
    },

    playNext(tracks) {
      if (tracks.length === 0) return;
      const { queue, currentIndex } = get();
      const at = currentIndex < 0 ? queue.length : currentIndex + 1;
      const nextQueue = queue.slice();
      nextQueue.splice(at, 0, ...tracks);
      // L'insertion est APRES la courante : currentIndex / currentTrack ne bougent pas.
      set({ queue: nextQueue });
      queueEngine?.updateQueue(nextQueue, { keepCurrent: true });
    },

    addToQueue(tracks) {
      if (tracks.length === 0) return;
      const nextQueue = [...get().queue, ...tracks];
      set({ queue: nextQueue });
      queueEngine?.updateQueue(nextQueue, { keepCurrent: true });
    },

    removeFromQueue(index) {
      const { queue, currentIndex, currentTrack } = get();
      if (index < 0 || index >= queue.length) return;
      const nextQueue = queue.slice();
      nextQueue.splice(index, 1);

      let nextIndex = currentIndex;
      let nextTrack = currentTrack;
      let resetPos = false;
      if (index < currentIndex) {
        nextIndex = currentIndex - 1; // la courante a glisse d'un cran
      } else if (index === currentIndex) {
        // On retire la courante : estimation optimiste (le moteur confirmera via statechange).
        nextIndex = clampIndex(currentIndex, nextQueue.length);
        nextTrack = nextIndex >= 0 ? (nextQueue[nextIndex] ?? null) : null;
        resetPos = true;
      }
      set({
        queue: nextQueue,
        currentIndex: nextIndex,
        currentTrack: nextTrack,
        ...(resetPos ? { positionSec: 0, durationSec: nextTrack?.durationSec ?? 0 } : {}),
      });
      queueEngine?.updateQueue(nextQueue, { keepCurrent: true });
    },

    moveInQueue(from, to) {
      const { queue, currentIndex, currentTrack } = get();
      const len = queue.length;
      if (from < 0 || from >= len || to < 0 || to >= len || from === to) return;
      const nextQueue = queue.slice();
      const [moved] = nextQueue.splice(from, 1);
      nextQueue.splice(to, 0, moved!);
      // La courante est preservee par IDENTITE : on retrouve son nouvel index.
      const nextIndex = currentTrack ? nextQueue.indexOf(currentTrack) : currentIndex;
      set({ queue: nextQueue, currentIndex: nextIndex, currentTrack });
      queueEngine?.updateQueue(nextQueue, { keepCurrent: true });
    },

    jumpTo(index) {
      const { queue } = get();
      const i = clampIndex(index, queue.length);
      if (i < 0) return;
      set({
        currentIndex: i,
        currentTrack: queue[i] ?? null,
        positionSec: 0,
        durationSec: queue[i]?.durationSec ?? 0,
      });
      void queueEngine?.jumpTo(i);
    },

    toggleFavorite(trackId) {
      const next = new Set(get().favoriteIds);
      const nowOn = !next.has(trackId);
      if (nowOn) next.add(trackId);
      else next.delete(trackId);
      set({ favoriteIds: next });

      const api = favoritesApi();
      if (!api) return; // hors fenetre (tests) : etat local uniquement.
      void api.toggle(trackId, nowOn).catch(() => {
        // Reconciliation : la persistance a echoue, on annule notre bascule sur cet id precis.
        const revert = new Set(get().favoriteIds);
        if (nowOn) revert.delete(trackId);
        else revert.add(trackId);
        set({ favoriteIds: revert });
      });
    },

    async loadFavorites() {
      const api = favoritesApi();
      if (!api) return;
      try {
        const ids = await api.list();
        set({ favoriteIds: new Set(ids) });
      } catch {
        /* amorcage best-effort : on garde l'etat courant en cas d'echec. */
      }
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
