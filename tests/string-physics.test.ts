import { describe, expect, it } from "vitest";
import {
  DEFLECT_MAX_PX,
  VIBRATION_MAX_PX,
  createScrubGesture,
  deflect,
  fractionFromPointer,
  rmsFromTimeDomain,
  stepSpring,
  vibrationAmplitude,
} from "../src/renderer/lib/stringPhysics";

/**
 * Corde de biwa (DA2) : physique pure de la barre de lecture — pointeur → fraction, flexion sous le
 * doigt (bornée à ±14 px), ressort amorti au relâchement, amplitude de vibration pilotée par le RMS
 * de l'analyser, et geste de glisser annulé par un changement de piste.
 */

const rect = { left: 100, top: 50, width: 200, height: 28 };

describe("fractionFromPointer", () => {
  it("150 sur [100, 300] → 0.25", () => {
    expect(fractionFromPointer(150, { left: 100, width: 200 })).toBe(0.25);
  });

  it("borne hors de la corde à [0, 1]", () => {
    expect(fractionFromPointer(20, { left: 100, width: 200 })).toBe(0);
    expect(fractionFromPointer(999, { left: 100, width: 200 })).toBe(1);
    expect(fractionFromPointer(300, { left: 100, width: 200 })).toBe(1);
  });

  it("largeur nulle ou valeur non finie → 0 (jamais NaN)", () => {
    expect(fractionFromPointer(150, { left: 100, width: 0 })).toBe(0);
    expect(fractionFromPointer(Number.NaN, { left: 100, width: 200 })).toBe(0);
  });
});

describe("deflect", () => {
  it("la corde suit le pointeur : ancre en x local, décalage vers le pointeur", () => {
    const s = deflect(200, 64 + 4, rect, 14);
    expect(s.anchorX).toBe(100);
    expect(s.offsetY).toBeGreaterThan(0);
    expect(s.offsetY).toBeLessThanOrEqual(4);
    const up = deflect(200, 64 - 4, rect, 14);
    expect(up.offsetY).toBeLessThan(0);
  });

  it("le décalage est borné à ±14 px, même pointeur très loin", () => {
    expect(DEFLECT_MAX_PX).toBe(14);
    const down = deflect(200, 5000, rect, 14);
    const up = deflect(200, -5000, rect, 14);
    expect(down.offsetY).toBeLessThanOrEqual(14);
    expect(down.offsetY).toBeCloseTo(14, 5);
    expect(up.offsetY).toBeGreaterThanOrEqual(-14);
    expect(up.offsetY).toBeCloseTo(-14, 5);
    for (let y = -200; y <= 200; y += 7) {
      expect(Math.abs(deflect(200, 64 + y, rect, 14).offsetY)).toBeLessThanOrEqual(14);
    }
  });

  it("aux chevalets (extrémités), la corde ne fléchit pas : ancre bornée à [0, largeur]", () => {
    const left = deflect(50, 5000, rect, 14);
    expect(left.anchorX).toBe(0);
    expect(left.offsetY).toBe(0);
    const right = deflect(400, 5000, rect, 14);
    expect(right.anchorX).toBe(200);
    expect(right.offsetY).toBe(0);
  });
});

describe("stepSpring", () => {
  it("depuis 14 px, |offset| < 0.5 en moins de 1.0 s à dt = 1/60", () => {
    let s = { offset: 14, velocity: 0 };
    let t = 0;
    while (t < 1.0 && !(Math.abs(s.offset) < 0.5 && Math.abs(s.velocity) < 5)) {
      s = stepSpring(s, 1 / 60);
      t += 1 / 60;
    }
    expect(Math.abs(s.offset)).toBeLessThan(0.5);
    expect(t).toBeLessThanOrEqual(1.0);
  });

  it("oscillation amortie visible : la corde dépasse le repos avant de s'amortir", () => {
    let s = { offset: 14, velocity: 0 };
    let minOffset = Infinity;
    for (let i = 0; i < 60; i++) {
      s = stepSpring(s, 1 / 60);
      minOffset = Math.min(minOffset, s.offset);
    }
    expect(minOffset).toBeLessThan(-2); // au moins un rebond visible de l'autre côté
  });

  it("pur : n'altère pas l'état d'entrée ; un grand dt reste stable (sous-pas)", () => {
    const input = { offset: 14, velocity: 0 };
    const out = stepSpring(input, 0.5);
    expect(input).toEqual({ offset: 14, velocity: 0 });
    expect(Number.isFinite(out.offset)).toBe(true);
    expect(Math.abs(out.offset)).toBeLessThan(14);
  });
});

describe("vibrationAmplitude", () => {
  it("0 hors lecture", () => {
    expect(vibrationAmplitude(0.5, false, 1)).toBe(0);
  });

  it("au plus 2.5 px", () => {
    expect(VIBRATION_MAX_PX).toBe(2.5);
    expect(vibrationAmplitude(1, true, 1)).toBeLessThanOrEqual(2.5);
    expect(vibrationAmplitude(50, true, 1)).toBeLessThanOrEqual(2.5);
  });

  it("proportionnelle au niveau de mouvement (Sobre = moitié)", () => {
    expect(vibrationAmplitude(0.5, true, 0.5)).toBe(vibrationAmplitude(0.5, true, 1) / 2);
    expect(vibrationAmplitude(0.5, true, 0)).toBe(0);
  });

  it("croît avec l'énergie ; silence → 0", () => {
    expect(vibrationAmplitude(0, true, 1)).toBe(0);
    expect(vibrationAmplitude(0.05, true, 1)).toBeLessThan(vibrationAmplitude(0.2, true, 1));
    expect(vibrationAmplitude(0.05, true, 1)).toBeGreaterThan(0);
  });
});

describe("rmsFromTimeDomain", () => {
  it("silence (128) → 0 ; pleine échelle → ≈ 1", () => {
    expect(rmsFromTimeDomain(new Uint8Array(64).fill(128))).toBe(0);
    const full = new Uint8Array(64);
    for (let i = 0; i < full.length; i++) full[i] = i % 2 ? 255 : 0;
    expect(rmsFromTimeDomain(full)).toBeGreaterThan(0.98);
    expect(rmsFromTimeDomain(new Uint8Array(0))).toBe(0);
  });
});

describe("createScrubGesture — glisser sur la corde", () => {
  it("glisser puis relâcher → une seule recherche, à la dernière fraction", () => {
    const g = createScrubGesture();
    g.begin("track-a", 0.2);
    expect(g.dragging()).toBe(true);
    g.move(0.4);
    g.move(0.6);
    expect(g.fraction()).toBe(0.6);
    expect(g.end()).toBe(0.6);
    expect(g.dragging()).toBe(false);
    expect(g.end()).toBeNull(); // pas de seconde recherche
  });

  it("changement de piste en plein glisser : annulé, AUCUNE recherche au relâchement", () => {
    const g = createScrubGesture();
    g.begin("track-a", 0.2);
    g.move(0.7);
    expect(g.trackChanged("track-a")).toBe(false); // même piste : rien
    expect(g.dragging()).toBe(true);
    expect(g.trackChanged("track-b")).toBe(true); // promotion gapless / « suivant »
    expect(g.dragging()).toBe(false);
    g.move(0.9); // le pointeur bouge encore : ignoré
    expect(g.end()).toBeNull();
  });

  it("changement de piste hors glisser : rien à annuler", () => {
    const g = createScrubGesture();
    expect(g.trackChanged("track-b")).toBe(false);
  });

  it("annulation explicite (pointercancel) : aucune recherche", () => {
    const g = createScrubGesture();
    g.begin(1, 0.3);
    g.cancel();
    expect(g.end()).toBeNull();
  });

  it("borne les fractions à [0, 1]", () => {
    const g = createScrubGesture();
    g.begin(1, -2);
    expect(g.fraction()).toBe(0);
    g.move(4);
    expect(g.end()).toBe(1);
  });
});
