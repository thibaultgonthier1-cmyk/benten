import { describe, it, expect } from "vitest";
import { dur, ease, springs, motionFor } from "../src/renderer/theme/ds/motion";

describe("motion tokens", () => {
  it("expose les durées, courbes et ressorts centralisés", () => {
    expect(dur).toEqual({ fast: 0.15, base: 0.25, slow: 0.45 });
    expect(ease.out).toEqual([0.2, 0.8, 0.2, 1]);
    expect(ease.inOut).toEqual([0.65, 0, 0.35, 1]);
    expect(springs.snappy).toEqual({ type: "spring", stiffness: 520, damping: 34 });
    expect(springs.soft).toEqual({ type: "spring", stiffness: 260, damping: 30 });
  });
});

describe("motionFor", () => {
  it("reduced : désactivé, durées nulles", () => {
    const m = motionFor("reduced", false);
    expect(m.enabled).toBe(false);
    expect(m.d(0.3)).toBe(0);
  });

  it("prefers-reduced-motion l'emporte même en full", () => {
    const m = motionFor("full", true);
    expect(m.enabled).toBe(false);
    expect(m.d(0.3)).toBe(0);
  });

  it("subtle : durées raccourcies (×0.6)", () => {
    const m = motionFor("subtle", false);
    expect(m.enabled).toBe(true);
    expect(m.d(0.3)).toBeCloseTo(0.18, 3);
  });

  it("full : durées inchangées et ressort vif", () => {
    const m = motionFor("full", false);
    expect(m.enabled).toBe(true);
    expect(m.d(0.3)).toBe(0.3);
    expect(m.spring).toEqual(springs.snappy);
  });

  it("subtle : ressort doux", () => {
    expect(motionFor("subtle", false).spring).toEqual(springs.soft);
  });
});
