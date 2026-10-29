import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { CircleAlert, ListMusic, ListPlus } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import { partitionNewTracks } from "../lib/viewModels";
import { libraryStore } from "../state/library";
import { playlistsStore, type PlaylistsStore } from "../state/playlists";
import { uiStore } from "../state/ui";
import { playlistFx, type PlaylistFxStore } from "../ui/playlistFx";
import { quoted, toast as showToast, type ToastOptions } from "../ui/toastStore";

/**
 * Ajout à une playlist — chemin UNIQUE du sous-menu « Ajouter à une playlist ▸ », du dialogue
 * « Nouvelle playlist… » et du dépôt sur la barre latérale : doublons écartés, vol de la pochette,
 * confirmation par toast.
 */

export interface PlaylistTargetRef {
  id: number;
  name: string;
}

export interface AddOptions {
  /** Point de départ du vol de la pochette (coordonnées client) ; sans : simple « pop ». */
  origin?: { x: number; y: number };
  /** Ajoute même les titres déjà présents (« Ajouter quand même »). */
  allowDuplicates?: boolean;
  /** Pas de toast de confirmation (l'appelant en affiche un, ex. création + ajout). */
  silent?: boolean;
}

export interface AddDeps {
  store: PlaylistsStore;
  fx: PlaylistFxStore;
  toast: (message: string, opts?: ToastOptions) => number;
}

/** Pochette du vol : celle du premier titre qui en a une (graine = celle de son album). */
export function flightArt(tracks: readonly TrackRow[]): { artKey: string | null; seed: string } {
  const t = tracks.find((x) => x.artKey) ?? tracks[0];
  return { artKey: t?.artKey ?? null, seed: t ? `${t.albumId}:${t.album}` : "playlist" };
}

/**
 * Fabrique l'action d'ajout (dépendances injectées : testable sans fenêtre). Renvoie le nombre de
 * titres effectivement ajoutés (0 : rien, doublons seuls ou échec).
 */
export function createAddToPlaylist(deps: AddDeps) {
  const { store, fx, toast } = deps;

  const add = async (target: PlaylistTargetRef, tracks: readonly TrackRow[], opts: AddOptions = {}): Promise<number> => {
    const name = quoted(target.name);
    if (tracks.length === 0) return 0;
    // Un même titre n'est jamais ajouté deux fois par UNE demande (même « Ajouter quand même »).
    let ids = [...new Set(tracks.map((t) => t.id))];
    let dupes = 0;
    if (!opts.allowDuplicates) {
      const current = await store.getState().tracksOf(target.id);
      if (!current.ok) {
        // Sans le contenu actuel, le tri des doublons serait faux : on n'ajoute rien.
        toast(`Impossible d'ajouter à ${name}`, { icon: CircleAlert });
        return 0;
      }
      const existing = current.tracks.map((t) => t.id);
      const split = partitionNewTracks(existing, ids);
      ids = split.fresh;
      dupes = split.dupes.length;
      if (ids.length === 0) {
        toast(`Déjà dans ${name}`, {
          icon: ListMusic,
          action: { label: "Ajouter quand même", onClick: () => void add(target, tracks, { allowDuplicates: true }) },
          durationMs: 4000,
        });
        return 0;
      }
    }

    const count = store.getState().rows.find((r) => r.id === target.id)?.trackCount ?? 0;
    const freshTracks = tracks.filter((t) => ids.includes(t.id));
    const flight = opts.origin
      ? fx.getState().fly({ playlistId: target.id, ...flightArt(freshTracks), from: opts.origin }, count)
      : null;

    const ok = await store.getState().add(target.id, ids);
    if (!ok) {
      if (flight !== null) fx.getState().cancel(flight);
      toast(`Impossible d'ajouter à ${name}`, { icon: CircleAlert });
      return 0;
    }
    if (flight === null) fx.getState().pop(target.id);
    if (!opts.silent) {
      const n = ids.length;
      const head = n > 1 ? `${n} titres ajoutés à ${name}` : `Ajouté à ${name}`;
      const tail = dupes > 0 ? ` · ${dupes} déjà présent${dupes > 1 ? "s" : ""}` : "";
      toast(head + tail, {
        icon: ListPlus,
        action: { label: "Afficher", onClick: () => uiStore.getState().navigate({ name: "playlist", id: target.id }) },
      });
    }
    return ids.length;
  };

  return add;
}

/** Index id → titre de la bibliothèque, recalculé seulement quand la liste change. */
const byIdCache = new WeakMap<readonly TrackRow[], Map<number, TrackRow>>();

/** Titres de la bibliothèque pour des ids glissés (ordre conservé, ids inconnus ignorés). */
export function tracksFromIds(ids: readonly number[]): TrackRow[] {
  const all = libraryStore.getState().tracks;
  let index = byIdCache.get(all);
  if (!index) {
    index = new Map(all.map((t) => [t.id, t]));
    byIdCache.set(all, index);
  }
  const out: TrackRow[] = [];
  for (const id of ids) {
    const t = index.get(id);
    if (t) out.push(t);
  }
  return out;
}

/** Action d'ajout de l'application (stores singletons). */
export const addToPlaylist = createAddToPlaylist({ store: playlistsStore, fx: playlistFx, toast: showToast });

/* --------------------------------- Dialogue « Nouvelle playlist » --------------------------------- */

export interface NewPlaylistRequest {
  /** Titres à ajouter à la création (vide : playlist vide, ouverte ensuite). */
  tracks: readonly TrackRow[];
  /** Point de départ du vol (sinon : centre du dialogue). */
  origin?: { x: number; y: number };
}

export interface NewPlaylistDialogState {
  request: NewPlaylistRequest | null;
  /** Identité de chaque ouverture (le champ se réinitialise). */
  seq: number;
}

export const newPlaylistDialog: StoreApi<NewPlaylistDialogState> = createStore<NewPlaylistDialogState>(() => ({
  request: null,
  seq: 0,
}));

/** Ouvre le dialogue « Nouvelle playlist » (avec les titres à y mettre, le cas échéant). */
export function openNewPlaylist(tracks: readonly TrackRow[] = [], origin?: { x: number; y: number }): void {
  // Un titre glissé / sélectionné deux fois n'est compté (ni ajouté) qu'une fois.
  const seen = new Set<number>();
  const unique = tracks.filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
  newPlaylistDialog.setState((s) => ({ request: { tracks: unique, origin }, seq: s.seq + 1 }));
}

export function closeNewPlaylist(): void {
  newPlaylistDialog.setState({ request: null });
}

export function useNewPlaylistDialog<T>(selector: (s: NewPlaylistDialogState) => T): T {
  return useStore(newPlaylistDialog, selector);
}

/* ------------------------------- Suppression / renommage demandés ------------------------------- */

export interface PlaylistRequests {
  /** Playlist dont la suppression attend confirmation (dialogue). */
  deleting: PlaylistTargetRef | null;
  /** Playlist à passer en renommage à l'ouverture de sa page (menu de la grille). */
  renaming: number | null;
}

export const playlistRequests: StoreApi<PlaylistRequests> = createStore<PlaylistRequests>(() => ({
  deleting: null,
  renaming: null,
}));

export function usePlaylistRequests<T>(selector: (s: PlaylistRequests) => T): T {
  return useStore(playlistRequests, selector);
}

/** Demande la suppression de `p` (dialogue de confirmation). */
export function askDeletePlaylist(p: PlaylistTargetRef): void {
  playlistRequests.setState({ deleting: { id: p.id, name: p.name } });
}

/** Ouvre la page de `id` en mode renommage. */
export function renamePlaylistInPlace(id: number): void {
  playlistRequests.setState({ renaming: id });
  uiStore.getState().navigate({ name: "playlist", id });
}

/** Vrai (une seule fois) si un renommage de `id` était demandé. */
export function consumeRename(id: number): boolean {
  if (playlistRequests.getState().renaming !== id) return false;
  playlistRequests.setState({ renaming: null });
  return true;
}
