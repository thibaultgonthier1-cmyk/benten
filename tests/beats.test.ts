import { describe, expect, it } from "vitest";
import {
  alignFadeStart,
  bassSwapWeights,
  beatDuration,
  energyEnvelope,
  estimateBpm,
  quantizeFadeToBeats,
} from "../src/renderer/audio/beats";

const RATE = 44100;

/** Génère un « clic » rythmé : attaque courte toutes les `60/bpm` secondes. */
function clickTrack(bpm: number, seconds = 8, sampleRate = RATE): Float32Array {
  const length = Math.floor(seconds * sampleRate);
  const samples = new Float32Array(length);
  const period = 60 / bpm;
  const hit = Math.floor(0.02 * sampleRate);
  for (let beat = 0; beat * period < seconds; beat += 1) {
    const start = Math.floor(beat * period * sampleRate);
    for (let i = 0; i < hit && start + i < length; i += 1) {
      samples[start + i] = Math.sin((i / hit) * Math.PI) * 0.9;
    }
  }
  return samples;
}

describe("energyEnvelope", () => {
  it("produit une enveloppe normalisée dans [0,1]", () => {
    const env = energyEnvelope(clickTrack(120, 2), RATE);
    expect(env.length).toBeGreaterThan(100);
    let max = 0;
    for (const v of env) max = Math.max(max, v);
    expect(max).toBeCloseTo(1, 5);
  });

  it("ignore le silence", () => {
    const env = energyEnvelope(new Float32Array(RATE), RATE);
    expect(env.every((v) => v === 0)).toBe(true);
  });
});

describe("estimateBpm", () => {
  it("retrouve 120 BPM", () => {
    expect(estimateBpm(clickTrack(120), RATE)).toBeCloseTo(120, 0);
  });

  it("retrouve 90 BPM", () => {
    const bpm = estimateBpm(clickTrack(90), RATE);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 90)).toBeLessThan(3);
  });

  it("ne prétend rien sur du silence", () => {
    expect(estimateBpm(new Float32Array(RATE * 3), RATE)).toBeNull();
  });

  it("ne prétend rien sur un signal trop court", () => {
    expect(estimateBpm(new Float32Array(100), RATE)).toBeNull();
  });
});

describe("beatDuration / quantizeFadeToBeats", () => {
  it("une noire à 120 BPM = 0,5 s", () => {
    expect(beatDuration(120)).toBeCloseTo(0.5, 6);
  });

  it("quantifie sur une mesure entière (4 temps)", () => {
    // À 120 BPM, la mesure vaut 2 s : 6 s demandées → 6 s (3 mesures)…
    expect(quantizeFadeToBeats(6, 120)).toBeCloseTo(6, 6);
    // …et 5 s demandées → 6 s (arrondi à la mesure la plus proche = 3 mesures).
    expect(quantizeFadeToBeats(5, 120)).toBeCloseTo(6, 6);
  });

  it("sans tempo, garde la durée demandée", () => {
    expect(quantizeFadeToBeats(5, null)).toBe(5);
  });

  it("fade 0 reste 0", () => {
    expect(quantizeFadeToBeats(0, 120)).toBe(0);
  });
});

describe("alignFadeStart", () => {
  it("recale le départ sur une mesure", () => {
    // Piste de 60 s démarrée à t=0, 120 BPM (mesure = 2 s), fondu de 6 s.
    // Départ naïf = 54 s → 54 est un multiple de 2 → reste 54.
    expect(alignFadeStart(0, 60, 6, 120)).toBeCloseTo(54, 6);
  });

  it("sans tempo, ne recale rien", () => {
    expect(alignFadeStart(0, 60, 6, null)).toBeCloseTo(54, 6);
  });

  it("ne sort jamais de la piste", () => {
    const start = alignFadeStart(0, 4, 6, 120);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThanOrEqual(4);
  });
});

describe("bassSwapWeights", () => {
  it("au début, le grave sortant est plein et l'entrant nul", () => {
    expect(bassSwapWeights(0)).toEqual({ outgoingLowGain: 1, incomingLowGain: 0 });
  });

  it("au tiers, le grave sortant a disparu", () => {
    expect(bassSwapWeights(0.34).outgoingLowGain).toBe(0);
  });

  it("à la fin, l'entrant est plein", () => {
    expect(bassSwapWeights(1).incomingLowGain).toBeCloseTo(1, 6);
  });

  it("borne hors de [0,1]", () => {
    expect(bassSwapWeights(-1)).toEqual({ outgoingLowGain: 1, incomingLowGain: 0 });
    expect(bassSwapWeights(9).incomingLowGain).toBeCloseTo(1, 6);
  });
});
