import { describe, expect, it } from "vitest";
import {
  restoreState,
  serializeState,
  type PersistedState,
  type StateSnapshot,
} from "../src/renderer/lib/persist";
import type { TrackRow } from "../src/shared/types";

/**
 * `persist` est PUR (aucune dependance React / Web Audio / window) : on teste le round-trip
 * serialize -> JSON -> restore, et surtout la ROBUSTESSE de `restoreState` face a du JSON
 * corrompu ou a des champs de mauvais type / hors bornes (jamais d'exception, jamais de valeur
 * aberrante : soit `null`, soit un etat assaini).
 */

const trackIsh = (id: number): Pick<TrackRow, "id"> => ({ id });

const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  queue: [trackIsh(10), trackIsh(11), trackIsh(12)],
  currentIndex: 1,
  positionSec: 42.5,
  shuffle: true,
  repeat: "all",
  volume: 0.8,
  qualityMode: "economy",
  nowPlayingOpen: true,
  ...over,
});

describe("persist — serializeState / restoreState", () => {
  it("round-trips every field through JSON (serialize -> stringify -> restore)", () => {
    const snap = snapshot();
    const ser = serializeState(snap);
    expect(ser.queueTrackIds).toEqual([10, 11, 12]);
    const restored = restoreState(JSON.stringify(ser));
    expect(restored).not.toBeNull();
    const r = restored as PersistedState;
    expect(r.queueTrackIds).toEqual([10, 11, 12]);
    expect(r.currentIndex).toBe(1);
    expect(r.positionSec).toBe(42.5);
    expect(r.shuffle).toBe(true);
    expect(r.repeat).toBe("all");
    expect(r.volume).toBe(0.8);
    expect(r.qualityMode).toBe("economy");
    expect(r.nowPlayingOpen).toBe(true);
  });

  it("round-trips the full set of enum values", () => {
    for (const repeat of ["off", "all", "one"] as const) {
      for (const qualityMode of ["max", "balanced", "economy"] as const) {
        const r = restoreState(JSON.stringify(serializeState(snapshot({ repeat, qualityMode }))));
        expect(r).not.toBeNull();
        expect((r as PersistedState).repeat).toBe(repeat);
        expect((r as PersistedState).qualityMode).toBe(qualityMode);
      }
    }
  });

  it("serializes an empty queue to an empty id list with currentIndex -1", () => {
    const ser = serializeState(snapshot({ queue: [], currentIndex: -1 }));
    expect(ser.queueTrackIds).toEqual([]);
    const r = restoreState(JSON.stringify(ser));
    expect(r).not.toBeNull();
    expect((r as PersistedState).currentIndex).toBe(-1);
  });

  it("returns null for malformed JSON (never throws)", () => {
    expect(restoreState("{bad json")).toBeNull();
    expect(restoreState("")).toBeNull();
    expect(restoreState("null")).toBeNull();
    expect(restoreState("42")).toBeNull();
    expect(restoreState("[1,2,3]")).toBeNull();
    expect(restoreState('"a string"')).toBeNull();
  });

  it("returns null for the garbage object from the brief (bad types, never throws)", () => {
    expect(() =>
      restoreState('{"positionSec":"x","volume":5,"repeat":"nope"}'),
    ).not.toThrow();
    expect(restoreState('{"positionSec":"x","volume":5,"repeat":"nope"}')).toBeNull();
  });

  it("rejects wrong types for each field (returns null)", () => {
    const base = serializeState(snapshot());
    const bad = (patch: Record<string, unknown>): string =>
      JSON.stringify({ ...base, ...patch });
    expect(restoreState(bad({ queueTrackIds: "nope" }))).toBeNull();
    expect(restoreState(bad({ currentIndex: "1" }))).toBeNull();
    expect(restoreState(bad({ currentIndex: 1.5 }))).toBeNull();
    expect(restoreState(bad({ positionSec: "x" }))).toBeNull();
    expect(restoreState(bad({ positionSec: null }))).toBeNull();
    expect(restoreState(bad({ shuffle: "true" }))).toBeNull();
    expect(restoreState(bad({ repeat: "nope" }))).toBeNull();
    expect(restoreState(bad({ repeat: 1 }))).toBeNull();
    expect(restoreState(bad({ volume: "1" }))).toBeNull();
    expect(restoreState(bad({ qualityMode: "ultra" }))).toBeNull();
    expect(restoreState(bad({ nowPlayingOpen: 1 }))).toBeNull();
  });

  it("sanitizes out-of-range numerics (never out-of-range, never throws)", () => {
    const base = serializeState(snapshot());
    const with_ = (patch: Record<string, unknown>): PersistedState =>
      restoreState(JSON.stringify({ ...base, ...patch })) as PersistedState;
    // volume clamp [0,1]
    expect(with_({ volume: 5 }).volume).toBe(1);
    expect(with_({ volume: -2 }).volume).toBe(0);
    // positionSec >= 0
    expect(with_({ positionSec: -10 }).positionSec).toBe(0);
    // currentIndex clamped into [-1, len-1]
    expect(with_({ currentIndex: 99 }).currentIndex).toBe(2);
    expect(with_({ currentIndex: -5 }).currentIndex).toBe(-1);
    // non-finite numbers rejected
    expect(restoreState(JSON.stringify({ ...base, volume: 1 / 0 }))).toBeNull();
  });

  it("filters non-integer entries out of queueTrackIds (keeps order of the valid ones)", () => {
    const base = serializeState(snapshot());
    const r = restoreState(
      JSON.stringify({ ...base, queueTrackIds: [10, "a", 2.5, 11, null, 12], currentIndex: 0 }),
    );
    expect(r).not.toBeNull();
    expect((r as PersistedState).queueTrackIds).toEqual([10, 11, 12]);
  });
});
