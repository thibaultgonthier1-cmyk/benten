import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  albumMenuItems,
  selectionMenuItems,
  trackMenuItems,
  type AlbumMenuActions,
  type SelectionMenuActions,
  type TrackMenuActions,
} from "../src/renderer/shell/albumMenu";
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
const playlists = [
  { id: 4, name: "Nuit" },
  { id: 7, name: "Route" },
];

function actions() {
  return {
    playAlbum: vi.fn<(a: Album) => void>(),
    albumPlayNext: vi.fn<(a: Album) => void>(),
    albumAddToQueue: vi.fn<(a: Album) => void>(),
    albumAddToPlaylist: vi.fn<(a: Album) => void>(),
    addToPlaylist: vi.fn<(p: { id: number; name: string }, t: readonly TrackRow[]) => void>(),
    toggleFavorite: vi.fn<(id: number) => void>(),
    goToArtist: vi.fn<(artist: string) => void>(),
  } satisfies AlbumMenuActions;
}

type Entry = Exclude<MenuItem, "separator">;
const byLabel = (items: MenuItem[], label: string): Entry =>
  items.find((i): i is Entry => i !== "separator" && i.label === label)!;
const labels = (items: MenuItem[]): string[] => items.map((i) => (i === "separator" ? "—" : i.label));
const toastMessages = () => toastStore.getState().toasts.map((t) => t.message);

describe("albumMenuItems", () => {
  it("expose Lire, Lire ensuite, Ajouter à la file, Ajouter à une playlist ▸, favori, Aller à l'artiste", () => {
    const items = albumMenuItems(album, actions(), new Set(), playlists);
    expect(labels(items)).toEqual([
      "Lire",
      "Lire ensuite",
      "Ajouter à la file",
      "—",
      "Ajouter à une playlist",
      "Ajouter aux favoris",
      "—",
      "Aller à l'artiste",
    ]);
    for (const i of items) if (i !== "separator") expect(i.icon).toBeDefined();
  });

  it("sous-menu playlist : « Nouvelle playlist… » ouvre la feuille existante, puis les playlists", () => {
    const a = actions();
    const sub = byLabel(albumMenuItems(album, a, new Set(), playlists), "Ajouter à une playlist").submenu!;
    expect(labels(sub)).toEqual(["Nouvelle playlist…", "—", "Nuit", "Route"]);
    byLabel(sub, "Nouvelle playlist…").onSelect!();
    expect(a.albumAddToPlaylist).toHaveBeenCalledWith(album);
    byLabel(sub, "Route").onSelect!();
    expect(a.addToPlaylist).toHaveBeenCalledWith(playlists[1], album.tracks);
    // Sans playlist existante : seule l'entrée de création reste.
    const bare = byLabel(albumMenuItems(album, a, new Set()), "Ajouter à une playlist").submenu!;
    expect(labels(bare)).toEqual(["Nouvelle playlist…"]);
  });

  it("chaque entrée appelle l'action correspondante avec l'album", () => {
    const a = actions();
    const items = albumMenuItems(album, a, new Set());
    byLabel(items, "Lire").onSelect!();
    byLabel(items, "Lire ensuite").onSelect!();
    byLabel(items, "Ajouter à la file").onSelect!();
    byLabel(items, "Aller à l'artiste").onSelect!();
    expect(a.playAlbum).toHaveBeenCalledWith(album);
    expect(a.albumPlayNext).toHaveBeenCalledWith(album);
    expect(a.albumAddToQueue).toHaveBeenCalledWith(album);
    expect(a.goToArtist).toHaveBeenCalledWith("Sakamoto");
    expect(toastMessages()).toEqual(["« async » sera lu ensuite", "« async » ajouté à la file"]);
  });

  it("favoris : ajoute les pistes non favorites ; album déjà favori → retire toutes ses favorites", () => {
    const a = actions();
    byLabel(albumMenuItems(album, a, new Set()), "Ajouter aux favoris").onSelect!();
    expect(a.toggleFavorite.mock.calls).toEqual([[1], [2]]);

    const b = actions();
    byLabel(albumMenuItems(album, b, new Set([2])), "Retirer des favoris").onSelect!();
    expect(b.toggleFavorite.mock.calls).toEqual([[2]]);
    expect(toastMessages()).toEqual(["« async » ajouté aux favoris", "« async » retiré des favoris"]);
  });

  it("titre long : le nom est raccourci, le verbe du toast reste lisible", () => {
    const long: Album = { ...album, title: "…And Justice for All (Remastered Deluxe Box Set)" };
    byLabel(albumMenuItems(long, actions(), new Set()), "Lire ensuite").onSelect!();
    expect(toastMessages()).toEqual(["« …And Justice for All (Remaste… » sera lu ensuite"]);
  });

  it("album sans piste : lecture et playlist désactivées ; artiste inconnu : lien désactivé", () => {
    const empty: Album = { ...album, artist: "", tracks: [] };
    const items = albumMenuItems(empty, actions(), new Set());
    expect(byLabel(items, "Lire").disabled).toBe(true);
    expect(byLabel(items, "Ajouter aux favoris").disabled).toBe(true);
    expect(byLabel(items, "Ajouter à une playlist").disabled).toBe(true);
    expect(byLabel(items, "Aller à l'artiste").disabled).toBe(true);
  });
});

describe("trackMenuItems", () => {
  function tActions() {
    return {
      play: vi.fn<(t: TrackRow) => void>(),
      playNext: vi.fn<(t: readonly TrackRow[]) => void>(),
      addToQueue: vi.fn<(t: readonly TrackRow[]) => void>(),
      newPlaylist: vi.fn<(t: readonly TrackRow[], label: string) => void>(),
      addToPlaylist: vi.fn<(p: { id: number; name: string }, t: readonly TrackRow[]) => void>(),
      toggleFavorite: vi.fn<(id: number) => void>(),
      goToAlbum: vi.fn<(albumId: number) => void>(),
      goToArtist: vi.fn<(artist: string) => void>(),
    } satisfies TrackMenuActions;
  }
  const t = tr(3);

  it("entrées d'un titre, avec les liens album/artiste", () => {
    const a = tActions();
    const items = trackMenuItems(t, a, new Set(), playlists);
    expect(labels(items)).toEqual([
      "Lire",
      "Lire ensuite",
      "Ajouter à la file",
      "—",
      "Ajouter à une playlist",
      "Ajouter aux favoris",
      "—",
      "Aller à l'album",
      "Aller à l'artiste",
    ]);
    byLabel(items, "Lire").onSelect!();
    byLabel(items, "Lire ensuite").onSelect!();
    byLabel(items, "Ajouter à la file").onSelect!();
    byLabel(items, "Ajouter aux favoris").onSelect!();
    byLabel(items, "Aller à l'album").onSelect!();
    byLabel(items, "Aller à l'artiste").onSelect!();
    expect(a.play).toHaveBeenCalledWith(t);
    expect(a.playNext).toHaveBeenCalledWith([t]);
    expect(a.addToQueue).toHaveBeenCalledWith([t]);
    expect(a.toggleFavorite).toHaveBeenCalledWith(3);
    expect(a.goToAlbum).toHaveBeenCalledWith(9);
    expect(a.goToArtist).toHaveBeenCalledWith("A");
    expect(toastMessages()).toEqual([
      "« t3 » sera lu ensuite",
      "« t3 » ajouté à la file",
      "« t3 » ajouté aux favoris",
    ]);
  });

  it("favori → « Retirer des favoris » ; sous-menu playlist ; « Aller à l'album » masquable", () => {
    const a = tActions();
    const items = trackMenuItems(t, a, new Set([3]), playlists, { hideAlbumLink: true });
    expect(labels(items)).not.toContain("Aller à l'album");
    byLabel(items, "Retirer des favoris").onSelect!();
    expect(a.toggleFavorite).toHaveBeenCalledWith(3);
    const sub = byLabel(items, "Ajouter à une playlist").submenu!;
    byLabel(sub, "Nouvelle playlist…").onSelect!();
    byLabel(sub, "Nuit").onSelect!();
    expect(a.newPlaylist).toHaveBeenCalledWith([t], "t3");
    expect(a.addToPlaylist).toHaveBeenCalledWith(playlists[0], [t]);
  });

  it("entrées supplémentaires (page playlist) : ajoutées en fin, après un séparateur", () => {
    const a = tActions();
    const remove = vi.fn();
    const items = trackMenuItems(t, a, new Set(), playlists, {
      extra: [{ label: "Retirer de la playlist", danger: true, onSelect: remove }],
    });
    expect(labels(items).slice(-3)).toEqual(["Aller à l'artiste", "—", "Retirer de la playlist"]);
    byLabel(items, "Retirer de la playlist").onSelect!();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("selectionMenuItems (vue Titres)", () => {
  function sActions() {
    return {
      play: vi.fn<(t: TrackRow) => void>(),
      playTracks: vi.fn<(t: readonly TrackRow[]) => void>(),
      playNext: vi.fn<(t: readonly TrackRow[]) => void>(),
      addToQueue: vi.fn<(t: readonly TrackRow[]) => void>(),
      newPlaylist: vi.fn<(t: readonly TrackRow[], label: string) => void>(),
      addToPlaylist: vi.fn<(p: { id: number; name: string }, t: readonly TrackRow[]) => void>(),
      toggleFavorite: vi.fn<(id: number) => void>(),
      goToAlbum: vi.fn<(albumId: number) => void>(),
      goToArtist: vi.fn<(artist: string) => void>(),
    } satisfies SelectionMenuActions;
  }

  it("un seul titre : menu d'un titre ; « Lire toutes les versions » pour un lead regroupé", () => {
    const a = sActions();
    const lead = tr(3);
    const versions = [tr(5), tr(8)];
    const items = selectionMenuItems([lead], a, new Set(), playlists, { versions });
    expect(labels(items).slice(0, 3)).toEqual(["Lire", "Lire toutes les versions", "Lire ensuite"]);
    byLabel(items, "Lire toutes les versions").onSelect!();
    expect(a.playTracks).toHaveBeenCalledWith([lead, ...versions]);
    // Sans versions : exactement le menu d'un titre.
    expect(labels(selectionMenuItems([lead], a, new Set(), playlists))).not.toContain("Lire toutes les versions");
  });

  it("plusieurs titres : actions sur toute la sélection, libellés au pluriel", () => {
    const a = sActions();
    const sel = [tr(1), tr(2), tr(4)];
    const items = selectionMenuItems(sel, a, new Set([2]), playlists);
    expect(labels(items)).toEqual([
      "Lire",
      "Lire ensuite",
      "Ajouter à la file",
      "—",
      "Ajouter à une playlist",
      "Ajouter aux favoris",
    ]);
    byLabel(items, "Lire").onSelect!();
    byLabel(items, "Lire ensuite").onSelect!();
    byLabel(items, "Ajouter à la file").onSelect!();
    byLabel(items, "Ajouter aux favoris").onSelect!();
    expect(a.playTracks).toHaveBeenCalledWith(sel);
    expect(a.playNext).toHaveBeenCalledWith(sel);
    expect(a.addToQueue).toHaveBeenCalledWith(sel);
    // Seuls les titres non favoris sont marqués.
    expect(a.toggleFavorite.mock.calls.map((c) => c[0])).toEqual([1, 4]);
    expect(toastMessages()).toEqual([
      "3 titres seront lus ensuite",
      "3 titres ajoutés à la file",
      "3 titres ajoutés aux favoris",
    ]);
    const sub = byLabel(items, "Ajouter à une playlist").submenu!;
    byLabel(sub, "Route").onSelect!();
    expect(a.addToPlaylist).toHaveBeenCalledWith(playlists[1], sel);
  });

  it("tous favoris → « Retirer des favoris » les retire tous", () => {
    const a = sActions();
    const items = selectionMenuItems([tr(1), tr(2)], a, new Set([1, 2]), playlists);
    byLabel(items, "Retirer des favoris").onSelect!();
    expect(a.toggleFavorite.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });
});
