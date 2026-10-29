import { describe, expect, it } from "vitest";
import { shouldPlayIntro } from "../src/renderer/components/Intro";

/**
 * T14 — l'intro ne doit apparaître que dans les conditions prévues : réglage actif,
 * ressource présente, et mouvement non réduit. C'est la règle du plan (rien en Réduit),
 * et le seul comportement de l'écran de lancement qui soit testable sans DOM vidéo.
 */
describe("Intro / shouldPlayIntro", () => {
  it("joue quand tout est réuni", () => {
    expect(shouldPlayIntro({ showIntro: true, reduced: false, hasAsset: true })).toBe(true);
  });

  it("ne joue pas si le réglage est coupé", () => {
    expect(shouldPlayIntro({ showIntro: false, reduced: false, hasAsset: true })).toBe(false);
  });

  it("ne joue pas en mouvement réduit", () => {
    expect(shouldPlayIntro({ showIntro: true, reduced: true, hasAsset: true })).toBe(false);
  });

  it("ne joue pas sans ressource embarquée", () => {
    expect(shouldPlayIntro({ showIntro: true, reduced: false, hasAsset: false })).toBe(false);
  });
});
