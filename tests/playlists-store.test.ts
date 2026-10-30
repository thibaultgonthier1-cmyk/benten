import { describe, expect, it, vi } from "vitest";
import { createPlaylistsStore } from "../src/renderer/state/playlists";
import { fakePlaylistsApi as fakeApi } from "./helpers/playlists";

/**
 * Carry-forward (h) : un petit store de playlists, source de la barre latérale, de la grille et
 * des sous-menus — rafraîchi IMMÉDIATEMENT après chaque création / renommage / suppression / ajout
 * (compteurs compris), sans attendre un retour de focus de la fenêtre.
 */

describe("playlists store", () => {
  it("refresh charge la liste et la mosaïque (4 pochettes distinctes) de chaque playlist", async () => {
    const { api } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await api.playlists.create("Sport"))!;
    await api.playlists.add(id, [1, 1, 2, 3, 4, 5]);
    await s.getState().refresh();
    expect(s.getState().loaded).toBe(true);
    expect(s.getState().rows.map((r) => [r.id, r.trackCount])).toEqual([[id, 6]]);
    expect(s.getState().art.get(id)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("create / add / rename / remove rafraîchissent aussitôt (compteurs compris)", async () => {
    const { api } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = await s.getState().create("Été");
    expect(id).not.toBeNull();
    expect(s.getState().rows.map((r) => r.name)).toEqual(["Été"]);

    expect(await s.getState().add(id!, [7, 8])).toBe(true);
    expect(s.getState().rows[0]!.trackCount).toBe(2);
    expect(s.getState().art.get(id!)).toEqual(["k7", "k8"]);

    expect(await s.getState().rename(id!, "Hiver")).toBe(true);
    expect(s.getState().rows[0]!.name).toBe("Hiver");

    expect(await s.getState().remove(id!)).toBe(true);
    expect(s.getState().rows).toEqual([]);
    expect(s.getState().art.has(id!)).toBe(false);
  });

  it("chaque mutation bouge la révision du contenu de la playlist (la page ouverte se recharge)", async () => {
    const { api } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await s.getState().create("A"))!;
    const r0 = s.getState().rev.get(id) ?? 0;
    await s.getState().add(id, [1, 2, 3]);
    const r1 = s.getState().rev.get(id)!;
    expect(r1).toBeGreaterThan(r0);
    await s.getState().reorder(id, 0, 2);
    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([2, 3, 1]);
    const r2 = s.getState().rev.get(id)!;
    expect(r2).toBeGreaterThan(r1);
    await s.getState().removeAt(id, 0);
    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([3, 1]);
    expect(s.getState().rev.get(id)!).toBeGreaterThan(r2);
  });

  it("restoreAt (annuler un retrait) passe par insertAt, atomique côté Main", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await s.getState().create("A"))!;
    await s.getState().add(id, [1, 2, 3]);
    await s.getState().removeAt(id, 1);
    playlists.add.mockClear();
    expect(await s.getState().restoreAt(id, 2, 1)).toBe(true);
    expect(playlists.insertAt).toHaveBeenCalledWith(id, 2, 1);
    expect(playlists.add).not.toHaveBeenCalled();
    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("annulations successives (A puis B retirés, puis annulés) → ordre d'origine A, B", async () => {
    const { api } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await s.getState().create("A"))!;
    await s.getState().add(id, [1, 2, 3]);
    await s.getState().removeAt(id, 0); // A
    await s.getState().removeAt(id, 0); // B
    await s.getState().restoreAt(id, 2, 0); // annule B
    await s.getState().restoreAt(id, 1, 0); // annule A
    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("restoreAt en échec renvoie false", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await s.getState().create("A"))!;
    playlists.insertAt.mockRejectedValueOnce(new Error("boom"));
    expect(await s.getState().restoreAt(id, 1, 0)).toBe(false);
  });

  it("tracksOf signale l'échec (jamais une liste vide trompeuse)", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await s.getState().create("A"))!;
    await s.getState().add(id, [1]);
    expect(await s.getState().tracksOf(id)).toEqual({ ok: true, tracks: [expect.objectContaining({ id: 1 })] });
    playlists.tracks.mockRejectedValueOnce(new Error("boom"));
    expect(await s.getState().tracksOf(id)).toEqual({ ok: false });
  });

  it("premier chargement en échec : `error` (pas une liste vide « normale ») ; un succès l'efface", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    playlists.list.mockRejectedValueOnce(new Error("boom"));
    await s.getState().refresh();
    expect(s.getState().loaded).toBe(true);
    expect(s.getState().error).toBe(true);
    await s.getState().refresh();
    expect(s.getState().error).toBe(false);
  });

  it("appels concurrents de refresh : UNE seule lecture (promesse partagée)", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    await Promise.all([s.getState().refresh(), s.getState().refresh(), s.getState().refresh()]);
    expect(playlists.list).toHaveBeenCalledTimes(1);
  });

  it("une mutation pendant un refresh en vol est quand même reflétée", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const id = (await api.playlists.create("A"))!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realList = playlists.list.getMockImplementation()!;
    playlists.list.mockImplementationOnce(async () => {
      const rows = await realList();
      await gate;
      return rows;
    });
    const first = s.getState().refresh(); // lit 0 titre, bloqué
    const added = s.getState().add(id, [5]);
    release();
    await Promise.all([first, added]);
    expect(s.getState().rows[0]!.trackCount).toBe(1);
  });

  it("un échec IPC renvoie false / null sans lever ; la liste reste utilisable", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    playlists.create.mockRejectedValueOnce(new Error("boom"));
    expect(await s.getState().create("x")).toBeNull();
    playlists.add.mockRejectedValueOnce(new Error("boom"));
    expect(await s.getState().add(99, [1])).toBe(false);
    playlists.list.mockRejectedValueOnce(new Error("boom"));
    await expect(s.getState().refresh()).resolves.toBeUndefined();
    playlists.tracks.mockRejectedValueOnce(new Error("boom"));
    expect(await s.getState().tracksOf(1)).toEqual({ ok: false });
  });

  it("la mosaïque n'est relue que pour les playlists modifiées", async () => {
    const { api, playlists } = fakeApi();
    const s = createPlaylistsStore(() => api);
    const a = (await s.getState().create("A"))!;
    const b = (await s.getState().create("B"))!;
    playlists.tracks.mockClear();
    await s.getState().add(a, [1]);
    expect(playlists.tracks.mock.calls.map((c) => c[0])).toEqual([a]);
    expect(s.getState().art.get(b)).toEqual([]);
  });

  it("hors fenêtre (pas d'API) : no-op", async () => {
    const s = createPlaylistsStore(() => undefined);
    await s.getState().refresh();
    expect(s.getState().rows).toEqual([]);
    expect(await s.getState().create("x")).toBeNull();
  });
});
