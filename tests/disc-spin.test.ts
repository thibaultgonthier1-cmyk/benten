import { describe, expect, it } from "vitest";
import { RPM_33_DEG_PER_SEC, SPIN_DOWN_SEC, SPIN_UP_SEC, createDiscSpin } from "../src/renderer/lib/discSpin";

/**
 * Rotation du disque laqué (DA2) : 33⅓ tr/min, démarrage en douceur, et à la pause une
 * DÉCÉLÉRATION jusqu'à l'arrêt — jamais d'arrêt brutal. Vitesse continue, angle continu.
 */

const run = (spin: ReturnType<typeof createDiscSpin>, seconds: number, dt = 1 / 60): number[] => {
  const v: number[] = [];
  for (let t = 0; t < seconds; t += dt) {
    spin.step(dt);
    v.push(spin.velocity());
  }
  return v;
};

describe("createDiscSpin", () => {
  it("33⅓ tr/min = 200°/s", () => {
    expect(RPM_33_DEG_PER_SEC).toBeCloseTo(200, 6);
  });

  it("au repos : immobile, aucune animation requise", () => {
    const s = createDiscSpin();
    expect(s.velocity()).toBe(0);
    expect(s.idle()).toBe(true);
  });

  it("lecture : montée progressive (ease-in), puis plein régime à 200°/s", () => {
    const s = createDiscSpin();
    s.setPlaying(true);
    expect(s.idle()).toBe(false);
    const v = run(s, SPIN_UP_SEC + 0.1);
    expect(v[0]).toBeGreaterThan(0);
    expect(v[0]).toBeLessThan(20); // pas de saut de vitesse au démarrage
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1] - 1e-9);
    expect(s.velocity()).toBeCloseTo(RPM_33_DEG_PER_SEC, 6);
  });

  it("pause : décélère progressivement jusqu'à l'arrêt, puis redevient idle", () => {
    const s = createDiscSpin();
    s.setPlaying(true);
    run(s, SPIN_UP_SEC + 0.1);
    s.setPlaying(false);
    const v = run(s, SPIN_DOWN_SEC + 0.1);
    // pas d'arrêt brutal : la première frame après la pause tourne encore presque à plein régime
    expect(v[0]).toBeGreaterThan(RPM_33_DEG_PER_SEC * 0.9);
    // et à mi-chemin la vitesse est intermédiaire
    const mid = v[Math.floor(v.length / 2)];
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(RPM_33_DEG_PER_SEC - 10);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeLessThanOrEqual(v[i - 1] + 1e-9);
    expect(s.velocity()).toBe(0);
    expect(s.idle()).toBe(true);
  });

  it("l'angle avance continûment et reste dans [0, 360)", () => {
    const s = createDiscSpin();
    s.setPlaying(true);
    let prev = s.angle();
    for (let i = 0; i < 600; i++) {
      s.step(1 / 60);
      const a = s.angle();
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(360);
      const d = (a - prev + 360) % 360;
      expect(d).toBeLessThan(10);
      prev = a;
    }
  });

  it("inversion en cours de rampe : repart de la vitesse courante (pas de saut)", () => {
    const s = createDiscSpin();
    s.setPlaying(true);
    run(s, SPIN_UP_SEC / 2);
    const v0 = s.velocity();
    s.setPlaying(false);
    s.step(1 / 60);
    expect(Math.abs(s.velocity() - v0)).toBeLessThan(10);
  });

  it("stop() immédiat (mouvement réduit) : vitesse 0, angle conservé", () => {
    const s = createDiscSpin();
    s.setPlaying(true);
    run(s, 1);
    const a = s.angle();
    s.stop();
    expect(s.velocity()).toBe(0);
    expect(s.idle()).toBe(true);
    expect(s.angle()).toBe(a);
  });
});
