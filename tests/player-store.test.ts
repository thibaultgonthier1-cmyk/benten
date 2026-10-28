import { describe, expect, it, vi } from "vitest";
import { createPlayerStore, bindEngine } from "../src/renderer/state/player";
import type { PlaybackState } from "../src/renderer/audio/engine";
import type { TrackRow } from "../src/shared/types";

/**
 * Logique du store de lecture testee en PUR, hors React : on manipule le store vanilla
 * (`getState()`/actions) et on simule les evenements du moteur avec un faux emetteur.
 *
 * Invariants vises :
 *  - `setQueue` puis `next` mettent a jour `currentIndex` ET `currentTrack` ;
 *  - un evenement moteur de position (statechange) met a jour `positionSec`.
 */

const track = (over: Partial<TrackRow> = {}): TrackRow => ({
  id: 1,
  path: "C:\\music\\a.flac",
  title: "A",
  artist: "X",
  album: "Y",
  albumArtist: null,
  albumId: 1,
  trackNo: 1,
  discNo: null,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 24,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  ...over,
});

/** Faux moteur minimal : enregistre les abonnes et permet de leur emettre un etat. */
function fakeEngine() {
  const listeners: Record<string, Set<(p: unknown) => void>> = {};
  return {
    on(event: string, cb: (p: unknown) => void): () => void {
      (listeners[event] ??= new Set()).add(cb);
      return () => listeners[event]!.delete(cb);
    },
    emit(event: string, payload: unknown): void {
      for (const cb of listeners[event] ?? []) cb(payload);
    },
  };
}

describe("player store — logique pure", () => {
  it("setQueue fixe la file, currentIndex et currentTrack", () => {
    const store = createPlayerStore();
    const t0 = track({ id: 10, title: "Zero" });
    const t1 = track({ id: 11, title: "One" });
    const t2 = track({ id: 12, title: "Two" });

    store.getState().setQueue([t0, t1, t2], 0);

    expect(store.getState().queue).toHaveLength(3);
    expect(store.getState().currentIndex).toBe(0);
    expect(store.getState().currentTrack).toMatchObject({ id: 10, title: "Zero" });
  });

  it("setQueue + next met a jour currentIndex et currentTrack", () => {
    const store = createPlayerStore();
    const t0 = track({ id: 10, title: "Zero" });
    const t1 = track({ id: 11, title: "One" });
    const t2 = track({ id: 12, title: "Two" });

    store.getState().setQueue([t0, t1, t2], 0);
    store.getState().next();

    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().currentTrack).toMatchObject({ id: 11, title: "One" });
  });

  it("next ne depasse pas la fin de la file", () => {
    const store = createPlayerStore();
    const t0 = track({ id: 10 });
    const t1 = track({ id: 11 });
    store.getState().setQueue([t0, t1], 1);
    store.getState().next();
    expect(store.getState().currentIndex).toBe(1);
    expect(store.getState().currentTrack).toMatchObject({ id: 11 });
  });

  it("prev recule d'un index", () => {
    const store = createPlayerStore();
    const t0 = track({ id: 10 });
    const t1 = track({ id: 11 });
    store.getState().setQueue([t0, t1], 1);
    store.getState().prev();
    expect(store.getState().currentIndex).toBe(0);
    expect(store.getState().currentTrack).toMatchObject({ id: 10 });
  });

  it("un evenement moteur (statechange) met a jour positionSec, status et durationSec", () => {
    const store = createPlayerStore();
    const engine = fakeEngine();
    const unbind = bindEngine(store, engine as never);

    const state: PlaybackState = {
      status: "playing",
      positionSec: 42.5,
      durationSec: 200,
      trackId: null,
    };
    engine.emit("statechange", state);

    expect(store.getState().positionSec).toBeCloseTo(42.5, 5);
    expect(store.getState().status).toBe("playing");
    expect(store.getState().durationSec).toBe(200);

    unbind();
    // Apres desabonnement, un nouvel evenement n'affecte plus le store.
    engine.emit("statechange", { ...state, positionSec: 99 });
    expect(store.getState().positionSec).toBeCloseTo(42.5, 5);
  });

  it("statechange reconcilie currentIndex/currentTrack a partir du trackId du moteur (gapless)", () => {
    const store = createPlayerStore();
    const engine = fakeEngine();
    bindEngine(store, engine as never);
    const t0 = track({ id: 10 });
    const t1 = track({ id: 11 });
    const t2 = track({ id: 12 });
    store.getState().setQueue([t0, t1, t2], 0);

    // Le moteur a enchaine (gapless) sur la piste d'id 12 : le store suit.
    engine.emit("statechange", {
      status: "playing",
      positionSec: 0,
      durationSec: 180,
      trackId: 12,
    } satisfies PlaybackState);

    expect(store.getState().currentIndex).toBe(2);
    expect(store.getState().currentTrack).toMatchObject({ id: 12 });
  });

  it("setPosition met a jour positionSec (boucle rAF)", () => {
    const store = createPlayerStore();
    store.getState().setPosition(12.75, 240);
    expect(store.getState().positionSec).toBeCloseTo(12.75, 5);
    expect(store.getState().durationSec).toBe(240);
  });

  it("favoriteIds est un Set vide au depart", () => {
    const store = createPlayerStore();
    expect(store.getState().favoriteIds).toBeInstanceOf(Set);
    expect(store.getState().favoriteIds.size).toBe(0);
  });

  it("toggleFavorite bascule l'appartenance a favoriteIds (sans window.benten en env node)", () => {
    const store = createPlayerStore();
    // Ajout optimiste.
    store.getState().toggleFavorite(42);
    expect(store.getState().favoriteIds.has(42)).toBe(true);
    // Un second toggle retire l'id.
    store.getState().toggleFavorite(42);
    expect(store.getState().favoriteIds.has(42)).toBe(false);
    // Plusieurs ids coexistent et le Set precedent n'est pas mute (nouvelle reference).
    const before = store.getState().favoriteIds;
    store.getState().toggleFavorite(7);
    store.getState().toggleFavorite(9);
    expect(store.getState().favoriteIds.has(7)).toBe(true);
    expect(store.getState().favoriteIds.has(9)).toBe(true);
    expect(before.has(7)).toBe(false);
  });
});

/**
 * Mutations de file A CHAUD (Task 11). Le store met a jour sa file ET pilote le moteur : les
 * editions FUTURES passent par `engine.updateQueue(nextQueue, {keepCurrent:true})` (le moteur ne
 * coupe jamais la courante si son id reste present) ; `jumpTo` passe par `engine.jumpTo` (saut
 * anti-clic manuel). On injecte un moteur-bouchon qui enregistre les appels (store teste en node).
 */
function queueEngineStub() {
  const calls = {
    update: [] as Array<{ tracks: readonly TrackRow[]; opts?: { keepCurrent?: boolean } }>,
    jumps: [] as number[],
  };
  return {
    calls,
    updateQueue(tracks: readonly TrackRow[], opts?: { keepCurrent?: boolean }): void {
      calls.update.push({ tracks, opts });
    },
    jumpTo(index: number): void {
      calls.jumps.push(index);
    },
  };
}

describe("player store — mutations de file (Task 11)", () => {
  const setup = () => {
    const store = createPlayerStore();
    const eng = queueEngineStub();
    store.getState().attachEngine(eng as never);
    // File [10, 11, 12], courante = id 11 (index 1).
    store.getState().setQueue([track({ id: 10 }), track({ id: 11 }), track({ id: 12 })], 1);
    return { store, eng };
  };

  it("playNext insere juste apres currentIndex sans changer la piste courante", () => {
    const { store, eng } = setup();
    store.getState().playNext([track({ id: 99, title: "X" })]);
    const s = store.getState();
    expect(s.queue.map((t) => t.id)).toEqual([10, 11, 99, 12]);
    expect(s.currentIndex).toBe(1);
    expect(s.currentTrack).toMatchObject({ id: 11 });
    const last = eng.calls.update.at(-1)!;
    expect(last.opts).toEqual({ keepCurrent: true });
    expect(last.tracks.map((t) => t.id)).toEqual([10, 11, 99, 12]);
  });

  it("addToQueue ajoute en fin de file sans changer la piste courante", () => {
    const { store, eng } = setup();
    store.getState().addToQueue([track({ id: 77 })]);
    const s = store.getState();
    expect(s.queue.map((t) => t.id)).toEqual([10, 11, 12, 77]);
    expect(s.currentIndex).toBe(1);
    expect(s.currentTrack).toMatchObject({ id: 11 });
    expect(eng.calls.update.at(-1)!.tracks.map((t) => t.id)).toEqual([10, 11, 12, 77]);
  });

  it("removeFromQueue d'une piste FUTURE ajuste la liste et conserve la courante", () => {
    const { store, eng } = setup();
    store.getState().removeFromQueue(2); // retire id 12 (apres la courante)
    const s = store.getState();
    expect(s.queue.map((t) => t.id)).toEqual([10, 11]);
    expect(s.currentIndex).toBe(1);
    expect(s.currentTrack).toMatchObject({ id: 11 });
    expect(eng.calls.update.at(-1)!.opts).toEqual({ keepCurrent: true });
  });

  it("removeFromQueue d'une piste PASSEE decale currentIndex mais conserve la courante", () => {
    const { store } = setup();
    store.getState().removeFromQueue(0); // retire id 10 (avant la courante)
    const s = store.getState();
    expect(s.queue.map((t) => t.id)).toEqual([11, 12]);
    expect(s.currentIndex).toBe(0);
    expect(s.currentTrack).toMatchObject({ id: 11 });
  });

  it("moveInQueue reordonne et conserve la piste courante (index recale sur son id)", () => {
    const { store } = setup();
    store.getState().moveInQueue(0, 2); // deplace id 10 en fin : [11, 12, 10]
    const s = store.getState();
    expect(s.queue.map((t) => t.id)).toEqual([11, 12, 10]);
    expect(s.currentIndex).toBe(0); // id 11 est maintenant en tete
    expect(s.currentTrack).toMatchObject({ id: 11 });
  });

  it("jumpTo change la piste courante et pilote le moteur (saut anti-clic)", () => {
    const { store, eng } = setup();
    store.getState().jumpTo(2);
    const s = store.getState();
    expect(s.currentIndex).toBe(2);
    expect(s.currentTrack).toMatchObject({ id: 12 });
    expect(eng.calls.jumps.at(-1)).toBe(2);
  });

  it("setQueueOpen bascule l'ouverture du panneau de file", () => {
    const store = createPlayerStore();
    expect(store.getState().queueOpen).toBe(false);
    store.getState().setQueueOpen(true);
    expect(store.getState().queueOpen).toBe(true);
  });
});
