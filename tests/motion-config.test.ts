import { describe, expect, it } from "vitest";
import {
  dur,
  ease,
  motionFor,
  pageTransition,
  reducedMotionFor,
  PAGE_SLIDE_PX,
} from "../src/renderer/theme/ds/motion";

/**
 * Câblage du réglage d'intensité (Phase 3, Tâche 3) : `MotionConfig.reducedMotion` suit le store
 * de réglages (et plus seulement la préférence système), et la transition de page est dérivée de
 * `motionFor` (fondu + glissé de 8 px).
 */

describe("reducedMotionFor", () => {
  it("Réduit force « always » ; Complet/Sobre suivent la préférence système (« user »)", () => {
    expect(reducedMotionFor("reduced")).toBe("always");
    expect(reducedMotionFor("full")).toBe("user");
    expect(reducedMotionFor("subtle")).toBe("user");
  });
});

describe("pageTransition", () => {
  it("Complet : fondu + glissé de 8 px, durée de base, courbe out", () => {
    const t = pageTransition(motionFor("full", false));
    expect(PAGE_SLIDE_PX).toBe(8);
    expect(t.initial).toEqual({ opacity: 0, y: 8 });
    expect(t.animate.opacity).toBe(1);
    expect(t.animate.y).toBe(0);
    expect(t.animate.transition.duration).toBe(dur.base);
    expect(t.animate.transition.ease).toEqual(ease.out);
    expect(t.exit.opacity).toBe(0);
    expect(t.exit.transition.duration).toBe(dur.fast);
  });

  it("Sobre : mêmes mouvements, durées raccourcies via motionFor", () => {
    const m = motionFor("subtle", false);
    const t = pageTransition(m);
    expect(t.animate.transition.duration).toBeCloseTo(m.d(dur.base));
    expect(t.exit.transition.duration).toBeCloseTo(m.d(dur.fast));
    expect(t.animate.transition.duration).toBeLessThan(dur.base);
  });

  it("Réduit (ou préférence système) : aucun glissé, changement instantané", () => {
    for (const m of [motionFor("reduced", false), motionFor("full", true)]) {
      const t = pageTransition(m);
      expect(t.initial).toEqual({ opacity: 1, y: 0 });
      expect(t.animate.transition.duration).toBe(0);
      expect(t.exit.transition.duration).toBe(0);
      expect(t.exit.y ?? 0).toBe(0);
    }
  });
});
