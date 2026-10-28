import { describe, expect, it } from "vitest";
import { nextFocusIndex } from "../src/renderer/lib/focusTrap";

/**
 * Helper PUR du piege de focus : index suivant dans un cycle Tab (avant) / Shift-Tab (arriere),
 * avec enroulement aux deux extremites. Teste hors DOM (environnement node).
 */
describe("nextFocusIndex — cyclage pur", () => {
  it("Tab avance d'un cran", () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(1, 3, false)).toBe(2);
  });

  it("Tab enroule du dernier au premier", () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
  });

  it("Shift-Tab recule d'un cran", () => {
    expect(nextFocusIndex(2, 3, true)).toBe(1);
    expect(nextFocusIndex(1, 3, true)).toBe(0);
  });

  it("Shift-Tab enroule du premier au dernier", () => {
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });

  it("une seule cible reste sur place dans les deux sens", () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });

  it("sans cible focusable renvoie 0 (pas de NaN/negatif)", () => {
    expect(nextFocusIndex(0, 0, false)).toBe(0);
    expect(nextFocusIndex(0, 0, true)).toBe(0);
  });
});
