import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";

/**
 * Signal explicite de seek (observation seule) : le journal audio s'en sert pour ne pas prendre un
 * seek utilisateur pour un saut de position inattendu. Le comportement du seek est inchange.
 */

const node = () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} });
const ctx = {
  currentTime: 0,
  destination: {},
  createGain: node,
  createAnalyser: node,
} as unknown as AudioContext;
const decoder: Decoder = { canDecode: () => true, decode: async () => ({}) as AudioBuffer };

describe("AudioEngine — evenement seek", () => {
  it("seek() emet `seek` avec la position cible bornee et la piste courante", () => {
    const engine = new AudioEngine(ctx, decoder, async () => new ArrayBuffer(0));
    const cb = vi.fn();
    const off = engine.on("seek", cb);
    engine.seek(42); // rien de charge : duree 0 -> borne a 0
    expect(cb).toHaveBeenCalledWith({ positionSec: 0, trackId: null });
    off();
    engine.seek(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("un abonne `seek` qui leve ne casse pas le moteur", () => {
    const engine = new AudioEngine(ctx, decoder, async () => new ArrayBuffer(0));
    engine.on("seek", () => {
      throw new Error("boom");
    });
    expect(() => engine.seek(3)).not.toThrow();
    expect(engine.getState().status).toBe("idle");
  });
});
