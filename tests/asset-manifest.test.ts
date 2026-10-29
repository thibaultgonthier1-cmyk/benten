import { describe, expect, it } from "vitest";
import { ASSET_IDS, assetUrl, type AssetId } from "../src/renderer/assets/manifest";

/**
 * Manifeste des ressources DA (DA2) : un point de branchement unique par ressource. Tant qu'une
 * ressource n'est pas produite et validée, `assetUrl` renvoie `null` (repli dessiné en code).
 */

const EXPECTED: readonly AssetId[] = [
  "tex.goldLeaf",
  "tex.lacquer",
  "tex.seigaihaDisc",
  "tex.washi",
  "fx.pluck",
  "fx.inkVeil",
  "fx.goldFlakes",
  "fx.ripple",
  "ill.emptyLibrary",
  "ill.emptyPlaylist",
  "ill.noResults",
  "ill.onboarding",
  "logo.animated",
  "intro.gold",
];

describe("assets/manifest", () => {
  it("liste exactement les identifiants du plan", () => {
    expect([...ASSET_IDS].sort()).toEqual([...EXPECTED].sort());
  });

  it("chaque AssetId se résout en string | null", () => {
    for (const id of ASSET_IDS) {
      const url = assetUrl(id);
      expect(url === null || typeof url === "string").toBe(true);
    }
  });

  it("DA2 : rien n'est encore branché (null partout, DA4 remplira la carte)", () => {
    for (const id of ASSET_IDS) expect(assetUrl(id)).toBeNull();
  });

  it("identifiant inconnu : rejeté au typage, et null à l'exécution", () => {
    // @ts-expect-error — « fx.nope » n'est pas un AssetId
    expect(assetUrl("fx.nope")).toBeNull();
    // @ts-expect-error — une chaîne quelconque n'est pas un AssetId
    const bad: AssetId = "tex.marble";
    expect(assetUrl(bad)).toBeNull();
  });
});
