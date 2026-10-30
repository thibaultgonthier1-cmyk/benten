import { describe, expect, it } from "vitest";
import { safeTint } from "../src/renderer/views/hero";

/**
 * Point (m) de la revue DA : une pochette claire ne doit pas éclaircir l'en-tête au point que le
 * titre ivoire perde son contraste. Au-delà du seuil, on ne teinte pas du tout.
 */
describe("safeTint", () => {
  it("garde une couleur sombre ou moyenne", () => {
    expect(safeTint("#1b1b1f")).toBe("#1b1b1f");
    expect(safeTint("#8a3b2e")).toBe("#8a3b2e");
    expect(safeTint("rgb(120, 60, 40)")).toBe("rgb(120, 60, 40)");
  });

  it("écarte une couleur très claire", () => {
    expect(safeTint("#f2e9d8")).toBeNull();
    expect(safeTint("#ffffff")).toBeNull();
    expect(safeTint("rgb(240, 235, 225)")).toBeNull();
  });

  it("accepte la notation courte", () => {
    expect(safeTint("#123")).toBe("#123");
    expect(safeTint("#fff")).toBeNull();
  });

  it("ne teinte rien quand la couleur est absente ou illisible", () => {
    expect(safeTint(null)).toBeNull();
    expect(safeTint(undefined)).toBeNull();
    expect(safeTint("pas-une-couleur")).toBeNull();
  });
});
