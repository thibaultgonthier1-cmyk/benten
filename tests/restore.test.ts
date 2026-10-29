import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRestoreForTests, restorePlaybackState } from "../src/renderer/runtime/restore";
import { playerStore } from "../src/renderer/state/player";
import type { AudioEngine } from "../src/renderer/audio/engine";
import type { TrackRow } from "../src/shared/types";

/**
 * Reprise de l'état de lecture au lancement (Task 14A, extraite en Phase 3 Tâche 2) : EN PAUSE,
 * ids de file re-résolus (les disparus filtrés, l'index re-mappé), état vide/corrompu → démarrage
 * propre, et idempotence (un second appel ne fait rien).
 */

const track = (id: number): TrackRow => ({
  id,
  path: `C:\\music\\${id}.flac`,
  title: `T${id}`,
  artist: "X",
  album: "Y",
  albumArtist: null,
  albumId: 1,
  trackNo: id,
  discNo: null,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 24,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  addedAtMs: null,
});

const saved = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    queueTrackIds: [1, 2, 3],
    currentIndex: 2,
    positionSec: 42.5,
    shuffle: true,
    repeat: "all",
    volume: 0.4,
    qualityMode: "economy",
    nowPlayingOpen: true,
    ...over,
  });

function fakeEngine() {
  return {
    restoreQueue: vi.fn(async () => undefined),
    play: vi.fn(),
    setQueue: vi.fn(async () => undefined),
  };
}

function stubBenten(raw: string | undefined, existing: number[]) {
  const benten = {
    state: { get: vi.fn(async () => raw) },
    library: {
      tracksByIds: vi.fn(async (ids: readonly number[]) =>
        ids.filter((id) => existing.includes(id)).map(track),
      ),
    },
  };
  vi.stubGlobal("window", { benten });
  return benten;
}

const initial = playerStore.getState();

beforeEach(() => {
  __resetRestoreForTests();
  playerStore.setState({
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    status: "idle",
    positionSec: 0,
    shuffle: false,
    repeat: "off",
    volume: 1,
    qualityMode: "balanced",
    nowPlayingOpen: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  playerStore.setState(initial, true);
});

describe("restorePlaybackState", () => {
  it("reprend EN PAUSE à la position mémorisée (jamais de lecture)", async () => {
    stubBenten(saved(), [1, 2, 3]);
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);

    expect(engine.restoreQueue).toHaveBeenCalledTimes(1);
    const [tracks, index, pos] = engine.restoreQueue.mock.calls[0] as unknown as [
      TrackRow[],
      number,
      number,
    ];
    expect(tracks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(index).toBe(2);
    expect(pos).toBe(42.5);
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.setQueue).not.toHaveBeenCalled();

    const s = playerStore.getState();
    expect(s.queue.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(s.currentIndex).toBe(2);
    expect(s.volume).toBe(0.4);
    expect(s.shuffle).toBe(true);
    expect(s.repeat).toBe("all");
    expect(s.qualityMode).toBe("economy");
    expect(s.nowPlayingOpen).toBe(true);
  });

  it("filtre les ids disparus et re-mappe l'index courant par identité", async () => {
    stubBenten(saved({ queueTrackIds: [1, 2, 3], currentIndex: 2 }), [1, 3]);
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);
    const [tracks, index] = engine.restoreQueue.mock.calls[0] as unknown as [TrackRow[], number];
    expect(tracks.map((t) => t.id)).toEqual([1, 3]);
    expect(index).toBe(1); // l'id 3 est maintenant à l'index 1
    expect(playerStore.getState().currentTrack?.id).toBe(3);
  });

  it("piste courante disparue → index borné à ce qui reste", async () => {
    stubBenten(saved({ queueTrackIds: [1, 2, 3], currentIndex: 2 }), [1]);
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);
    const [tracks, index] = engine.restoreQueue.mock.calls[0] as unknown as [TrackRow[], number];
    expect(tracks.map((t) => t.id)).toEqual([1]);
    expect(index).toBe(0);
  });

  it("tous les ids disparus → file vide, démarrage propre (préférences appliquées)", async () => {
    stubBenten(saved(), []);
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);
    expect(engine.restoreQueue).not.toHaveBeenCalled();
    expect(playerStore.getState().queue).toEqual([]);
    expect(playerStore.getState().volume).toBe(0.4);
  });

  it("file sauvée vide → préférences seules, aucune re-résolution", async () => {
    const benten = stubBenten(saved({ queueTrackIds: [], currentIndex: -1 }), []);
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);
    expect(benten.library.tracksByIds).not.toHaveBeenCalled();
    expect(engine.restoreQueue).not.toHaveBeenCalled();
    expect(playerStore.getState().repeat).toBe("all");
  });

  it.each([
    ["absent", undefined],
    ["vide", ""],
    ["corrompu", "{bad"],
    ["mal typé", JSON.stringify({ queueTrackIds: "nope" })],
  ])("état %s → défauts propres, rien n'est touché", async (_label, raw) => {
    const benten = stubBenten(raw, [1, 2, 3]);
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);
    expect(benten.library.tracksByIds).not.toHaveBeenCalled();
    expect(engine.restoreQueue).not.toHaveBeenCalled();
    expect(playerStore.getState().volume).toBe(1);
    expect(playerStore.getState().queue).toEqual([]);
  });

  it("lecture de l'état en échec → démarrage propre", async () => {
    const benten = stubBenten(saved(), [1, 2, 3]);
    benten.state.get.mockRejectedValueOnce(new Error("ipc"));
    const engine = fakeEngine();
    await restorePlaybackState(engine as unknown as AudioEngine);
    expect(engine.restoreQueue).not.toHaveBeenCalled();
  });

  it("idempotent : un second appel est un no-op", async () => {
    const benten = stubBenten(saved(), [1, 2, 3]);
    const engine = fakeEngine();
    await Promise.all([
      restorePlaybackState(engine as unknown as AudioEngine),
      restorePlaybackState(engine as unknown as AudioEngine),
    ]);
    await restorePlaybackState(engine as unknown as AudioEngine);
    expect(benten.state.get).toHaveBeenCalledTimes(1);
    expect(engine.restoreQueue).toHaveBeenCalledTimes(1);
  });
});
