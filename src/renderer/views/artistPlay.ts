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
  type ArtistPageModel,
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

/**
 * Pages et files d'artiste MÉMOÏSÉES par (liste d'albums, nom replié[, regroupement]) : la liste
 * d'albums change de référence à chaque rechargement de la bibliothèque (WeakMap → l'ancien cache
 * part avec elle). Une tuile qui se re-rend à chaque lecture / pause / suivant ne rescanne plus
 * toute la bibliothèque.
 */
const pageCache = new WeakMap<readonly Album[], Map<string, ArtistPageModel>>();
const queueCache = new WeakMap<readonly Album[], Map<string, TrackRow[]>>();

const bucket = <V>(cache: WeakMap<readonly Album[], Map<string, V>>, albums: readonly Album[]): Map<string, V> => {
  let m = cache.get(albums);
  if (!m) {
    m = new Map();
    cache.set(albums, m);
  }
  return m;
};

export function cachedArtistPage(albums: readonly Album[], name: string): ArtistPageModel {
  const m = bucket(pageCache, albums);
  const key = artistKey(name);
  let page = m.get(key);
  if (!page) {
    page = artistPage(albums, name, libraryIndex(albums));
    m.set(key, page);
  }
  return page;
}

export function cachedArtistQueue(albums: readonly Album[], grouped: boolean, name: string): TrackRow[] {
  const m = bucket(queueCache, albums);
  const key = `${grouped ? 1 : 0}|${artistKey(name)}`;
  let list = m.get(key);
  if (!list) {
    list = artistQueue(cachedArtistPage(albums, name).tracks, grouped);
    m.set(key, list);
  }
  return list;
}

/** File « Lecture » de l'artiste `name`, lue dans les stores (mise en cache). */
export function artistQueueOf(name: string): TrackRow[] {
  return cachedArtistQueue(libraryStore.getState().albums, settingsStore.getState().groupVersions, name);
}

/** La file du lecteur est exactement celle-ci (le bouton lecture bascule alors lecture/pause). */
export function isQueue(list: readonly TrackRow[]): boolean {
  return sameTrackList(playerStore.getState().queue, list);
}

/**
 * « Lecture » : sur la file en cours, bascule lecture/pause ; sinon lit tout l'artiste. Ce qui
 * DÉMARRE la lecture la démarre dans l'ordre (mélange coupé, même pour reprendre après un
 * « Aléatoire ») ; une simple mise en pause ne touche pas au mélange.
 */
export function playArtist(name: string, list: readonly TrackRow[], actions: RouteViewActions): void {
  if (list.length === 0) return;
  const p = playerStore.getState();
  const toggle = isQueue(list) && canResume(p.status);
  const willPlay = !toggle || p.status !== "playing";
  if (willPlay && p.shuffle) p.setShuffle(false);
  if (toggle) actions.togglePlay();
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
