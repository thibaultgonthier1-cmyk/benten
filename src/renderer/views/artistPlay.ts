import { ListEnd, ListStart, Play, Shuffle } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import {
  artistKey,
  artistPage,
  artistQueue,
  buildArtistIndex,
  canResume,
  sameTrackList,
  type ArtistIndex,
} from "../lib/viewModels";
import { libraryStore } from "../state/library";
import { playerStore } from "../state/player";
import { settingsStore } from "../state/settings";
import type { RouteViewActions } from "../shell/RouteView";
import type { MenuItem } from "../ui/menuStore";
import { quoted, toast } from "../ui/toastStore";

/**
 * Lecture « tout l'artiste » (grille Artistes, en-tête de la page artiste) par le chemin existant :
 * un album éphémère passé à `playAlbumInOrder` / `shuffleAlbum` (aucune autre API de lecture).
 */

/** Album éphémère d'un artiste (Playlists : -1, Titres : -2). */
export const ARTIST_ALBUM_ID = -3;

/** Élément partagé avatar tuile → en-tête de la page artiste. */
export const artistLayoutId = (name: string): string => `artist-avatar-${artistKey(name)}`;

export function artistAlbum(name: string, tracks: readonly TrackRow[]): Album {
  return {
    id: ARTIST_ALBUM_ID,
    title: name,
    artist: name,
    artKey: tracks.find((t) => t.artKey)?.artKey ?? null,
    tracks,
  };
}

/** Index des noms de la bibliothèque, calculé une fois par liste d'albums (rechargement = nouvelle liste). */
const indexCache = new WeakMap<readonly Album[], ArtistIndex>();
export function libraryIndex(albums: readonly Album[]): ArtistIndex {
  let index = indexCache.get(albums);
  if (!index) {
    index = buildArtistIndex(albums);
    indexCache.set(albums, index);
  }
  return index;
}

/** File « Lecture » de l'artiste `name`, lue dans les stores au moment du clic. */
export function artistQueueOf(name: string): TrackRow[] {
  const albums = libraryStore.getState().albums;
  const { tracks } = artistPage(albums, name, libraryIndex(albums));
  return artistQueue(tracks, settingsStore.getState().groupVersions);
}

/** La file du lecteur est exactement celle-ci (le bouton lecture bascule alors lecture/pause). */
export function isQueue(list: readonly TrackRow[]): boolean {
  return sameTrackList(playerStore.getState().queue, list);
}

/**
 * « Lecture » : TOUJOURS dans l'ordre (mélange coupé, même pour reprendre la file en cours après
 * un « Aléatoire ») ; sur la file en cours : bascule lecture/pause ; sinon lit tout l'artiste.
 */
export function playArtist(name: string, list: readonly TrackRow[], actions: RouteViewActions): void {
  if (list.length === 0) return;
  const p = playerStore.getState();
  if (p.shuffle) p.setShuffle(false);
  if (isQueue(list) && canResume(p.status)) actions.togglePlay();
  else actions.playAlbumInOrder(artistAlbum(name, list));
}

export function shuffleArtist(name: string, list: readonly TrackRow[], actions: RouteViewActions): void {
  if (list.length > 0) actions.shuffleAlbum(artistAlbum(name, list));
}

export function playArtistNext(name: string, list: readonly TrackRow[]): void {
  if (list.length === 0) return;
  playerStore.getState().playNext(list);
  toast(`${quoted(name)} sera lu ensuite`, { icon: ListStart });
}

export function addArtistToQueue(name: string, list: readonly TrackRow[]): void {
  if (list.length === 0) return;
  playerStore.getState().addToQueue(list);
  toast(`${quoted(name)} ajouté à la file`, { icon: ListEnd });
}

/** Menu contextuel d'un artiste : Lire, Lire ensuite, Ajouter à la file, Aléatoire. */
export function artistMenuItems(name: string, actions: RouteViewActions): MenuItem[] {
  const list = artistQueueOf(name);
  const empty = list.length === 0;
  return [
    { label: "Lire", icon: Play, disabled: empty, onSelect: () => actions.playAlbumInOrder(artistAlbum(name, list)) },
    { label: "Lire ensuite", icon: ListStart, disabled: empty, onSelect: () => playArtistNext(name, list) },
    { label: "Ajouter à la file", icon: ListEnd, disabled: empty, onSelect: () => addArtistToQueue(name, list) },
    "separator",
    { label: "Aléatoire", icon: Shuffle, disabled: empty, onSelect: () => shuffleArtist(name, list, actions) },
  ];
}
