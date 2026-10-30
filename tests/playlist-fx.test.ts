import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaylistFx, FLIGHT_SAFETY_MS } from "../src/renderer/ui/playlistFx";

/**
 * Animation d'ajout (ajout utilisateur, Tâche 9) : la pochette vole vers l'entrée de la playlist ;
 * pendant le vol, le compteur de l'entrée reste à l'ancienne valeur, puis il roule à l'atterrissage
 * en même temps que l'entrée fait « pop ».
 */

const from = { x: 10, y: 20 };

afterEach(() => {
  vi.useRealTimers();
});

describe("playlistFx", () => {
  it("un vol retient le compteur affiché ; l'atterrissage le libère et déclenche un pop", () => {
    const fx = createPlaylistFx();
    const id = fx.getState().fly({ playlistId: 7, artKey: "k", seed: "s", from }, 3);
    expect(fx.getState().flights.map((f) => f.id)).toEqual([id]);
    expect(fx.getState().held.get(7)).toBe(3);
    expect(fx.getState().pops.get(7) ?? 0).toBe(0);

    fx.getState().land(id);
    expect(fx.getState().flights).toEqual([]);
    expect(fx.getState().held.has(7)).toBe(false);
    expect(fx.getState().pops.get(7)).toBe(1);
  });

  it("deux vols vers la même playlist : le compteur reste retenu jusqu'au dernier atterrissage", () => {
    const fx = createPlaylistFx();
    const a = fx.getState().fly({ playlistId: 1, artKey: null, seed: "a", from }, 5);
    const b = fx.getState().fly({ playlistId: 1, artKey: null, seed: "b", from }, 6);
    expect(fx.getState().held.get(1)).toBe(5);
    fx.getState().land(a);
    expect(fx.getState().held.get(1)).toBe(5);
    fx.getState().land(b);
    expect(fx.getState().held.has(1)).toBe(false);
    expect(fx.getState().pops.get(1)).toBe(2);
  });

  it("cancel libère sans pop ; land d'un vol inconnu est sans effet", () => {
    const fx = createPlaylistFx();
    const id = fx.getState().fly({ playlistId: 2, artKey: null, seed: "x", from }, 0);
    fx.getState().cancel(id);
    expect(fx.getState().held.has(2)).toBe(false);
    expect(fx.getState().pops.get(2) ?? 0).toBe(0);
    const before = fx.getState();
    fx.getState().land(999);
    expect(fx.getState()).toBe(before);
  });

  it("filet de sécurité : un vol jamais rendu atterrit seul", () => {
    vi.useFakeTimers();
    const fx = createPlaylistFx();
    fx.getState().fly({ playlistId: 3, artKey: null, seed: "x", from }, 1);
    vi.advanceTimersByTime(FLIGHT_SAFETY_MS + 1);
    expect(fx.getState().flights).toEqual([]);
    expect(fx.getState().held.has(3)).toBe(false);
    expect(fx.getState().pops.get(3)).toBe(1);
  });

  it("pop() seul (dépôt sans vol, mouvement réduit) et cible de dépôt survolée", () => {
    const fx = createPlaylistFx();
    fx.getState().pop(4);
    expect(fx.getState().pops.get(4)).toBe(1);
    fx.getState().setDropTarget(4);
    expect(fx.getState().dropTarget).toBe(4);
    fx.getState().setDropTarget(null);
    expect(fx.getState().dropTarget).toBeNull();
  });
});
