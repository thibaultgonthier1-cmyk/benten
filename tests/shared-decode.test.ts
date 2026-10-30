import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";

/**
 * Le préchargement au survol et la lecture au clic demandent la MÊME piste : un seul décodage doit
 * partir. Deux décodages concurrents doublaient l'attente (1,7 s mesuré dans le journal).
 */
class N {
  connect(d: N): N { return d; }
  disconnect(): void {}
}
class P {
  value = 1;
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void { this.value = v; }
  linearRampToValueAtTime(v: number): void { this.value = v; }
}
class G extends N { gain = new P(); }
class B { constructor(public duration = 10) {} getChannelData(): Float32Array { return new Float32Array(100); } }
class S extends N { buffer: unknown = null; onended: (() => void) | null = null; start(): void {} stop(): void {} }
class Ctx {
  currentTime = 0; state = "running"; destination = new N(); sampleRate = 44100;
  createGain(): G { return new G(); }
  createAnalyser(): N { return new N(); }
  createBufferSource(): S { return new S(); }
  createBiquadFilter(): N & { type: string; frequency: P; Q: P; gain: P } {
    return Object.assign(new N(), { type: "peaking", frequency: new P(), Q: new P(), gain: new P() });
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("décodage partagé", () => {
  it("un préchargement puis une lecture ne décodent qu'UNE fois", async () => {
    let resolveDecode: ((b: B) => void) | null = null;
    const decode = vi.fn(
      () =>
        new Promise<B>((resolve) => {
          resolveDecode = resolve;
        }),
    );
    const read = vi.fn(async () => new ArrayBuffer(8));
    const decoder = { canDecode: () => true, decode } as unknown as Decoder;
    const engine = new AudioEngine(new Ctx() as unknown as AudioContext, decoder, read as never);
    const track = { id: 7, path: "C:/x.flac", playable: true, durationSec: 10 } as never;

    const prefetching = engine.prefetch(track); // survol
    const loading = engine.load(track); // clic, pendant le décodage

    // Laisse partir la lecture IPC (elle est asynchrone) avant de compter.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);

    resolveDecode!(new B(10));
    await Promise.all([prefetching, loading]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(engine.decodedCacheSize()).toBe(1);
  });
});

