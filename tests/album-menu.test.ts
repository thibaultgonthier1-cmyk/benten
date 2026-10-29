import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { albumMenuItems, type AlbumMenuActions } from "../src/renderer/shell/albumMenu";
import { toastStore } from "../src/renderer/ui/toastStore";
import type { Album } from "../src/renderer/lib/library";
import type { MenuItem } from "../src/renderer/ui/menuStore";
import type { TrackRow } from "../src/shared/types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  toastStore.getState().clear();
  vi.useRealTimers();
});

const tr = (id: number): TrackRow =>
  ({ id, title: `t${id}`, artist: "A", album: "Async", albumId: 9, durationSec: 100 }) as TrackRow;
const album: Album = { id: 9, title: "async", artist: "Sakamoto", artKey: null, tracks: [tr(1), tr(2)] };

function actions() {
  return {
    playAlbum: vi.fn<(a: Album) => void>(),
    albumPlayNext: vi.fn<(a: Album) => void>(),
    albumAddToQueue: vi.fn<(a: Album) => void>(),
    albumAddToPlaylist: vi.fn<(a: Album) => void>(),
    toggleFavorite: vi.fn<(id: number) => void>(),
  } satisfies AlbumMenuActions;
}

type Entry = Exclude<MenuItem, "separator">;
const byLabel = (items: MenuItem[], label: string): Entry =>
  items.find((i): i is Entry => i !== "separator" && i.label === label)!;
const toastMessages = () => toastStore.getState().toasts.map((t) => t.message);

describe("albumMenuItems", () => {
  it("expose les vraies actions existantes, dans l'ordre", () => {
    const items = albumMenuItems(album, actions(), new Set());
    expect(items.map((i) => (i === "separator" ? "—" : i.label))).toEqual([
      "Lire",
      "Lire ensuite",
      "Ajouter à la file",
      "—",
      "Ajouter à une playlist…",
      "Ajouter aux favoris",
    ]);
    for (const i of items) if (i !== "separator") expect(i.icon).toBeDefined();
  });

  it("chaque entrée appelle l'action correspondante avec l'album", () => {
    const a = actions();
    const items = albumMenuItems(album, a, new Set());
    byLabel(items, "Lire").onSelect!();
    byLabel(items, "Lire ensuite").onSelect!();
    byLabel(items, "Ajouter à la file").onSelect!();
    byLabel(items, "Ajouter à une playlist…").onSelect!();
    expect(a.playAlbum).toHaveBeenCalledWith(album);
    expect(a.albumPlayNext).toHaveBeenCalledWith(album);
    expect(a.albumAddToQueue).toHaveBeenCalledWith(album);
    expect(a.albumAddToPlaylist).toHaveBeenCalledWith(album);
    expect(toastMessages()).toEqual(["« async » sera lu ensuite", "« async » ajouté à la file"]);
  });

  it("favoris : ajoute les pistes non favorites ; album déjà favori → retire toutes ses favorites", () => {
    const a = actions();
    albumMenuItems(album, a, new Set()).forEach((i) => {
      if (i !== "separator" && i.label === "Ajouter aux favoris") i.onSelect!();
    });
    expect(a.toggleFavorite.mock.calls).toEqual([[1], [2]]);

    const b = actions();
    const items = albumMenuItems(album, b, new Set([2]));
    byLabel(items, "Retirer des favoris").onSelect!();
    expect(b.toggleFavorite.mock.calls).toEqual([[2]]);
    expect(toastMessages()).toEqual(["« async » ajouté aux favoris", "« async » retiré des favoris"]);
  });

  it("titre long : le nom est raccourci, le verbe du toast reste lisible", () => {
    const long: Album = { ...album, title: "…And Justice for All (Remastered Deluxe Box Set)" };
    const a = actions();
    byLabel(albumMenuItems(long, a, new Set()), "Lire ensuite").onSelect!();
    expect(toastMessages()).toEqual(["« …And Justice for All (Remaste… » sera lu ensuite"]);
  });

  it("album sans piste : les entrées de lecture sont désactivées", () => {
    const empty: Album = { ...album, tracks: [] };
    const items = albumMenuItems(empty, actions(), new Set());
    expect(byLabel(items, "Lire").disabled).toBe(true);
    expect(byLabel(items, "Ajouter aux favoris").disabled).toBe(true);
  });
});
