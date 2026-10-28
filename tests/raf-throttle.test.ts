import { describe, expect, it } from "vitest";
import { makeThrottle } from "../src/renderer/lib/throttle";

/**
 * Porte de cadencement PURE pilotee par un timestamp (`performance.now()` en prod) : renvoie `true`
 * quand `intervalMs` s'est ecoule depuis le dernier `true`, `false` sinon. Sert a limiter
 * `tick()`/`setPosition` a ~15 Hz (66 ms) dans la boucle rAF, qui continue de tourner a la
 * frequence ecran. Deterministe : on injecte les timestamps.
 */
describe("makeThrottle — porte de cadencement pure", () => {
  it("vrai a 0, faux a 30, vrai a 70 (fenetre de 66 ms)", () => {
    const gate = makeThrottle(66);
    expect(gate(0)).toBe(true); // premier appel : toujours vrai
    expect(gate(30)).toBe(false); // 30 < 66 depuis le dernier vrai
    expect(gate(70)).toBe(true); // 70 >= 66 : nouvelle fenetre
  });

  it("re-barre immediatement apres un passage", () => {
    const gate = makeThrottle(66);
    expect(gate(0)).toBe(true);
    expect(gate(65)).toBe(false);
    expect(gate(66)).toBe(true);
    expect(gate(100)).toBe(false);
    expect(gate(132)).toBe(true);
  });

  it("premier appel vrai quel que soit le timestamp de depart", () => {
    const gate = makeThrottle(66);
    expect(gate(5000)).toBe(true);
    expect(gate(5040)).toBe(false);
    expect(gate(5070)).toBe(true);
  });

  it("cadence ~15x/s sur une seconde de frames 60 Hz", () => {
    const gate = makeThrottle(66);
    let passes = 0;
    for (let i = 0; i < 60; i++) {
      // 60 frames espacees de ~16.67 ms = 1 s.
      if (gate(i * (1000 / 60))) passes++;
    }
    // ~15 passages (jamais 60, jamais 1).
    expect(passes).toBeGreaterThanOrEqual(14);
    expect(passes).toBeLessThanOrEqual(16);
  });
});
