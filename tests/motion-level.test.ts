import { describe, expect, it } from "vitest";
import { motionLevel } from "../src/renderer/lib/motionLevel";

/** Niveaux de mouvement DA « Biwa & Or » (spec §7 bis) : Complet / Sobre / Réduit (+ préférence OS). */
describe("motionLevel", () => {
  it("full → tout", () => {
    expect(motionLevel("full", false)).toEqual({ fx: "full", flakes: true, vibration: 1, rotate: true, ambient: true });
  });

  it("subtle → effets atténués, pas d'éclats, vibration ×0.5, le disque tourne, pas d'ambiance", () => {
    expect(motionLevel("subtle", false)).toEqual({
      fx: "dim",
      flakes: false,
      vibration: 0.5,
      rotate: true,
      ambient: false,
    });
  });

  const none = { fx: "none", flakes: false, vibration: 0, rotate: false, ambient: false };

  it("reduced → rien", () => {
    expect(motionLevel("reduced", false)).toEqual(none);
  });

  it("préférence système « moins de mouvement » l'emporte sur tout réglage", () => {
    expect(motionLevel("full", true)).toEqual(none);
    expect(motionLevel("subtle", true)).toEqual(none);
    expect(motionLevel("reduced", true)).toEqual(none);
  });

  it("valeurs partagées (références stables pour les dépendances React)", () => {
    expect(motionLevel("full", false)).toBe(motionLevel("full", false));
    expect(motionLevel("reduced", false)).toBe(motionLevel("full", true));
  });
});
