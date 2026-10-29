import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * Effets d'ajout à une playlist (ajout utilisateur, Tâche 9) — store pur, sans React :
 *  - `flights` : pochettes miniatures en vol vers l'entrée de la playlist dans la barre latérale
 *    (rendues par `<FlyLayer>`, qui appelle `land` à l'arrivée) ;
 *  - `held` : compteur AFFICHÉ par l'entrée pendant le vol (l'ancien), libéré à l'atterrissage pour
 *    qu'il roule au moment où la pochette arrive ;
 *  - `pops` : numéro de « pop » par playlist (l'entrée rebondit à chaque incrément) ;
 *  - `dropTarget` : entrée survolée par un glisser de titres (contour à l'accent).
 *
 * Filet de sécurité : un vol jamais rendu (couche absente, cible introuvable) atterrit seul.
 */

export interface FlightInput {
  playlistId: number;
  artKey: string | null;
  /** Graine de la pochette générative de repli. */
  seed: string;
  /** Point de départ (coordonnées client). */
  from: { x: number; y: number };
}

export interface Flight extends FlightInput {
  id: number;
}

export interface PlaylistFxState {
  flights: Flight[];
  held: ReadonlyMap<number, number>;
  pops: ReadonlyMap<number, number>;
  dropTarget: number | null;
  /** Lance un vol ; `count` = compteur à afficher pendant le vol (avant l'ajout). */
  fly(input: FlightInput, count: number): number;
  land(id: number): void;
  /** Annule un vol (échec de l'ajout) : compteur libéré, pas de pop. */
  cancel(id: number): void;
  pop(playlistId: number): void;
  setDropTarget(playlistId: number | null): void;
}

export type PlaylistFxStore = StoreApi<PlaylistFxState>;

/** Au-delà, un vol non terminé atterrit d'office (ms). */
export const FLIGHT_SAFETY_MS = 1500;

export function createPlaylistFx(): PlaylistFxStore {
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  return createStore<PlaylistFxState>((set, get) => {
    /** Retire le vol `id` ; libère le compteur si c'était le dernier vers sa playlist. */
    const finish = (id: number, popIt: boolean): void => {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.delete(id);
      const { flights, held, pops } = get();
      const flight = flights.find((f) => f.id === id);
      if (!flight) return;
      const rest = flights.filter((f) => f.id !== id);
      const nextHeld = new Map(held);
      if (!rest.some((f) => f.playlistId === flight.playlistId)) nextHeld.delete(flight.playlistId);
      const nextPops = popIt ? new Map(pops).set(flight.playlistId, (pops.get(flight.playlistId) ?? 0) + 1) : pops;
      set({ flights: rest, held: nextHeld, pops: nextPops });
    };

    return {
      flights: [],
      held: new Map(),
      pops: new Map(),
      dropTarget: null,

      fly(input, count) {
        const id = nextId++;
        const held = get().held.has(input.playlistId) ? get().held : new Map(get().held).set(input.playlistId, count);
        set({ flights: [...get().flights, { ...input, id }], held });
        timers.set(
          id,
          setTimeout(() => finish(id, true), FLIGHT_SAFETY_MS),
        );
        return id;
      },

      land(id) {
        finish(id, true);
      },

      cancel(id) {
        finish(id, false);
      },

      pop(playlistId) {
        const pops = get().pops;
        set({ pops: new Map(pops).set(playlistId, (pops.get(playlistId) ?? 0) + 1) });
      },

      setDropTarget(playlistId) {
        if (get().dropTarget !== playlistId) set({ dropTarget: playlistId });
      },
    };
  });
}

/** Store singleton de l'application. */
export const playlistFx: PlaylistFxStore = createPlaylistFx();

export function usePlaylistFx<T>(selector: (state: PlaylistFxState) => T): T {
  return useStore(playlistFx, selector);
}
