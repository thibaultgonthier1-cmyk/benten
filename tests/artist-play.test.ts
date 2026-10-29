import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedArtistPage, cachedArtistQueue, playArtist, shuffleArtist } from "../src/renderer/views/artistPlay";
import type { Album } from "../src/renderer/lib/library";
import { playerStore } from "../src/renderer/state/player";
import type { RouteViewActions } from "../src/renderer/shell/RouteView";
import type { TrackRow } from "../src/shared/types";

const track = (id: number): TrackRow => ({
  id,
  path: `C:/m/${id}.flac`,
  title: `t${id}`,
  artist: "Ridsa",
  album: "Al",
  albumArtist: null,
  albumId: id,
  trackNo: 1,
  discNo: null,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 16,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  addedAtMs: null,
});

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

describe("playArtist (Lecture d'en-tête / de tuile)", () => {
  it("file en cours = celle de l'artiste, en pause et mélangée : reprend ET coupe le mélange", () => {
    playerStore.getState().setQueue(list, 1);
    playerStore.setState({ status: "paused", shuffle: true });
    const a = fakeActions();
    playArtist("Ridsa", list, a);
    expect(a.togglePlay).toHaveBeenCalledTimes(1);
    expect(a.playAlbumInOrder).not.toHaveBeenCalled();
    expect(playerStore.getState().shuffle).toBe(false);
  });

  it("file en cours = celle de l'artiste, en lecture : met en pause (le bouton affiche Pause)", () => {
    playerStore.getState().setQueue(list, 0);
    playerStore.setState({ status: "playing", shuffle: false });
    const a = fakeActions();
    playArtist("Ridsa", list, a);
    expect(a.togglePlay).toHaveBeenCalledTimes(1);
  });

  it("autre file : lit l'artiste dans l'ordre, mélange coupé", () => {
    playerStore.getState().setQueue([track(9)], 0);
    playerStore.setState({ status: "playing", shuffle: true });
    const a = fakeActions();
    playArtist("Ridsa", list, a);
    expect(a.togglePlay).not.toHaveBeenCalled();
    expect(a.playAlbumInOrder).toHaveBeenCalledTimes(1);
    expect(a.playAlbumInOrder).toHaveBeenCalledWith(expect.objectContaining({ tracks: list }));
    expect(playerStore.getState().shuffle).toBe(false);
  });

  it("en lecture + mélangé : Pause garde le mélange (seule une reprise / nouvelle lecture le coupe)", () => {
    playerStore.getState().setQueue(list, 0);
    playerStore.setState({ status: "playing", shuffle: true });
    const a = fakeActions();
    playArtist("Ridsa", list, a);
    expect(a.togglePlay).toHaveBeenCalledTimes(1);
    expect(playerStore.getState().shuffle).toBe(true);
  });

  it("Aléatoire passe par shuffleAlbum (qui active le mélange)", () => {
    const a = fakeActions();
    shuffleArtist("Ridsa", list, a);
    expect(a.shuffleAlbum).toHaveBeenCalledTimes(1);
  });
});

describe("cache des pages / files d'artiste", () => {
  const albums: Album[] = [
    { id: 1, title: "Solo", artist: "Ridsa", artKey: null, tracks: [track(1), track(2)] },
    { id: 2, title: "Autre", artist: "Dadju", artKey: null, tracks: [{ ...track(3), artist: "Dadju" }] },
  ];

  it("mêmes entrées (liste d'albums, nom replié) → même résultat, sans recalcul", () => {
    const p1 = cachedArtistPage(albums, "Ridsa");
    expect(cachedArtistPage(albums, "RIDSA")).toBe(p1);
    expect(p1.tracks.map((t) => t.id)).toEqual([1, 2]);
    const q1 = cachedArtistQueue(albums, true, "Ridsa");
    expect(cachedArtistQueue(albums, true, "ridsa")).toBe(q1);
    // Autre réglage de regroupement ou autre bibliothèque : autre entrée de cache.
    expect(cachedArtistQueue(albums, false, "Ridsa")).not.toBe(q1);
    expect(cachedArtistPage(albums.slice(), "Ridsa")).not.toBe(p1);
  });
});
