import {
  Disc3,
  Heart,
  HeartOff,
  ListEnd,
  ListMusic,
  ListPlus,
  ListStart,
  MicVocal,
  Play,
} from "lucide-react";
import type { Album } from "../lib/library";
import type { MenuItem } from "../ui/menuStore";
import { quoted, toast } from "../ui/toastStore";
import type { TrackRow } from "../../shared/types";

/** Playlist existante proposée dans le sous-menu « Ajouter à une playlist ». */
export interface PlaylistTarget {
  id: number;
  name: string;
}

/** Actions existantes consommées par le menu d'une tuile d'album (fournies par l'App / le store). */
export interface AlbumMenuActions {
  playAlbum(album: Album): void;
  albumPlayNext(album: Album): void;
  albumAddToQueue(album: Album): void;
  /** « Nouvelle playlist… » : ouvre le dialogue de création (avec les pistes de l'album). */
  albumAddToPlaylist(album: Album): void;
  /** Ajoute les pistes à une playlist existante (l'appelant confirme par un toast). */
  addToPlaylist(playlist: PlaylistTarget, tracks: readonly TrackRow[]): void;
  toggleFavorite(trackId: number): void;
  goToArtist(artist: string): void;
}

/** Actions du menu d'une ligne de titre. */
export interface TrackMenuActions {
  play(track: TrackRow): void;
  playNext(tracks: readonly TrackRow[]): void;
  addToQueue(tracks: readonly TrackRow[]): void;
  /** « Nouvelle playlist… » : dialogue de création, avec ces titres (`label` : ce qu'on ajoute). */
  newPlaylist(tracks: readonly TrackRow[], label: string): void;
  addToPlaylist(playlist: PlaylistTarget, tracks: readonly TrackRow[]): void;
  toggleFavorite(trackId: number): void;
  goToAlbum(albumId: number): void;
  goToArtist(artist: string): void;
}

/**
 * Sous-menu « Ajouter à une playlist ▸ » : création (dialogue « Nouvelle playlist… ») puis les playlists
 * existantes, dans l'ordre fourni (récentes d'abord, cf. `playlists.list`).
 */
export function playlistSubmenu(
  onNew: () => void,
  onAdd: (p: PlaylistTarget) => void,
  playlists: readonly PlaylistTarget[],
): MenuItem[] {
  const items: MenuItem[] = [{ label: "Nouvelle playlist…", icon: ListPlus, onSelect: onNew }];
  if (playlists.length > 0) {
    items.push("separator");
    for (const p of playlists) items.push({ label: p.name, icon: ListMusic, onSelect: () => onAdd(p) });
  }
  return items;
}

/**
 * Menu contextuel d'une tuile d'album : lire, lire ensuite, ajouter à la file, ajouter à une
 * playlist ▸ (création ou playlist existante), favori, aller à l'artiste. Les actions
 * silencieuses (file, favori) confirment par un toast.
 *
 * Favori d'album : un album est « favori » dès qu'une de ses pistes l'est (même règle que la vue
 * Favoris). « Ajouter » marque les pistes qui ne le sont pas ; « Retirer » démarque celles qui le sont.
 */
export function albumMenuItems(
  album: Album,
  actions: AlbumMenuActions,
  favoriteIds: ReadonlySet<number>,
  playlists: readonly PlaylistTarget[] = [],
): MenuItem[] {
  const empty = album.tracks.length === 0;
  const favTracks = album.tracks.filter((t) => favoriteIds.has(t.id));
  const isFav = favTracks.length > 0;
  const name = quoted(album.title);

  return [
    { label: "Lire", icon: Play, disabled: empty, onSelect: () => actions.playAlbum(album) },
    {
      label: "Lire ensuite",
      icon: ListStart,
      disabled: empty,
      onSelect: () => {
        actions.albumPlayNext(album);
        toast(`${name} sera lu ensuite`, { icon: ListStart });
      },
    },
    {
      label: "Ajouter à la file",
      icon: ListEnd,
      disabled: empty,
      onSelect: () => {
        actions.albumAddToQueue(album);
        toast(`${name} ajouté à la file`, { icon: ListEnd });
      },
    },
    "separator",
    {
      label: "Ajouter à une playlist",
      icon: ListPlus,
      disabled: empty,
      submenu: playlistSubmenu(
        () => actions.albumAddToPlaylist(album),
        (p) => actions.addToPlaylist(p, album.tracks),
        playlists,
      ),
    },
    {
      label: isFav ? "Retirer des favoris" : "Ajouter aux favoris",
      icon: isFav ? HeartOff : Heart,
      disabled: empty,
      onSelect: () => {
        const targets = isFav ? favTracks : album.tracks.filter((t) => !favoriteIds.has(t.id));
        for (const t of targets) actions.toggleFavorite(t.id);
        toast(isFav ? `${name} retiré des favoris` : `${name} ajouté aux favoris`, {
          icon: isFav ? HeartOff : Heart,
        });
      },
    },
    "separator",
    {
      label: "Aller à l'artiste",
      icon: MicVocal,
      disabled: !album.artist,
      onSelect: () => actions.goToArtist(album.artist),
    },
  ];
}

/**
 * Menu contextuel d'une ligne de titre. `hideAlbumLink` retire « Aller à l'album » quand on est
 * déjà sur la page de cet album ; `extra` ajoute des entrées propres à la page en fin de menu
 * (ex. « Retirer de la playlist »), après un séparateur.
 */
export function trackMenuItems(
  track: TrackRow,
  actions: TrackMenuActions,
  favoriteIds: ReadonlySet<number>,
  playlists: readonly PlaylistTarget[] = [],
  opts: { hideAlbumLink?: boolean; extra?: readonly MenuItem[] } = {},
): MenuItem[] {
  const isFav = favoriteIds.has(track.id);
  const name = quoted(track.title);
  const one = [track];

  const items: MenuItem[] = [
    { label: "Lire", icon: Play, disabled: track.playable === false, onSelect: () => actions.play(track) },
    {
      label: "Lire ensuite",
      icon: ListStart,
      onSelect: () => {
        actions.playNext(one);
        toast(`${name} sera lu ensuite`, { icon: ListStart });
      },
    },
    {
      label: "Ajouter à la file",
      icon: ListEnd,
      onSelect: () => {
        actions.addToQueue(one);
        toast(`${name} ajouté à la file`, { icon: ListEnd });
      },
    },
    "separator",
    {
      label: "Ajouter à une playlist",
      icon: ListPlus,
      submenu: playlistSubmenu(
        () => actions.newPlaylist(one, track.title),
        (p) => actions.addToPlaylist(p, one),
        playlists,
      ),
    },
    {
      label: isFav ? "Retirer des favoris" : "Ajouter aux favoris",
      icon: isFav ? HeartOff : Heart,
      onSelect: () => {
        actions.toggleFavorite(track.id);
        toast(isFav ? `${name} retiré des favoris` : `${name} ajouté aux favoris`, {
          icon: isFav ? HeartOff : Heart,
        });
      },
    },
    "separator",
  ];
  if (!opts.hideAlbumLink) {
    items.push({ label: "Aller à l'album", icon: Disc3, onSelect: () => actions.goToAlbum(track.albumId) });
  }
  items.push({
    label: "Aller à l'artiste",
    icon: MicVocal,
    disabled: !track.artist,
    onSelect: () => actions.goToArtist(track.artist),
  });
  if (opts.extra && opts.extra.length > 0) items.push("separator", ...opts.extra);
  return items;
}

/** Actions du menu d'une sélection de titres (vue Titres). */
export interface SelectionMenuActions extends TrackMenuActions {
  /** Lit exactement ces titres, dans cet ordre (sélection multiple, toutes les versions). */
  playTracks(tracks: readonly TrackRow[]): void;
}

/**
 * Menu contextuel de la sélection de la vue Titres. Un seul titre : le menu d'un titre (+ « Lire
 * toutes les versions » quand c'est un morceau regroupé dont `opts.versions` liste les versions).
 * Plusieurs : Lire, Lire ensuite, Ajouter à la file, Ajouter à une playlist ▸, favori — sur toute
 * la sélection, dans l'ordre affiché. Favori : « Retirer » si tous le sont, sinon « Ajouter » marque
 * ceux qui ne le sont pas.
 */
export function selectionMenuItems(
  tracks: readonly TrackRow[],
  actions: SelectionMenuActions,
  favoriteIds: ReadonlySet<number>,
  playlists: readonly PlaylistTarget[] = [],
  opts: { versions?: readonly TrackRow[] } = {},
): MenuItem[] {
  if (tracks.length === 1) {
    const lead = tracks[0]!;
    const items = trackMenuItems(lead, actions, favoriteIds, playlists);
    const versions = opts.versions ?? [];
    if (versions.length > 0) {
      items.splice(1, 0, {
        label: "Lire toutes les versions",
        icon: ListMusic,
        onSelect: () => actions.playTracks([lead, ...versions]),
      });
    }
    return items;
  }

  const n = tracks.length;
  const all = tracks.slice();
  const allFav = all.every((t) => favoriteIds.has(t.id));
  return [
    { label: "Lire", icon: Play, disabled: n === 0, onSelect: () => actions.playTracks(all) },
    {
      label: "Lire ensuite",
      icon: ListStart,
      disabled: n === 0,
      onSelect: () => {
        actions.playNext(all);
        toast(`${n} titres seront lus ensuite`, { icon: ListStart });
      },
    },
    {
      label: "Ajouter à la file",
      icon: ListEnd,
      disabled: n === 0,
      onSelect: () => {
        actions.addToQueue(all);
        toast(`${n} titres ajoutés à la file`, { icon: ListEnd });
      },
    },
    "separator",
    {
      label: "Ajouter à une playlist",
      icon: ListPlus,
      disabled: n === 0,
      submenu: playlistSubmenu(
        () => actions.newPlaylist(all, `${n} titres`),
        (p) => actions.addToPlaylist(p, all),
        playlists,
      ),
    },
    {
      label: allFav ? "Retirer des favoris" : "Ajouter aux favoris",
      icon: allFav ? HeartOff : Heart,
      disabled: n === 0,
      onSelect: () => {
        const targets = allFav ? all : all.filter((t) => !favoriteIds.has(t.id));
        for (const t of targets) actions.toggleFavorite(t.id);
        toast(allFav ? `${n} titres retirés des favoris` : `${n} titres ajoutés aux favoris`, {
          icon: allFav ? HeartOff : Heart,
        });
      },
    },
  ];
}
