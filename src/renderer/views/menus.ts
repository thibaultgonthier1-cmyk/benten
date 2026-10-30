import type React from "react";
import { useMemo } from "react";
import { ListPlus } from "lucide-react";
import type { Album } from "../lib/library";
import type { TrackRow } from "../../shared/types";
import type { RouteViewActions } from "../shell/RouteView";
import {
  albumMenuItems,
  playlistSubmenu,
  selectionMenuItems,
  trackMenuItems,
  type AlbumMenuActions,
  type PlaylistTarget,
  type SelectionMenuActions,
  type TrackMenuActions,
} from "../shell/albumMenu";
import { openMenu, type MenuItem } from "../ui/menuStore";
import { playerStore } from "../state/player";
import { playlistsStore } from "../state/playlists";
import { addToPlaylist, openNewPlaylist } from "./playlistActions";
import { uiStore } from "../state/ui";

/** Point d'ouverture d'un menu (coordonnées client) ; `focusFirst` pour une ouverture clavier. */
export interface MenuAnchor {
  x: number;
  y: number;
  focusFirst: boolean;
}

/**
 * Ancre d'un clic droit : au curseur. Touche Menu / Maj+F10 (bouton ≠ 2) : au centre de
 * l'élément, focus sur la 1re entrée. À appeler DANS le gestionnaire (currentTarget est remis à
 * `null` après l'événement).
 */
export function anchorFromEvent(e: React.MouseEvent<HTMLElement>): MenuAnchor {
  if (e.button === 2) return { x: e.clientX, y: e.clientY, focusFirst: false };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, r.width / 2), focusFirst: true };
}

/** Ancre sous un bouton (menu « ⋯ », sélecteur de tri) ; focus clavier si activé au clavier. */
export function anchorBelow(e: React.MouseEvent<HTMLElement>): MenuAnchor {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 6, focusFirst: e.detail === 0 };
}

/** Playlists existantes, modifiées récemment d'abord (store des playlists, chargé au besoin). */
async function listPlaylists(): Promise<PlaylistTarget[]> {
  const store = playlistsStore.getState();
  if (!store.loaded) await store.refresh();
  return playlistsStore.getState().rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Point de départ du vol de la pochette : l'endroit où le menu a été ouvert. */
const originOf = (anchor: MenuAnchor): { x: number; y: number } => ({ x: anchor.x, y: anchor.y });

/**
 * Entrée « Ajouter à une playlist ▸ » pour des titres quelconques (menus « ⋯ » des pages) :
 * « Nouvelle playlist… » puis les playlists existantes.
 */
export async function playlistMenuItem(
  tracks: readonly TrackRow[],
  anchor: MenuAnchor,
  opts: { disabled?: boolean } = {},
): Promise<MenuItem> {
  const playlists = await listPlaylists();
  return {
    label: "Ajouter à une playlist",
    icon: ListPlus,
    disabled: opts.disabled ?? tracks.length === 0,
    submenu: playlistSubmenu(
      () => openNewPlaylist(tracks, originOf(anchor)),
      (p) => void addToPlaylist(p, tracks, { origin: originOf(anchor) }),
      playlists,
    ),
  };
}

export interface ViewMenus {
  openAlbumMenu(album: Album, anchor: MenuAnchor): Promise<void>;
  /** `play` : lecture du titre dans son contexte (l'album, une liste…). */
  openTrackMenu(
    track: TrackRow,
    anchor: MenuAnchor,
    play: (track: TrackRow) => void,
    opts?: { hideAlbumLink?: boolean; extra?: readonly MenuItem[] },
  ): Promise<void>;
  /**
   * Menu d'une sélection de titres (vue Titres) : `play` lit un titre dans son contexte (la liste
   * affichée), `playTracks` lit exactement des titres donnés ; `versions` ajoute « Lire toutes les
   * versions » à un morceau regroupé.
   */
  openSelectionMenu(
    tracks: readonly TrackRow[],
    anchor: MenuAnchor,
    play: (track: TrackRow) => void,
    playTracks: (tracks: readonly TrackRow[]) => void,
    opts?: { versions?: readonly TrackRow[] },
  ): Promise<void>;
}

/**
 * Ouvreurs de menus contextuels des vues (tuile d'album, ligne de titre), câblés sur les actions
 * existantes de l'App et des stores. La liste des playlists est relue à chaque ouverture (le
 * sous-menu « Ajouter à une playlist ▸ » est toujours à jour) ; les favoris sont lus à l'ouverture.
 */
export function useViewMenus(actions: RouteViewActions): ViewMenus {
  return useMemo<ViewMenus>(() => {
    const albumActions = (anchor: MenuAnchor): AlbumMenuActions => ({
      playAlbum: (album) => actions.playAlbumInOrder(album),
      albumPlayNext: actions.albumPlayNext,
      albumAddToQueue: actions.albumAddToQueue,
      albumAddToPlaylist: (album) => openNewPlaylist(album.tracks, originOf(anchor)),
      addToPlaylist: (p, tracks) => void addToPlaylist(p, tracks, { origin: originOf(anchor) }),
      toggleFavorite: (id) => playerStore.getState().toggleFavorite(id),
      goToArtist: (artist) => uiStore.getState().navigate({ name: "artist", artist }),
    });
    return {
      async openAlbumMenu(album, anchor) {
        const playlists = await listPlaylists();
        const items = albumMenuItems(album, albumActions(anchor), playerStore.getState().favoriteIds, playlists);
        openMenu(anchor.x, anchor.y, items, { focusFirst: anchor.focusFirst });
      },
      async openTrackMenu(track, anchor, play, opts) {
        const trackActions: TrackMenuActions = {
          play,
          playNext: (tracks) => playerStore.getState().playNext(tracks),
          addToQueue: (tracks) => playerStore.getState().addToQueue(tracks),
          newPlaylist: (tracks) => openNewPlaylist(tracks, originOf(anchor)),
          addToPlaylist: (p, tracks) => void addToPlaylist(p, tracks, { origin: originOf(anchor) }),
          toggleFavorite: (id) => playerStore.getState().toggleFavorite(id),
          goToAlbum: (albumId) => uiStore.getState().navigate({ name: "album", id: albumId }),
          goToArtist: (artist) => uiStore.getState().navigate({ name: "artist", artist }),
        };
        const playlists = await listPlaylists();
        const items = trackMenuItems(track, trackActions, playerStore.getState().favoriteIds, playlists, opts);
        openMenu(anchor.x, anchor.y, items, { focusFirst: anchor.focusFirst });
      },
      async openSelectionMenu(tracks, anchor, play, playTracks, opts) {
        const selActions: SelectionMenuActions = {
          play,
          playTracks,
          playNext: (t) => playerStore.getState().playNext(t),
          addToQueue: (t) => playerStore.getState().addToQueue(t),
          newPlaylist: (t) => openNewPlaylist(t, originOf(anchor)),
          addToPlaylist: (p, t) => void addToPlaylist(p, t, { origin: originOf(anchor) }),
          toggleFavorite: (id) => playerStore.getState().toggleFavorite(id),
          goToAlbum: (albumId) => uiStore.getState().navigate({ name: "album", id: albumId }),
          goToArtist: (artist) => uiStore.getState().navigate({ name: "artist", artist }),
        };
        const playlists = await listPlaylists();
        const items = selectionMenuItems(tracks, selActions, playerStore.getState().favoriteIds, playlists, opts);
        openMenu(anchor.x, anchor.y, items, { focusFirst: anchor.focusFirst });
      },
    };
  }, [actions]);
}
