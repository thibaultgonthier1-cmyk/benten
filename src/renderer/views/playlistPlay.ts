import type { TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import type { RouteViewActions } from "../shell/RouteView";
import { playListInOrder } from "./artistPlay";

/**
 * Lecture d'une playlist par le chemin existant (album éphémère → `playAlbumInOrder` /
 * `shuffleAlbum` / `playAlbum` / `togglePlay`) : aucune autre API de lecture.
 */

export const PLAYLIST_ALBUM_ID = -1;

export function playlistAlbum(name: string, tracks: readonly TrackRow[]): Album {
  return {
    id: PLAYLIST_ALBUM_ID,
    title: name,
    artist: "",
    artKey: tracks.find((t) => t.artKey)?.artKey ?? null,
    tracks,
  };
}

/** « Lecture » : dans l'ordre (mélange coupé) ; sur sa propre file, lecture / pause. */
export function playPlaylist(name: string, tracks: readonly TrackRow[], actions: RouteViewActions): void {
  playListInOrder(playlistAlbum(name, tracks), actions);
}

/** « Aléatoire » : active le mélange et part d'un titre au hasard (chemin `shuffleAlbum`). */
export function shufflePlaylist(name: string, tracks: readonly TrackRow[], actions: RouteViewActions): void {
  if (tracks.length > 0) actions.shuffleAlbum(playlistAlbum(name, tracks));
}
