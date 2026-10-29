import { describe, expect, it, vi } from "vitest";
import { createPlaylistsStore } from "../src/renderer/state/playlists";
import { createPlaylistFx } from "../src/renderer/ui/playlistFx";
import { createAddToPlaylist, newPlaylistDialog, openNewPlaylist } from "../src/renderer/views/playlistActions";
import { fakePlaylistsApi, track } from "./helpers/playlists";

/**
 * Ajout à une playlist (menu, dialogue, dépôt sur la barre latérale) : doublons écartés (toast
 * « Déjà dans … » avec « Ajouter quand même »), confirmation, vol de la pochette depuis l'origine.
 */

function setup() {
  const { api, playlists } = fakePlaylistsApi();
  const store = createPlaylistsStore(() => api);
  const fx = createPlaylistFx();
  const toast = vi.fn((_msg: string, _opts?: { action?: { label: string; onClick(): void } }) => 1);
  const add = createAddToPlaylist({ store, fx, toast });
  return { api, playlists, store, fx, toast, add };
}

describe("addToPlaylist", () => {
  it("ajoute, confirme par un toast et fait voler la pochette depuis l'origine", async () => {
    const { store, fx, toast, add, api } = setup();
    const id = (await store.getState().create("Nuit"))!;
    const p = { id, name: "Nuit" };

    const done = add(p, [track(1), track(2)], { origin: { x: 5, y: 6 } });
    // Le vol part tout de suite, le compteur reste à l'ancienne valeur pendant le vol.
    await vi.waitFor(() => expect(fx.getState().flights).toHaveLength(1));
    expect(fx.getState().flights[0]).toMatchObject({ playlistId: id, artKey: "k1", from: { x: 5, y: 6 } });
    expect(fx.getState().held.get(id)).toBe(0);
    expect(await done).toBe(2);

    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([1, 2]);
    expect(store.getState().rows[0]!.trackCount).toBe(2);
    expect(toast.mock.calls[0]![0]).toBe("2 titres ajoutés à « Nuit »");
  });

  it("tous déjà présents : rien n'est ajouté ; « Ajouter quand même » force l'ajout", async () => {
    const { store, toast, add, api } = setup();
    const id = (await store.getState().create("Nuit"))!;
    await store.getState().add(id, [1]);

    expect(await add({ id, name: "Nuit" }, [track(1)])).toBe(0);
    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([1]);
    const [msg, opts] = toast.mock.calls[0]!;
    expect(msg).toBe("Déjà dans « Nuit »");
    expect(opts?.action?.label).toBe("Ajouter quand même");

    opts!.action!.onClick();
    await vi.waitFor(async () => expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([1, 1]));
  });

  it("en partie présents : seuls les nouveaux sont ajoutés, le toast le dit", async () => {
    const { store, toast, add, api } = setup();
    const id = (await store.getState().create("Nuit"))!;
    await store.getState().add(id, [1]);
    expect(await add({ id, name: "Nuit" }, [track(1), track(3)])).toBe(1);
    expect((await api.playlists.tracks(id)).map((t) => t.id)).toEqual([1, 3]);
    expect(toast.mock.calls[0]![0]).toBe("Ajouté à « Nuit » · 1 déjà présent");
  });

  it("échec IPC : le vol est annulé (compteur libéré, pas de pop) et l'échec est signalé", async () => {
    const { store, fx, toast, add, playlists } = setup();
    const id = (await store.getState().create("Nuit"))!;
    playlists.add.mockRejectedValueOnce(new Error("boom"));
    expect(await add({ id, name: "Nuit" }, [track(4)], { origin: { x: 0, y: 0 } })).toBe(0);
    expect(fx.getState().flights).toEqual([]);
    expect(fx.getState().held.has(id)).toBe(false);
    expect(fx.getState().pops.get(id) ?? 0).toBe(0);
    expect(toast.mock.calls.at(-1)![0]).toBe("Impossible d'ajouter à « Nuit »");
  });

  it("lecture de la playlist en échec : rien n'est ajouté, l'échec est signalé (pas de faux « nouveau »)", async () => {
    const { store, toast, add, playlists } = setup();
    const id = (await store.getState().create("Nuit"))!;
    await store.getState().add(id, [1]);
    playlists.add.mockClear();
    playlists.tracks.mockRejectedValueOnce(new Error("boom"));
    expect(await add({ id, name: "Nuit" }, [track(1)])).toBe(0);
    expect(playlists.add).not.toHaveBeenCalled();
    expect(toast.mock.calls.at(-1)![0]).toBe("Impossible d'ajouter à « Nuit »");
  });

  it("ids répétés dans une même demande : dédoublonnés, même avec allowDuplicates", async () => {
    const { store, add, playlists } = setup();
    const id = (await store.getState().create("Nuit"))!;
    expect(await add({ id, name: "Nuit" }, [track(1), track(1), track(2)], { allowDuplicates: true })).toBe(2);
    expect(playlists.add).toHaveBeenLastCalledWith(id, [1, 2]);
  });

  it("sans origine : pas de vol, mais l'entrée fait « pop »", async () => {
    const { store, fx, add } = setup();
    const id = (await store.getState().create("Nuit"))!;
    await add({ id, name: "Nuit" }, [track(9)]);
    expect(fx.getState().flights).toEqual([]);
    expect(fx.getState().pops.get(id)).toBe(1);
  });

  it("dialogue « Nouvelle playlist » : titres répétés dédoublonnés (aperçu et ajout)", () => {
    openNewPlaylist([track(1), track(1), track(2)]);
    expect(newPlaylistDialog.getState().request!.tracks.map((t) => t.id)).toEqual([1, 2]);
  });
});
