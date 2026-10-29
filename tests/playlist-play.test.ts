import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYLIST_ALBUM_ID, playPlaylist, shufflePlaylist } from "../src/renderer/views/playlistPlay";
import { playerStore } from "../src/renderer/state/player";
import type { RouteViewActions } from "../src/renderer/shell/RouteView";
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

afterEach(() => {
  playerStore.setState({ queue: [], currentIndex: -1, currentTrack: null, status: "idle", shuffle: false });
});

describe("playPlaylist / shufflePlaylist", () => {
  it("autre file : lit la playlist dans l'ordre (album éphémère), mélange coupé", () => {
    playerStore.getState().setQueue([track(9)], 0);
    playerStore.setState({ status: "playing", shuffle: true });
    const a = fakeActions();
    playPlaylist("Nuit", list, a);
    expect(a.playAlbumInOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: PLAYLIST_ALBUM_ID, title: "Nuit", tracks: list }),
    );
    expect(playerStore.getState().shuffle).toBe(false);
  });

  it("sa propre file, en pause et mélangée : reprend et coupe le mélange", () => {
    playerStore.getState().setQueue(list, 1);
    playerStore.setState({ status: "paused", shuffle: true });
    const a = fakeActions();
    playPlaylist("Nuit", list, a);
    expect(a.togglePlay).toHaveBeenCalledTimes(1);
    expect(a.playAlbumInOrder).not.toHaveBeenCalled();
    expect(playerStore.getState().shuffle).toBe(false);
  });

  it("Aléatoire passe par shuffleAlbum ; playlist vide : rien", () => {
    const a = fakeActions();
    shufflePlaylist("Nuit", list, a);
    expect(a.shuffleAlbum).toHaveBeenCalledWith(expect.objectContaining({ id: PLAYLIST_ALBUM_ID, tracks: list }));
    playPlaylist("Vide", [], a);
    shufflePlaylist("Vide", [], a);
    expect(a.playAlbumInOrder).not.toHaveBeenCalled();
    expect(a.shuffleAlbum).toHaveBeenCalledTimes(1);
  });
});
