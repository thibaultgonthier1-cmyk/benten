import { describe, expect, it, vi } from "vitest";
import { createFxScheduler } from "../src/renderer/lib/fxScheduler";

/**
 * Ordonnanceur d'effets (DA2) : au plus `max` (2) effets vivants ; plein, le PLUS ANCIEN est lâché
 * et le nouveau accepté (jamais de file d'attente) ; niveau « none » → aucun effet.
 */

const at = { x: 10, y: 20 };

describe("createFxScheduler", () => {
  it("trois demandes avec max 2 : 2 actifs, le premier est lâché", () => {
    const s = createFxScheduler(2);
    const a = s.request("pluck", at);
    const b = s.request("ripple", at);
    const c = s.request("goldFlakes", at);
    expect(a && b && c).toBeTruthy();
    expect(s.active().map((t) => t.id)).toEqual([b!.id, c!.id]);
  });

  it("max par défaut = 2", () => {
    const s = createFxScheduler();
    for (let i = 0; i < 10; i++) s.request("pluck", at);
    expect(s.active()).toHaveLength(2);
  });

  it("release libère une place", () => {
    const s = createFxScheduler(2);
    const a = s.request("pluck", at)!;
    const b = s.request("pluck", at)!;
    s.release(a.id);
    expect(s.active().map((t) => t.id)).toEqual([b.id]);
    const c = s.request("inkVeil", at)!;
    expect(s.active().map((t) => t.id)).toEqual([b.id, c.id]);
    s.release(999); // inconnu : sans effet
    expect(s.active()).toHaveLength(2);
  });

  it("niveau « none » → null, rien n'est ajouté", () => {
    const s = createFxScheduler(2);
    expect(s.request("pluck", at, "none")).toBeNull();
    expect(s.active()).toEqual([]);
  });

  it("niveau « dim » : le ticket le porte (opacité réduite au rendu)", () => {
    const s = createFxScheduler(2);
    expect(s.request("pluck", at, "dim")!.dim).toBe(true);
    expect(s.request("pluck", at)!.dim).toBe(false);
  });

  it("le ticket garde son genre, sa position (copie) et des ids croissants", () => {
    const s = createFxScheduler(2);
    const p = { x: 1, y: 2 };
    const a = s.request("ripple", p)!;
    p.x = 99;
    const b = s.request("ripple", p)!;
    expect(a.kind).toBe("ripple");
    expect(a.at).toEqual({ x: 1, y: 2 });
    expect(b.id).toBeGreaterThan(a.id);
  });

  it("instantané stable entre deux changements (useSyncExternalStore) et abonnés notifiés", () => {
    const s = createFxScheduler(2);
    const listener = vi.fn();
    const unsub = s.subscribe(listener);
    const snap0 = s.active();
    expect(s.active()).toBe(snap0);
    const a = s.request("pluck", at)!;
    expect(listener).toHaveBeenCalledTimes(1);
    const snap1 = s.active();
    expect(snap1).not.toBe(snap0);
    expect(s.active()).toBe(snap1);
    s.release(a.id);
    expect(listener).toHaveBeenCalledTimes(2);
    s.release(a.id); // déjà libéré : pas de notification
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    s.request("pluck", at);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
