import { describe, expect, it } from "vitest";
import { adaptiveMinTile, gridLayout } from "../src/renderer/lib/viewModels";

/**
 * Taille des pochettes selon la fenêtre : c'est ce qui évite des timbres-poste sur grand écran et
 * des tuiles qui débordent sur une fenêtre étroite.
 */
describe("adaptiveMinTile", () => {
  it("rétrécit les tuiles sur une fenêtre étroite", () => {
    expect(adaptiveMinTile(480)).toBe(132);
    expect(adaptiveMinTile(700)).toBe(156);
    expect(adaptiveMinTile(1000)).toBe(176);
  });

  it("agrandit les tuiles sur un grand écran", () => {
    expect(adaptiveMinTile(1500)).toBe(196);
    expect(adaptiveMinTile(1920)).toBe(216);
  });

  it("reste stable dans un palier (pas de saut pour 3 px)", () => {
    expect(adaptiveMinTile(1300)).toBe(adaptiveMinTile(1600));
  });

  it("a un repli quand la largeur n'est pas encore mesurée", () => {
    expect(adaptiveMinTile(0)).toBe(176);
    expect(adaptiveMinTile(Number.NaN)).toBe(176);
  });
});

describe("gridLayout avec tuiles adaptatives", () => {
  it("donne moins de colonnes (et des tuiles plus grandes) sur grand écran", () => {
    const petit = gridLayout(700, adaptiveMinTile(700), 24);
    const grand = gridLayout(1800, adaptiveMinTile(1800), 24);
    expect(grand.cardW).toBeGreaterThan(petit.cardW);
    expect(grand.cols).toBeGreaterThanOrEqual(petit.cols);
  });

  it("tient toujours dans la largeur disponible", () => {
    for (const width of [400, 700, 1200, 1800, 2560]) {
      const layout = gridLayout(width, adaptiveMinTile(width), 24);
      const used = layout.cols * layout.cardW + (layout.cols - 1) * 24;
      expect(used).toBeLessThanOrEqual(width);
    }
  });
});
