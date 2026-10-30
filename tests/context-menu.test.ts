import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeMenu,
  menuStore,
  nextMenuIndex,
  openMenu,
  placeMenu,
  type MenuItem,
} from "../src/renderer/ui/menuStore";

afterEach(() => {
  closeMenu();
  vi.unstubAllGlobals();
});

const noop = (): void => undefined;

describe("menuStore", () => {
  it("openMenu / closeMenu ; chaque ouverture a un identifiant neuf", () => {
    const items: MenuItem[] = [{ label: "Lire", onSelect: noop }];
    openMenu(10, 20, items);
    const a = menuStore.getState();
    expect(a.open).toBe(true);
    expect(a.x).toBe(10);
    expect(a.y).toBe(20);
    expect(a.items).toBe(items);
    openMenu(30, 40, items);
    expect(menuStore.getState().seq).toBeGreaterThan(a.seq);
    closeMenu();
    expect(menuStore.getState().open).toBe(false);
  });

  it("menu vide : ne s'ouvre pas", () => {
    openMenu(0, 0, ["separator"]);
    expect(menuStore.getState().open).toBe(false);
  });

  it("restaure le focus de l'élément actif à l'ouverture lors de la fermeture", () => {
    const focus = vi.fn();
    vi.stubGlobal("document", { activeElement: { focus } });
    openMenu(0, 0, [{ label: "x", onSelect: noop }]);
    closeMenu();
    expect(focus).toHaveBeenCalledTimes(1);
    // Fermer un menu déjà fermé ne refocalise rien.
    closeMenu();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("closeMenu({ restoreFocus:false }) ne touche pas au focus", () => {
    const focus = vi.fn();
    vi.stubGlobal("document", { activeElement: { focus } });
    openMenu(0, 0, [{ label: "x", onSelect: noop }]);
    closeMenu({ restoreFocus: false });
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("placeMenu", () => {
  const VW = 1000;
  const VH = 800;

  it("s'ouvre au point de clic, origine de transformation en haut à gauche", () => {
    expect(placeMenu(100, 120, 220, 300, VW, VH)).toEqual({
      left: 100,
      top: 120,
      originX: 0,
      originY: 0,
    });
  });

  it("trop près du bord droit/bas : bascule à gauche/au-dessus du curseur, origine suivie", () => {
    const p = placeMenu(900, 700, 220, 300, VW, VH);
    expect(p.left).toBe(680);
    expect(p.top).toBe(400);
    expect(p.originX).toBe(220);
    expect(p.originY).toBe(300);
  });

  it("plus grand que la fenêtre : borné à la marge, jamais hors écran", () => {
    const p = placeMenu(500, 500, 220, 900, VW, VH, 8);
    expect(p.top).toBe(8);
    expect(p.left).toBe(500);
    expect(p.originY).toBe(492);
  });
});

describe("nextMenuIndex", () => {
  const items: MenuItem[] = [
    { label: "a", onSelect: noop },
    "separator",
    { label: "b", disabled: true },
    { label: "c", onSelect: noop },
  ];

  it("saute séparateurs et éléments désactivés, en boucle", () => {
    expect(nextMenuIndex(items, -1, 1)).toBe(0);
    expect(nextMenuIndex(items, 0, 1)).toBe(3);
    expect(nextMenuIndex(items, 3, 1)).toBe(0);
    expect(nextMenuIndex(items, 0, -1)).toBe(3);
    expect(nextMenuIndex(items, -1, -1)).toBe(3);
  });

  it("aucun élément actif → -1", () => {
    expect(nextMenuIndex(["separator", { label: "x", disabled: true }], -1, 1)).toBe(-1);
  });
});
