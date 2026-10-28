import { describe, expect, it } from "vitest";
import { nextStartTime, shouldPreload } from "../src/renderer/audio/schedule";

/**
 * Math de planification pure (aucun Web Audio). Precision a l'echantillon pres :
 * la jointure gapless tombe exactement a `prevStart + prevDuration` sur l'horloge du contexte.
 */
describe("schedule.nextStartTime", () => {
  it("renvoie prevStart + prevDuration (jointure exacte, zero trou)", () => {
    expect(nextStartTime(0, 10)).toBe(10);
    expect(nextStartTime(12.5, 173.2)).toBeCloseTo(185.7, 10);
  });

  it("fonctionne quand la piste courante a demarre a un offset non nul", () => {
    // prevStart = instant-contexte ou la position 0 de la piste courante serait tombee.
    // Pour un demarrage a currentTime=100 avec offset 30 : prevStart = 70, duree 200 -> fin a 270.
    expect(nextStartTime(70, 200)).toBe(270);
  });

  it("entrees non finies -> repli neutre, jamais NaN", () => {
    expect(Number.isFinite(nextStartTime(Number.NaN, 10))).toBe(true);
    expect(Number.isFinite(nextStartTime(0, Number.POSITIVE_INFINITY))).toBe(true);
  });
});

describe("schedule.shouldPreload", () => {
  it("true quand le restant est strictement inferieur a leadSec", () => {
    expect(shouldPreload(11, 20, 10)).toBe(true); // reste 9 < 10
    expect(shouldPreload(19.9, 20, 10)).toBe(true); // reste 0.1 < 10
  });

  it("false quand le restant est superieur ou egal a leadSec", () => {
    expect(shouldPreload(10, 20, 10)).toBe(false); // reste 10, pas < 10
    expect(shouldPreload(0, 20, 10)).toBe(false); // reste 20
  });

  it("gere la fin de piste et les entrees aberrantes sans jeter", () => {
    expect(shouldPreload(20, 20, 10)).toBe(true); // reste 0 < 10
    expect(shouldPreload(Number.NaN, 20, 10)).toBe(false);
    expect(shouldPreload(5, Number.NaN, 10)).toBe(false);
  });
});
