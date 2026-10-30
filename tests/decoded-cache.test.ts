import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";
import type { TrackRow } from "../src/shared/types";

/**
 * Changer de morceau doit etre INSTANTANE quand la piste a deja ete jouee : ni lecture de
 * fichier, ni decodage. C'est le decalage ressenti entre l'appui et le son.
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
class FakeParam {
  value = 1;
  ramps: { to: number; at: number }[] = [];
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number, at: number): void {
    this.ramps.push({ to: v, at });
    this.value = v;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeAnalyser extends FakeNode {}
class FakeBuffer {
  constructor(public duration = 12) {}
  get length(): number {
    return Math.round(this.duration * 44100);
  }
  getChannelData(): Float32Array {
    return new Float32Array(4410);
  }
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  start(): void {}
  stop(): void {}
}
class FakeCtx {
  currentTime = 0;
  state = "running";
  destination = new FakeNode();
  sampleRate = 44100;
  createGain(): FakeGain {
    return new FakeGain();
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam; Q: FakeParam; gain: FakeParam } {
    return Object.assign(new FakeNode(), { type: "peaking", frequency: new FakeParam(), Q: new FakeParam(), gain: new FakeParam() });
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

function track(id: number): TrackRow {
  return { id, path: `C:/m/${id}.flac`, playable: true, durationSec: 12, title: `t${id}`, artist: "a", album: "b" } as unknown as TrackRow;
}

describe("cache de buffers decodes", () => {
  it("ne relit ni ne redecode une piste deja chargee", async () => {
    const decode = vi.fn(async () => new FakeBuffer(12));
    const read = vi.fn(async () => new ArrayBuffer(8));
    const decoder: Decoder = { canDecode: () => true, decode } as unknown as Decoder;
    const engine = new AudioEngine(new FakeCtx() as unknown as AudioContext, decoder, read as never);

    await engine.load(track(1));
    await engine.load(track(1));

    expect(decode).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(engine.decodedCacheSize()).toBe(1);
  });

  it("reste borne : jamais plus de 4 pistes en cache", async () => {
    const decoder: Decoder = { canDecode: () => true, decode: async () => new FakeBuffer(12) } as unknown as Decoder;
    const engine = new AudioEngine(
      new FakeCtx() as unknown as AudioContext,
      decoder,
      (async () => new ArrayBuffer(8)) as never,
    );
    for (let id = 1; id <= 9; id += 1) await engine.load(track(id));
    expect(engine.decodedCacheSize()).toBeLessThanOrEqual(4);
  });

  it("se purge quand le contexte audio est reconstruit", async () => {
    const decoder: Decoder = { canDecode: () => true, decode: async () => new FakeBuffer(12) } as unknown as Decoder;
    const engine = new AudioEngine(
      new FakeCtx() as unknown as AudioContext,
      decoder,
      (async () => new ArrayBuffer(8)) as never,
    );
    await engine.load(track(1));
    expect(engine.decodedCacheSize()).toBe(1);
    engine.clearDecodedCache();
    expect(engine.decodedCacheSize()).toBe(0);
  });
});

