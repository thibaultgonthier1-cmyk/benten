import type React from "react";
import { useMemo } from "react";
import { CircleAlert, ListPlus } from "lucide-react";
import type { Album } from "../lib/library";
import type { TrackRow } from "../../shared/types";
import type { RouteViewActions } from "../shell/RouteView";
import {
  albumMenuItems,
  selectionMenuItems,
  trackMenuItems,
  type AlbumMenuActions,
  type PlaylistTarget,
  type SelectionMenuActions,
  type TrackMenuActions,
} from "../shell/albumMenu";
import { openMenu } from "../ui/menuStore";
import { quoted, toast } from "../ui/toastStore";
import { playerStore } from "../state/player";
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

/** Playlists existantes (récentes d'abord) ; liste vide si l'IPC échoue ou est absente. */
async function listPlaylists(): Promise<PlaylistTarget[]> {
  try {
    const rows = (await window.benten?.playlists.list()) ?? [];
    return rows.map((r) => ({ id: r.id, name: r.name }));
  } catch {
    return [];
  }
}

/** Ajoute des pistes à une playlist existante, puis confirme (ou signale l'échec) par un toast. */
export async function addTracksToPlaylist(playlist: PlaylistTarget, tracks: readonly TrackRow[]): Promise<void> {
  const name = quoted(playlist.name);
  try {
    await window.benten.playlists.add(
      playlist.id,
      tracks.map((t) => t.id),
    );
    toast(
      tracks.length > 1 ? `${tracks.length} titres ajoutés à ${name}` : `Ajouté à ${name}`,
      { icon: ListPlus },
    );
  } catch {
    toast(`Impossible d'ajouter à ${name}`, { icon: CircleAlert });
  }
}

export interface ViewMenus {
  openAlbumMenu(album: Album, anchor: MenuAnchor): Promise<void>;
  /** `play` : lecture du titre dans son contexte (l'album, une liste…). */
  openTrackMenu(
    track: TrackRow,
    anchor: MenuAnchor,
    play: (track: TrackRow) => void,
    opts?: { hideAlbumLink?: boolean },
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
    const albumActions: AlbumMenuActions = {
      playAlbum: (album) => actions.playAlbumInOrder(album),
      albumPlayNext: actions.albumPlayNext,
      albumAddToQueue: actions.albumAddToQueue,
      albumAddToPlaylist: actions.albumAddToPlaylist,
      addToPlaylist: (p, tracks) => void addTracksToPlaylist(p, tracks),
      toggleFavorite: (id) => playerStore.getState().toggleFavorite(id),
      goToArtist: (artist) => uiStore.getState().navigate({ name: "artist", artist }),
    };
    return {
      async openAlbumMenu(album, anchor) {
        const playlists = await listPlaylists();
        const items = albumMenuItems(album, albumActions, playerStore.getState().favoriteIds, playlists);
        openMenu(anchor.x, anchor.y, items, { focusFirst: anchor.focusFirst });
      },
      async openTrackMenu(track, anchor, play, opts) {
        const trackActions: TrackMenuActions = {
          play,
          playNext: (tracks) => playerStore.getState().playNext(tracks),
          addToQueue: (tracks) => playerStore.getState().addToQueue(tracks),
          newPlaylist: (tracks, label) => actions.openPlaylistSheet(tracks.map((t) => t.id), label),
          addToPlaylist: (p, tracks) => void addTracksToPlaylist(p, tracks),
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
          newPlaylist: (t, label) => actions.openPlaylistSheet(t.map((x) => x.id), label),
          addToPlaylist: (p, t) => void addTracksToPlaylist(p, t),
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
