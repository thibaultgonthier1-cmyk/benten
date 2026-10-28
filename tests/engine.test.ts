import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";
import type { TrackRow } from "../src/shared/types";

/**
 * Web Audio mocke (environnement Node, aucun vrai AudioContext).
 * `currentTime` est pilotable : on l'avance a la main pour simuler l'ecoulement du temps.
 * On compte les BufferSource crees pour prouver qu'un track en erreur n'en cree aucun.
 */
class FakeNode {
  connectedTo: FakeNode | null = null;
  connect(dest: FakeNode): FakeNode {
    this.connectedTo = dest;
    return dest;
  }
  disconnect(): void {
    this.connectedTo = null;
  }
}
class FakeGain extends FakeNode {
  gain = { value: 1 };
}
class FakeAnalyser extends FakeNode {}
class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  startWhen?: number;
  startOffset?: number;
  constructor(private readonly ctx: FakeAudioContext) {
    super();
  }
  start(when = 0, offset = 0): void {
    this.started = true;
    this.startWhen = when;
    this.startOffset = offset;
    this.ctx.sources.push(this);
  }
  stop(): void {
    this.stopped = true;
  }
}
class FakeAudioBuffer {
  constructor(
    public duration: number,
    public sampleRate = 44100,
    public numberOfChannels = 2,
  ) {}
  get length(): number {
    return Math.round(this.duration * this.sampleRate);
  }
}
class FakeAudioContext {
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = new FakeNode();
  sources: FakeBufferSource[] = [];
  createdSources = 0;
  gainCount = 0;
  analyserCount = 0;
  resumeCount = 0;
  decodeImpl: (b: ArrayBuffer) => Promise<FakeAudioBuffer> = async () => new FakeAudioBuffer(1);
  createGain(): FakeGain {
    this.gainCount++;
    return new FakeGain();
  }
  createAnalyser(): FakeAnalyser {
    this.analyserCount++;
    return new FakeAnalyser();
  }
  createBufferSource(): FakeBufferSource {
    this.createdSources++;
    return new FakeBufferSource(this);
  }
  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = "running";
  }
  decodeAudioData(b: ArrayBuffer): Promise<FakeAudioBuffer> {
    return this.decodeImpl(b);
  }
}

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

const okDecoder = (buffer: FakeAudioBuffer, spy?: () => void): Decoder => ({
  canDecode: () => true,
  decode: async () => {
    spy?.();
    return buffer as unknown as AudioBuffer;
  },
});
const rejectingDecoder = (spy?: () => void): Decoder => ({
  canDecode: () => true,
  decode: async () => {
    spy?.();
    throw new Error("decode failed");
  },
});
const unsupportedDecoder = (spy?: () => void): Decoder => ({
  canDecode: () => false,
  decode: async () => {
    spy?.();
    throw new Error("must not be called");
  },
});

const readBytes = async (): Promise<ArrayBuffer> => new ArrayBuffer(8);

function makeEngine(ctx: FakeAudioContext, decoder: Decoder): AudioEngine {
  return new AudioEngine(ctx as unknown as AudioContext, decoder, readBytes);
}

describe("AudioEngine", () => {
  let ctx: FakeAudioContext;
  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it("load puis play -> status 'playing', durationSec issu de l'AudioBuffer", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(173)));
    await engine.load(track({ id: 7, durationSec: 999 }));
    expect(engine.getState()).toMatchObject({ status: "ready", durationSec: 173, trackId: 7 });

    engine.play();
    const s = engine.getState();
    expect(s.status).toBe("playing");
    expect(s.durationSec).toBe(173); // vient de l'AudioBuffer decode, pas des tags
    expect(ctx.resumeCount).toBeGreaterThan(0);
  });

  it("cable le graphe source -> gain -> analyser -> destination (gain/analyser reutilises)", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    await engine.load(track());
    engine.play();
    expect(ctx.createdSources).toBe(1);
    expect(ctx.gainCount).toBe(1);
    expect(ctx.analyserCount).toBe(1);
    const src = ctx.sources[0]!;
    const gain = src.connectedTo as FakeGain;
    expect(gain).toBeInstanceOf(FakeGain);
    const analyser = gain.connectedTo as FakeAnalyser;
    expect(analyser).toBeInstanceOf(FakeAnalyser);
    expect(analyser.connectedTo).toBe(ctx.destination);
  });

  it("la position derive de currentTime puis se fige au pause", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    ctx.currentTime = 100; // le temps a deja avance avant play
    engine.play();
    ctx.currentTime = 105;
    expect(engine.getState().positionSec).toBeCloseTo(5, 5);

    engine.pause();
    expect(engine.getState().status).toBe("paused");
    ctx.currentTime = 999; // le temps continue, la position reste figee
    expect(engine.getState().positionSec).toBeCloseTo(5, 5);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it("reprend depuis la position figee apres pause (nouvelle source au bon offset)", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    engine.play();
    ctx.currentTime = 12;
    engine.pause();
    expect(engine.getState().positionSec).toBeCloseTo(12, 5);
    engine.play();
    expect(ctx.createdSources).toBe(2);
    expect(ctx.sources[1]!.startOffset).toBeCloseTo(12, 5);
    ctx.currentTime = 15;
    expect(engine.getState().positionSec).toBeCloseTo(15, 5);
  });

  it("seek(30) -> position = 30, et avance ensuite depuis 30 en lecture", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    engine.play();
    ctx.currentTime = 10;
    engine.seek(30);
    expect(engine.getState().positionSec).toBe(30);
    expect(engine.getState().status).toBe("playing");
    ctx.currentTime = 12;
    expect(engine.getState().positionSec).toBeCloseTo(32, 5);
  });

  it("seek a l'arret fige la position sans demarrer de source", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    engine.seek(42);
    expect(ctx.createdSources).toBe(0);
    expect(engine.getState().positionSec).toBe(42);
    engine.play();
    expect(ctx.sources[0]!.startOffset).toBeCloseTo(42, 5);
  });

  it("borne la position a la duree", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(50)));
    await engine.load(track());
    engine.play();
    ctx.currentTime = 10_000;
    expect(engine.getState().positionSec).toBe(50);
    engine.seek(10_000);
    expect(engine.getState().positionSec).toBe(50);
    engine.seek(-5);
    expect(engine.getState().positionSec).toBe(0);
  });

  it("emet 'ended' et passe en 'ended' quand la source se termine naturellement", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    const ended = vi.fn();
    engine.on("ended", ended);
    await engine.load(track({ id: 9 }));
    engine.play();
    ctx.sources[0]!.onended?.();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]![0]).toMatchObject({ trackId: 9 });
    expect(engine.getState().status).toBe("ended");
    expect(engine.getState().positionSec).toBe(100);
  });

  it("un stop volontaire (pause) ne declenche pas l'evenement 'ended'", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    const ended = vi.fn();
    engine.on("ended", ended);
    await engine.load(track());
    engine.play();
    const src = ctx.sources[0]!;
    engine.pause();
    src.onended?.(); // le vrai Web Audio appelle onended apres stop()
    expect(ended).not.toHaveBeenCalled();
  });

  describe("fichier non lisible", () => {
    it("track.playable === false -> status 'error', evenement 'unplayable', decode jamais appele", async () => {
      const decodeSpy = vi.fn();
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100), decodeSpy));
      const unplayable = vi.fn();
      engine.on("unplayable", unplayable);

      await expect(engine.load(track({ id: 3, playable: false }))).resolves.toBeUndefined();

      expect(engine.getState()).toMatchObject({ status: "error", trackId: 3 });
      expect(unplayable).toHaveBeenCalledTimes(1);
      expect(unplayable.mock.calls[0]![0]).toMatchObject({ trackId: 3 });
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(ctx.createdSources).toBe(0);

      engine.play(); // ne doit produire aucun son
      expect(ctx.createdSources).toBe(0);
      expect(engine.getState().status).toBe("error");
    });

    it("decodeur qui rejette -> status 'error', 'unplayable', aucune exception, play() sans source", async () => {
      const engine = makeEngine(ctx, rejectingDecoder());
      const unplayable = vi.fn();
      engine.on("unplayable", unplayable);

      await expect(engine.load(track())).resolves.toBeUndefined();

      expect(engine.getState().status).toBe("error");
      expect(unplayable).toHaveBeenCalledTimes(1);
      expect(ctx.createdSources).toBe(0);

      engine.play();
      expect(ctx.createdSources).toBe(0);
      expect(engine.getState().status).toBe("error");
    });

    it("decodeur qui refuse le format (canDecode=false) -> 'error' + 'unplayable', decode jamais appele", async () => {
      const decodeSpy = vi.fn();
      const engine = makeEngine(ctx, unsupportedDecoder(decodeSpy));
      const unplayable = vi.fn();
      engine.on("unplayable", unplayable);

      await expect(engine.load(track({ path: "C:\\music\\drm.m4p" }))).resolves.toBeUndefined();

      expect(engine.getState().status).toBe("error");
      expect(unplayable).toHaveBeenCalledTimes(1);
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(ctx.createdSources).toBe(0);
    });
  });

  it("on() renvoie une fonction de desabonnement", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(10)));
    const cb = vi.fn();
    const off = engine.on("unplayable", cb);
    off();
    await engine.load(track({ playable: false }));
    expect(cb).not.toHaveBeenCalled();
  });

  it("play() en cours de lecture est idempotent (pas de source en double)", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    await engine.load(track());
    engine.play();
    engine.play();
    expect(ctx.createdSources).toBe(1);
  });

  it("charger un nouveau track remplace l'etat et stoppe la source precedente", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    await engine.load(track({ id: 1 }));
    engine.play();
    const first = ctx.sources[0]!;
    await engine.load(track({ id: 2, durationSec: 50 }));
    expect(first.stopped).toBe(true);
    expect(engine.getState()).toMatchObject({ status: "ready", trackId: 2, positionSec: 0 });
  });
});
