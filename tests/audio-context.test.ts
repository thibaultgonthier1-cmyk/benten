import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_LATENCY_HINT, createAudioContext } from "../src/renderer/audio/context";

/** Faux constructeur d'AudioContext : enregistre les options recues a chaque creation. */
function fakeCtor(opts: { rejectSampleRate?: boolean } = {}) {
  const calls: (AudioContextOptions | undefined)[] = [];
  class FakeCtx {
    readonly options: AudioContextOptions | undefined;
    constructor(o?: AudioContextOptions) {
      calls.push(o);
      if (opts.rejectSampleRate && o?.sampleRate !== undefined) {
        throw new Error("NotSupportedError: sampleRate");
      }
      this.options = o;
    }
  }
  return { Ctor: FakeCtx as unknown as typeof AudioContext, calls };
}

describe("createAudioContext (latencyHint playback)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("le hint expose est 'playback'", () => {
    expect(AUDIO_LATENCY_HINT).toBe("playback");
  });

  it("creation initiale : la fabrique par defaut (AudioContext global) recoit latencyHint 'playback'", () => {
    const { Ctor, calls } = fakeCtor();
    vi.stubGlobal("AudioContext", Ctor);
    createAudioContext();
    expect(calls).toEqual([{ latencyHint: "playback" }]);
  });

  it("reconstruction de qualite : sampleRate ET latencyHint 'playback'", () => {
    const { Ctor, calls } = fakeCtor();
    vi.stubGlobal("AudioContext", Ctor);
    createAudioContext(44100);
    expect(calls).toEqual([{ latencyHint: "playback", sampleRate: 44100 }]);
  });

  it("frequence refusee par la plateforme : repli au defaut, toujours avec latencyHint 'playback'", () => {
    const { Ctor, calls } = fakeCtor({ rejectSampleRate: true });
    const ctx = createAudioContext(12345, Ctor);
    expect(ctx).toBeDefined();
    expect(calls).toEqual([{ latencyHint: "playback", sampleRate: 12345 }, { latencyHint: "playback" }]);
  });
});
