import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import { canResume } from "../lib/viewModels";
import { playerStore, usePlayer } from "../state/player";
import type { RouteViewActions } from "../shell/RouteView";
import { isQueue, playListInOrder } from "./artistPlay";

/**
 * Lecture d'une playlist par le chemin existant (album éphémère → `playAlbumInOrder` /
 * `shuffleAlbum` / `playAlbum` / `togglePlay`) : aucune autre API de lecture.
 *
 * La file lancée depuis une playlist lui est ATTRIBUÉE par son id (instance de la file du lecteur
 * au moment du lancement) : retirer le titre en cours de la playlist ne fait pas perdre cette
 * attribution — l'en-tête montre toujours « Pause » et « Lecture » reprend au lieu de repartir du
 * titre 1. Toute autre file (nouvel album, file modifiée) la lui retire.
 */

export const PLAYLIST_ALBUM_ID = -1;

export interface PlaylistRef {
  id: number;
  name: string;
}

export function playlistAlbum(name: string, tracks: readonly TrackRow[]): Album {
  return {
    id: PLAYLIST_ALBUM_ID,
    title: name,
    artist: "",
    artKey: tracks.find((t) => t.artKey)?.artKey ?? null,
    tracks,
  };
}

/** Playlist propriétaire de la file du lecteur : son id et l'instance de file qu'elle a posée. */
const owner = createStore<{ id: number | null; queue: readonly TrackRow[] | null }>(() => ({ id: null, queue: null }));

/** À appeler juste après une action qui pose la file depuis la playlist `id`. */
function claimQueue(id: number): void {
  owner.setState({ id, queue: playerStore.getState().queue });
}

/** La file du lecteur est celle que la playlist `id` a lancée (quel que soit son contenu actuel). */
export function playlistOwnsQueue(id: number): boolean {
  const o = owner.getState();
  return o.id === id && o.queue !== null && o.queue === playerStore.getState().queue;
}

/** Hook : la file du lecteur appartient à la playlist `id`. */
export function usePlaylistOwnsQueue(id: number): boolean {
  const o = useStore(owner);
  const queue = usePlayer((s) => s.queue);
  return o.id === id && o.queue !== null && o.queue === queue;
}

/**
 * « Lecture » : dans l'ordre (mélange coupé). Sur sa propre file : lecture / pause (reprise sur
 * place, même si le titre en cours a été retiré de la playlist).
 */
export function playPlaylist(p: PlaylistRef, tracks: readonly TrackRow[], actions: RouteViewActions): void {
  if (tracks.length === 0) return;
  const s = playerStore.getState();
  if (playlistOwnsQueue(p.id) && !isQueue(tracks) && canResume(s.status)) {
    // File attribuée mais dont le contenu a changé : même comportement que sur sa propre file.
    if (s.status !== "playing" && s.shuffle) s.setShuffle(false);
    actions.togglePlay();
    return;
  }
  playListInOrder(playlistAlbum(p.name, tracks), actions);
  claimQueue(p.id);
}

/** Lecture depuis la ligne `index` (double-clic, Entrée). */
export function playPlaylistAt(
  p: PlaylistRef,
  tracks: readonly TrackRow[],
  index: number,
  actions: RouteViewActions,
): void {
  if (tracks.length === 0) return;
  actions.playAlbum(playlistAlbum(p.name, tracks), index);
  claimQueue(p.id);
}

/** « Aléatoire » : active le mélange et part d'un titre au hasard (chemin `shuffleAlbum`). */
export function shufflePlaylist(p: PlaylistRef, tracks: readonly TrackRow[], actions: RouteViewActions): void {
  if (tracks.length === 0) return;
  actions.shuffleAlbum(playlistAlbum(p.name, tracks));
  claimQueue(p.id);
}
