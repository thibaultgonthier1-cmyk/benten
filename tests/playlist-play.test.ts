import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAYLIST_ALBUM_ID,
  playlistOwnsQueue,
  playPlaylist,
  playPlaylistAt,
  shufflePlaylist,
} from "../src/renderer/views/playlistPlay";
import { playerStore } from "../src/renderer/state/player";
import type { RouteViewActions } from "../src/renderer/shell/RouteView";
import type { Album } from "../src/renderer/lib/library";
import { track } from "./helpers/playlists";

/** Lecture d'une playlist : « Lecture » coupe le mélange, « Aléatoire » l'active (chemins existants). */

const fakeActions = (): RouteViewActions & Record<string, ReturnType<typeof vi.fn>> =>
  ({
    playAlbum: vi.fn(),
    playAlbumInOrder: vi.fn(),
    shuffleAlbum: vi.fn(),
    togglePlay: vi.fn(),
    albumPlayNext: vi.fn(),
    albumAddToQueue: vi.fn(),
  }) as unknown as RouteViewActions & Record<string, ReturnType<typeof vi.fn>>;

const list = [track(1), track(2), track(3)];
const NUIT = { id: 7, name: "Nuit" };
const VIDE = { id: 8, name: "Vide" };

/** Les actions de l'App posent la file du lecteur (comme `controls.playAlbum`). */
function wired() {
  const setQ = (al: Album, i = 0): void => playerStore.getState().setQueue(al.tracks, i);
  const a = {
    playAlbum: vi.fn((al: Album, i?: number) => setQ(al, i)),
    playAlbumInOrder: vi.fn((al: Album) => setQ(al)),
    shuffleAlbum: vi.fn((al: Album) => setQ(al)),
    togglePlay: vi.fn(),
    albumPlayNext: vi.fn(),
    albumAddToQueue: vi.fn(),
  };
  return a;
}

afterEach(() => {
  playerStore.setState({ queue: [], currentIndex: -1, currentTrack: null, status: "idle", shuffle: false });
});

describe("playPlaylist / shufflePlaylist", () => {
  it("autre file : lit la playlist dans l'ordre (album éphémère), mélange coupé", () => {
    playerStore.getState().setQueue([track(9)], 0);
    playerStore.setState({ status: "playing", shuffle: true });
    const a = fakeActions();
    playPlaylist(NUIT, list, a);
    expect(a.playAlbumInOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: PLAYLIST_ALBUM_ID, title: "Nuit", tracks: list }),
    );
    expect(playerStore.getState().shuffle).toBe(false);
  });

  it("sa propre file, en pause et mélangée : reprend et coupe le mélange", () => {
    playerStore.getState().setQueue(list, 1);
    playerStore.setState({ status: "paused", shuffle: true });
    const a = fakeActions();
    playPlaylist(NUIT, list, a);
    expect(a.togglePlay).toHaveBeenCalledTimes(1);
    expect(a.playAlbumInOrder).not.toHaveBeenCalled();
    expect(playerStore.getState().shuffle).toBe(false);
  });

  it("file reconnue par l'id de playlist : après le retrait du titre en cours, Lecture REPREND", () => {
    const a = wired();
    playPlaylist(NUIT, list, a);
    expect(playlistOwnsQueue(NUIT.id)).toBe(true);
    expect(playlistOwnsQueue(VIDE.id)).toBe(false);
    playerStore.setState({ status: "paused" });
    // Le titre 1 (en cours) a été retiré de la playlist : la liste ne correspond plus à la file.
    playPlaylist(NUIT, [track(2), track(3)], a);
    expect(a.togglePlay).toHaveBeenCalledTimes(1);
    expect(a.playAlbumInOrder).toHaveBeenCalledTimes(1);
    // Une autre file remplace la sienne : la playlist ne la possède plus.
    playerStore.getState().setQueue([track(9)], 0);
    expect(playlistOwnsQueue(NUIT.id)).toBe(false);
  });

  it("lecture d'une ligne et Aléatoire marquent aussi la file comme celle de la playlist", () => {
    const a = wired();
    playPlaylistAt(NUIT, list, 2, a);
    expect(a.playAlbum).toHaveBeenCalledWith(expect.objectContaining({ id: PLAYLIST_ALBUM_ID }), 2);
    expect(playlistOwnsQueue(NUIT.id)).toBe(true);
    shufflePlaylist(VIDE, list, a);
    expect(playlistOwnsQueue(VIDE.id)).toBe(true);
    expect(playlistOwnsQueue(NUIT.id)).toBe(false);
  });

  it("Aléatoire passe par shuffleAlbum ; playlist vide : rien", () => {
    const a = fakeActions();
    shufflePlaylist(NUIT, list, a);
    expect(a.shuffleAlbum).toHaveBeenCalledWith(expect.objectContaining({ id: PLAYLIST_ALBUM_ID, tracks: list }));
    playPlaylist(VIDE, [], a);
    shufflePlaylist(VIDE, [], a);
    expect(a.playAlbumInOrder).not.toHaveBeenCalled();
    expect(a.shuffleAlbum).toHaveBeenCalledTimes(1);
  });
});
