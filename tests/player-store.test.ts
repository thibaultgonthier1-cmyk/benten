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
