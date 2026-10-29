import { describe, expect, it, vi } from "vitest";
import { createUiStore } from "../src/renderer/state/ui";
import { bindSearchQuery, clearSearch, typeSearch, type SearchQueryHost } from "../src/renderer/state/searchSync";

/**
 * Carry-forward (g) : la frappe dans la recherche met à jour `route.q` par REMPLACEMENT (aucune
 * entrée d'historique par touche) ; précédent / suivant restaurent le bon terme.
 */

function fakeLibrary(): SearchQueryHost & { setQuery: ReturnType<typeof vi.fn> } {
  const state = {
    query: "",
    setQuery: vi.fn((q: string) => {
      state.query = q;
    }),
  };
  return { getState: () => state, setQuery: state.setQuery } as never;
}

describe("typeSearch (frappe dans la barre du haut)", () => {
  it("première touche hors Recherche : UNE navigation ; les suivantes remplacent la route", () => {
    const ui = createUiStore({ name: "albums" });
    const lib = fakeLibrary();
    const off = bindSearchQuery(ui, lib);

    typeSearch("m", ui, lib);
    typeSearch("mo", ui, lib);
    typeSearch("montagem", ui, lib);

    expect(ui.getState().route).toEqual({ name: "search", q: "montagem" });
    expect(ui.getState().past).toEqual([{ name: "albums" }]);
    expect(lib.getState().query).toBe("montagem");
    off();
  });

  it("précédent / suivant restaurent le terme de la page Recherche", () => {
    const ui = createUiStore({ name: "home" });
    const lib = fakeLibrary();
    const off = bindSearchQuery(ui, lib);

    typeSearch("montagem", ui, lib);
    ui.getState().navigate({ name: "album", id: 4 });
    // Quitter la Recherche vide le champ.
    expect(lib.getState().query).toBe("");

    ui.getState().back();
    expect(ui.getState().route).toEqual({ name: "search", q: "montagem" });
    expect(lib.getState().query).toBe("montagem");

    ui.getState().back();
    expect(lib.getState().query).toBe("");
    ui.getState().forward();
    expect(lib.getState().query).toBe("montagem");
    off();
  });

  it("le désabonnement coupe la synchronisation", () => {
    const ui = createUiStore({ name: "home" });
    const lib = fakeLibrary();
    bindSearchQuery(ui, lib)();
    ui.getState().navigate({ name: "search", q: "x" });
    expect(lib.setQuery).not.toHaveBeenCalled();
  });
});

describe("clearSearch (Échap / bouton effacer)", () => {
  it("sur la page Recherche : vide le terme et REMPLACE la route (aucune entrée d'historique)", () => {
    const ui = createUiStore({ name: "albums" });
    const lib = fakeLibrary();
    const off = bindSearchQuery(ui, lib);
    typeSearch("montagem", ui, lib);
    clearSearch(ui, lib);
    expect(ui.getState().route).toEqual({ name: "search", q: "" });
    expect(ui.getState().past).toEqual([{ name: "albums" }]);
    expect(lib.getState().query).toBe("");
    off();
  });

  it("hors Recherche : vide seulement le terme (pas de navigation)", () => {
    const ui = createUiStore({ name: "albums" });
    const lib = fakeLibrary();
    lib.getState().setQuery("x");
    clearSearch(ui, lib);
    expect(ui.getState().route).toEqual({ name: "albums" });
    expect(lib.getState().query).toBe("");
  });
});
