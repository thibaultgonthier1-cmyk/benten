import { describe, expect, it } from "vitest";
import { loudnessGain, needsLoudnessMatch, rmsOf } from "../src/renderer/audio/loudness";

function sine(amplitude: number, length = 1000): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.sin((2 * Math.PI * i) / 32) * amplitude;
  return samples;
}

/**
 * Égalisation de niveau : la piste entrante est corrigée pour ne pas éclipser (ou disparaître
 * derrière) celle qui part. Bornée, sinon on dénaturerait le morceau.
 */
describe("rmsOf", () => {
  it("mesure un niveau cohérent", () => {
    expect(rmsOf(sine(0.5))).toBeCloseTo(0.35, 2); // sinus d'amplitude 0,5 -> ~0,354
    expect(rmsOf(sine(0.1))).toBeLessThan(rmsOf(sine(0.5)));
  });

  it("vaut 0 sur le silence", () => {
    expect(rmsOf(new Float32Array(100))).toBe(0);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });
});

describe("loudnessGain", () => {
  it("ne touche à rien quand les niveaux sont égaux", () => {
    expect(loudnessGain(0.3, 0.3)).toBeCloseTo(1, 6);
  });

  it("baisse l'entrante trop forte", () => {
    // 6 dB vaut 1,9953× et non 2× : la correction d'un facteur 2 est donc bornée juste au-dessus
    // de 0,5. C'est voulu — on ne corrige jamais au-delà de la limite.
    const gain = loudnessGain(0.2, 0.4);
    expect(gain).toBeCloseTo(1 / Math.pow(10, 6 / 20), 4);
  });

  it("remonte l'entrante trop faible", () => {
    expect(loudnessGain(0.4, 0.2)).toBeCloseTo(Math.pow(10, 6 / 20), 4);
  });

  it("borne la correction à ±6 dB", () => {
    const limit = Math.pow(10, 6 / 20);
    expect(loudnessGain(0.05, 0.5)).toBeCloseTo(1 / limit, 4); // jamais moins de −6 dB
    expect(loudnessGain(0.5, 0.05)).toBeCloseTo(limit, 4); // jamais plus de +6 dB
  });

  it("ignore le silence", () => {
    expect(loudnessGain(0, 0.3)).toBe(1);
    expect(loudnessGain(0.3, 0)).toBe(1);
    expect(loudnessGain(Number.NaN, 0.3)).toBe(1);
  });
});

describe("needsLoudnessMatch", () => {
  it("ignore un écart inaudible", () => {
    expect(needsLoudnessMatch(0.30, 0.305)).toBe(false); // ~0,14 dB : inaudible
  });

  it("détecte un écart audible", () => {
    expect(needsLoudnessMatch(0.2, 0.4)).toBe(true);
  });
});

