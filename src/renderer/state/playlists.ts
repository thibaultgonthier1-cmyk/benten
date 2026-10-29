import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { mosaicArtKeys } from "../lib/viewModels";
import type { BentenApi, PlaylistRow, TrackRow } from "../../shared/types";

/**
 * Store des playlists (Phase 3, Tâche 9) : source unique de la barre latérale, de la grille
 * Playlists, des sous-menus « Ajouter à une playlist ▸ » et de la recherche. Chaque mutation passe
 * par lui et se termine par un `refresh()` : la liste (et ses compteurs) est à jour IMMÉDIATEMENT
 * après une création, un renommage, une suppression ou un ajout — sans attendre un retour de focus.
 *
 * `art` : mosaïque (jusqu'à 4 pochettes distinctes) de chaque playlist, relue seulement pour les
 * playlists dont `updatedAt` a bougé. `rev` : révision du CONTENU de chaque playlist, incrémentée à
 * chaque mutation qui le touche (la page ouverte recharge ses titres).
 *
 * Les mutations ne lèvent jamais : `false` / `null` en cas d'échec IPC (l'appelant le signale).
 */

export interface PlaylistsState {
  /** Ordre du Main : modifiées récemment d'abord (sous-menus). */
  rows: PlaylistRow[];
  /** Vrai après le premier chargement (abouti ou non). */
  loaded: boolean;
  art: ReadonlyMap<number, readonly string[]>;
  rev: ReadonlyMap<number, number>;
  refresh(): Promise<void>;
  /** Pistes d'une playlist (ordre des positions) ; `[]` en cas d'échec. */
  tracksOf(id: number): Promise<TrackRow[]>;
  /** Crée une playlist ; renvoie son id, ou `null` (nom vide, échec). */
  create(name: string): Promise<number | null>;
  rename(id: number, name: string): Promise<boolean>;
  remove(id: number): Promise<boolean>;
  /** Ajoute en fin de playlist (aucun filtrage des doublons ici, cf. `playlistActions`). */
  add(id: number, trackIds: readonly number[]): Promise<boolean>;
  /** Retire la ligne à `position`. */
  removeAt(id: number, position: number): Promise<boolean>;
  reorder(id: number, from: number, to: number): Promise<boolean>;
  /** Annule un retrait : remet `trackId` à `position` (ajout en fin puis déplacement). */
  restoreAt(id: number, trackId: number, position: number): Promise<boolean>;
}

export type PlaylistsStore = StoreApi<PlaylistsState>;

function windowApi(): BentenApi | undefined {
  return typeof window !== "undefined" ? window.benten : undefined;
}

export function createPlaylistsStore(getApi: () => BentenApi | undefined = windowApi): PlaylistsStore {
  const pl = (): BentenApi["playlists"] | undefined => getApi()?.playlists;
  /** `updatedAt` de la dernière mosaïque lue, par playlist. */
  const artStamp = new Map<number, number>();
  /** Rafraîchissements concurrents : seule la réponse la plus récente s'applique. */
  let refreshSeq = 0;

  return createStore<PlaylistsState>((set, get) => {
    const bump = (id: number): void => {
      const rev = new Map(get().rev);
      rev.set(id, (rev.get(id) ?? 0) + 1);
      set({ rev });
    };

    /** Exécute une mutation IPC puis rafraîchit ; `false` si l'IPC échoue. */
    const mutate = async (id: number, run: (api: BentenApi["playlists"]) => Promise<void>): Promise<boolean> => {
      const api = pl();
      if (!api) return false;
      try {
        await run(api);
      } catch {
        return false;
      }
      bump(id);
      await get().refresh();
      return true;
    };

    return {
      rows: [],
      loaded: false,
      art: new Map(),
      rev: new Map(),

      async refresh() {
        const api = pl();
        if (!api) return;
        const seq = ++refreshSeq;
        let rows: PlaylistRow[];
        try {
          rows = await api.list();
        } catch {
          if (seq === refreshSeq) set({ loaded: true });
          return;
        }
        const prev = get().art;
        const art = new Map<number, readonly string[]>();
        const stamps = new Map<number, number>();
        await Promise.all(
          rows.map(async (r) => {
            const known = prev.get(r.id);
            if (known && artStamp.get(r.id) === r.updatedAt) {
              art.set(r.id, known);
              stamps.set(r.id, r.updatedAt);
              return;
            }
            try {
              art.set(r.id, mosaicArtKeys(await api.tracks(r.id)));
              stamps.set(r.id, r.updatedAt);
            } catch {
              art.set(r.id, known ?? []);
            }
          }),
        );
        if (seq !== refreshSeq) return;
        artStamp.clear();
        for (const [id, at] of stamps) artStamp.set(id, at);
        set({ rows, art, loaded: true });
      },

      async tracksOf(id) {
        const api = pl();
        if (!api) return [];
        try {
          return await api.tracks(id);
        } catch {
          return [];
        }
      },

      async create(name) {
        const api = pl();
        const n = name.trim();
        if (!api || !n) return null;
        let id: number;
        try {
          id = await api.create(n);
        } catch {
          return null;
        }
        await get().refresh();
        return id;
      },

      rename(id, name) {
        const n = name.trim();
        if (!n) return Promise.resolve(false);
        return mutate(id, (api) => api.rename(id, n));
      },

      async remove(id) {
        const ok = await mutate(id, (api) => api.remove(id));
        if (ok) {
          const rev = new Map(get().rev);
          rev.delete(id);
          set({ rev });
        }
        return ok;
      },

      add(id, trackIds) {
        if (trackIds.length === 0) return Promise.resolve(false);
        return mutate(id, (api) => api.add(id, trackIds));
      },

      removeAt(id, position) {
        return mutate(id, (api) => api.removeTrack(id, position));
      },

      reorder(id, from, to) {
        if (from === to) return Promise.resolve(true);
        return mutate(id, (api) => api.reorder(id, from, to));
      },

      restoreAt(id, trackId, position) {
        return mutate(id, async (api) => {
          await api.add(id, [trackId]);
          const last = (await api.tracks(id)).length - 1;
          const to = Math.max(0, Math.min(position, last));
          if (last !== to) await api.reorder(id, last, to);
        });
      },
    };
  });
}

/** Store singleton de l'application. */
export const playlistsStore: PlaylistsStore = createPlaylistsStore();

/** Hook React sélecteur sur le store singleton. */
export function usePlaylists<T>(selector: (state: PlaylistsState) => T): T {
  return useStore(playlistsStore, selector);
}
