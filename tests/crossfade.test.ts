import { describe, expect, it } from "vitest";
import {
  MAX_CROSSFADE_SEC,
  MIN_CROSSFADE_SEC,
  crossfadeGains,
  crossfadeStartTime,
  normalizeCrossfade,
  shouldArmCrossfade,
} from "../src/renderer/audio/schedule";

/**
 * Fondu enchaîné : toute la décision est pure, donc testable à la milliseconde. Le point
 * important est que le fondu ne doit JAMAIS dégrader le gapless existant quand il est à 0.
 */
describe("normalizeCrossfade", () => {
  it("0 et valeurs absurdes désactivent le fondu", () => {
    expect(normalizeCrossfade(0)).toBe(0);
    expect(normalizeCrossfade(-3)).toBe(0);
    expect(normalizeCrossfade(Number.NaN)).toBe(0);
    expect(normalizeCrossfade(null)).toBe(0);
  });

  it("borne entre le minimum audible et le maximum raisonnable", () => {
    expect(normalizeCrossfade(0.1)).toBe(MIN_CROSSFADE_SEC);
    expect(normalizeCrossfade(60)).toBe(MAX_CROSSFADE_SEC);
    expect(normalizeCrossfade(6)).toBe(6);
  });
});

describe("crossfadeStartTime", () => {
  it("fondu à 0 : départ à la fin exacte (gapless inchangé)", () => {
    expect(crossfadeStartTime(100, 0)).toBe(100);
  });

  it("démarre la suivante AVANT la fin, de la durée du fondu", () => {
    expect(crossfadeStartTime(100, 6)).toBe(94);
  });

  it("ne programme jamais un départ dans le passé sur un morceau plus court que le fondu", () => {
    // Morceau de 4 s commencé à t=10, fondu de 6 s : la fin est à 14, mais 14-6=8 < 10.
    expect(crossfadeStartTime(14, 6, 10)).toBeCloseTo(10.05, 5);
  });
});

describe("crossfadeGains", () => {
  it("au début : l'ancienne à plein, la nouvelle à zéro", () => {
    expect(crossfadeGains(0)).toEqual({ current: 1, next: 0 });
  });

  it("à la fin : l'inverse", () => {
    const { current, next } = crossfadeGains(1);
    expect(current).toBeCloseTo(0, 6);
    expect(next).toBeCloseTo(1, 6);
  });

  it("à mi-fondu : égalité, et puissance constante (somme des carrés = 1)", () => {
    const { current, next } = crossfadeGains(0.5);
    expect(current).toBeCloseTo(next, 6);
    expect(current * current + next * next).toBeCloseTo(1, 6);
  });

  it("borne la progression hors de [0,1]", () => {
    expect(crossfadeGains(-2)).toEqual({ current: 1, next: 0 });
    expect(crossfadeGains(5).next).toBeCloseTo(1, 6);
  });
});

describe("shouldArmCrossfade", () => {
  it("n'arme rien quand le fondu est désactivé", () => {
    expect(shouldArmCrossfade(199, 200, 0)).toBe(false);
  });

  it("arme quand il reste moins que le fondu", () => {
    expect(shouldArmCrossfade(195, 200, 6)).toBe(true);
  });

  it("n'arme pas trop tôt", () => {
    expect(shouldArmCrossfade(100, 200, 6)).toBe(false);
  });

  it("reste inerte sur une durée inconnue", () => {
    expect(shouldArmCrossfade(0, 0, 6)).toBe(false);
    expect(shouldArmCrossfade(Number.NaN, 200, 6)).toBe(false);
  });
});
