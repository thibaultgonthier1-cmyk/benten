import { describe, expect, it } from "vitest";
import {
  albumAddedAt,
  albumAddedKey,
  albumIsFavorite,
  albumSummary,
  canResume,
  arrangeAlbums,
  discGroups,
  formatTotal,
  gridLayout,
  GRID_MAX_COLS,
  groupVersions,
  selectionAfterClick,
  sortTracks,
  summaryLine,
  versionInfo,
  versionName,
  versionRows,
} from "../src/renderer/lib/viewModels";
import { describeQuality, groupTracksToAlbums, type Album } from "../src/renderer/lib/library";
import type { TrackRow } from "../src/shared/types";

const track = (id: number, over: Partial<TrackRow> = {}): TrackRow =>
  ({
    id,
    path: `/m/${id}.flac`,
    title: `t${id}`,
    artist: "A",
    album: "Al",
    albumArtist: null,
    albumId: 1,
    trackNo: id,
    discNo: null,
    durationSec: 100,
    format: "flac",
    sampleRate: 44100,
    bitDepth: 16,
    playable: true,
    artKey: null,
    mtimeMs: null,
    sizeBytes: null,
    addedAtMs: null,
    ...over,
  }) as TrackRow;

const album = (id: number, title: string, artist: string, tracks: TrackRow[]): Album => ({
  id,
  title,
  artist,
  artKey: null,
  tracks,
});

describe("albumSummary", () => {
  it("compte, somme les durées et retient la qualité la plus haute (24 bit)", () => {
    const t16 = track(1, { durationSec: 180, bitDepth: 16, sampleRate: 44100 });
    const t24a = track(2, { durationSec: 200, bitDepth: 24, sampleRate: 44100 });
    const t24b = track(3, { durationSec: 220, bitDepth: 24, sampleRate: 44100 });
    const s = albumSummary(album(1, "X", "A", [t16, t24a, t24b]));
    expect(s.trackCount).toBe(3);
    expect(s.totalSec).toBe(600);
    expect(s.quality).toBe(describeQuality(t24a).label);
    expect(s.quality).not.toBe(describeQuality(t16).label);
  });

  it("la piste 24 bit l'emporte même placée en dernier ; album vide → qualité vide", () => {
    const s = albumSummary(
      album(1, "X", "A", [track(1, { bitDepth: 16 }), track(2, { bitDepth: 24, sampleRate: 96000 })]),
    );
    expect(s.quality).toBe("FLAC · 24-bit/96 kHz");
    expect(albumSummary(album(2, "Y", "A", []))).toEqual({ trackCount: 0, totalSec: 0, quality: "" });
  });

  it("sans perte > avec perte, puis fréquence", () => {
    const mp3 = track(1, { format: "mp3", bitDepth: null, sampleRate: 48000 });
    const flac = track(2, { bitDepth: 16, sampleRate: 44100 });
    expect(albumSummary(album(1, "X", "A", [mp3, flac])).quality).toBe(describeQuality(flac).label);
  });

  it("summaryLine : « 3 titres · 10 min · qualité » (singulier pour 1 titre)", () => {
    const one = album(1, "X", "A", [track(1, { durationSec: 600, bitDepth: 24 })]);
    expect(summaryLine(one)).toBe("1 titre · 10 min · FLAC · 24-bit/44.1 kHz");
    const three = album(2, "Y", "A", [track(1), track(2), track(3)]);
    expect(summaryLine(three)).toBe("3 titres · 5 min · FLAC · 16-bit/44.1 kHz");
  });
});

describe("discGroups", () => {
  it("disques [1,1,2] → 2 groupes, ordre préservé", () => {
    const tracks = [track(1, { discNo: 1 }), track(2, { discNo: 1 }), track(3, { discNo: 2 })];
    const groups = discGroups(tracks);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ disc: 1, tracks: [tracks[0], tracks[1]] });
    expect(groups[1]).toEqual({ disc: 2, tracks: [tracks[2]] });
  });

  it("sans discNo → un seul groupe disc:null", () => {
    const tracks = [track(1), track(2)];
    expect(discGroups(tracks)).toEqual([{ disc: null, tracks }]);
  });

  it("liste vide → aucun groupe ; discNo partiel → les pistes sans disque restent groupées à part", () => {
    expect(discGroups([])).toEqual([]);
    const tracks = [track(1, { discNo: 1 }), track(2), track(3, { discNo: 1 })];
    expect(discGroups(tracks).map((g) => [g.disc, g.tracks.map((t) => t.id)])).toEqual([
      [1, [1, 3]],
      [null, [2]],
    ]);
  });
});

describe("formatTotal", () => {
  it("minutes sous l'heure, « h mm » au-delà", () => {
    expect(formatTotal(600)).toBe("10 min");
    expect(formatTotal(3900)).toBe("1 h 05");
    expect(formatTotal(0)).toBe("0 min");
    expect(formatTotal(3599)).toBe("1 h 00");
    expect(formatTotal(7322)).toBe("2 h 02");
    expect(formatTotal(Number.NaN)).toBe("0 min");
  });
});

describe("arrangeAlbums", () => {
  const a = album(10, "beta", "Zed", [track(5)]);
  const b = album(11, "Alpha", "mike", [track(9, { bitDepth: null, format: "mp3" })]);
  const c = album(12, "gamma", "Abe", [track(7), track(2)]);
  const all = [a, b, c];
  const none = new Set<number>();

  it("« Ajouté » = id de piste minimal (ordre d'insertion), le plus récent d'abord", () => {
    expect(albumAddedKey(c)).toBe(2);
    expect(albumAddedKey(album(1, "x", "y", []))).toBe(Number.POSITIVE_INFINITY);
    const r = arrangeAlbums(all, { sort: "added", losslessOnly: false, favoritesOnly: false }, none);
    expect(r.map((x) => x.id)).toEqual([11, 10, 12]);
  });

  it("« Ajouté » = plus petite date de création (addedAtMs) de l'album d'abord ; repli sur l'id", () => {
    const x = album(20, "x", "A", [track(1, { addedAtMs: 500 }), track(2, { addedAtMs: 900 })]);
    const y = album(21, "y", "A", [track(3, { addedAtMs: 700 })]);
    const z = album(22, "z", "A", [track(9, { addedAtMs: null })]);
    expect(albumAddedAt(x)).toBe(500);
    expect(albumAddedAt(z)).toBeNull();
    // Plus récent d'abord (y : 700 > x : 500) ; sans date en dernier.
    const r = arrangeAlbums([x, z, y], { sort: "added", losslessOnly: false, favoritesOnly: false }, none);
    expect(r.map((a) => a.id)).toEqual([21, 20, 22]);
  });

  it("tri Titre / Artiste insensible à la casse, sans muter l'entrée", () => {
    const before = all.slice();
    expect(
      arrangeAlbums(all, { sort: "title", losslessOnly: false, favoritesOnly: false }, none).map((x) => x.id),
    ).toEqual([11, 10, 12]);
    expect(
      arrangeAlbums(all, { sort: "artist", losslessOnly: false, favoritesOnly: false }, none).map((x) => x.id),
    ).toEqual([12, 11, 10]);
    expect(all).toEqual(before);
  });

  it("filtres Sans perte et Favoris (un album est favori dès qu'une piste l'est)", () => {
    expect(
      arrangeAlbums(all, { sort: "title", losslessOnly: true, favoritesOnly: false }, none).map((x) => x.id),
    ).toEqual([10, 12]);
    const fav = new Set([7]);
    expect(albumIsFavorite(c, fav)).toBe(true);
    expect(albumIsFavorite(a, fav)).toBe(false);
    expect(
      arrangeAlbums(all, { sort: "title", losslessOnly: false, favoritesOnly: true }, fav).map((x) => x.id),
    ).toEqual([12]);
  });
});

describe("canResume", () => {
  it("bascule lecture/pause seulement si la piste courante est jouable en l'état", () => {
    expect(canResume("playing")).toBe(true);
    expect(canResume("paused")).toBe(true);
    expect(canResume("ready")).toBe(true);
    expect(canResume("loading")).toBe(true);
    // Erreur, fin de file, rien de chargé : il faut relancer l'album, pas « reprendre ».
    expect(canResume("error")).toBe(false);
    expect(canResume("ended")).toBe(false);
    expect(canResume("idle")).toBe(false);
  });
});

describe("gridLayout", () => {
  it("le nombre de colonnes suit la largeur (min 176 px, gouttière 24 px)", () => {
    expect(gridLayout(1000, 176, 24)).toEqual({ cols: 5, cardW: 180 });
    expect(gridLayout(100, 176, 24)).toEqual({ cols: 1, cardW: 100 });
    expect(gridLayout(0, 176, 24)).toEqual({ cols: 1, cardW: 176 });
    expect(gridLayout(1376, 176, 24).cols).toBe(7);
  });

  it("grand écran (3840 px) : colonnes plafonnées, les tuiles grandissent — DOM < 120 tuiles", () => {
    const { cols, cardW } = gridLayout(3840, 176, 24);
    expect(cols).toBe(GRID_MAX_COLS);
    expect(cardW).toBe(Math.floor((3840 - 24 * (GRID_MAX_COLS - 1)) / GRID_MAX_COLS));
    // Rangées montées au pire sur un écran 4K (2160 px de haut) : visibles + 1 + 2 × 2 de marge.
    const rowH = cardW + 58 + 28;
    const mountedRows = Math.ceil(2160 / rowH) + 1 + 2 * 2;
    expect(mountedRows * cols).toBeLessThan(120);
  });
});

describe("groupTracksToAlbums (multi-disques)", () => {
  it("ordonne par disque puis par n° de piste", () => {
    const tracks = [
      track(1, { discNo: 2, trackNo: 1 }),
      track(2, { discNo: 1, trackNo: 2 }),
      track(3, { discNo: 1, trackNo: 1 }),
      track(4, { discNo: 2, trackNo: 2 }),
    ];
    const [al] = groupTracksToAlbums(tracks);
    expect(al!.tracks.map((t) => t.id)).toEqual([3, 2, 1, 4]);
  });
});

/* ------------------------------------ Tâche 7 : vue Titres ------------------------------------ */

describe("sortTracks", () => {
  const t = (id: number, title: string, over: Partial<TrackRow> = {}) => track(id, { title, ...over });

  it("« added » / asc → ids croissants ; desc → décroissants ; sans muter l'entrée", () => {
    const input = [t(5, "a"), t(2, "b"), t(9, "c")];
    const before = input.slice();
    expect(sortTracks(input, "added", "asc").map((x) => x.id)).toEqual([2, 5, 9]);
    expect(sortTracks(input, "added", "desc").map((x) => x.id)).toEqual([9, 5, 2]);
    expect(input).toEqual(before);
  });

  it("« added » trie par addedAtMs (date de création du fichier), absents en dernier, puis id", () => {
    const input = [
      t(1, "a", { addedAtMs: 300 }),
      t(2, "b", { addedAtMs: null }),
      t(3, "c", { addedAtMs: 100 }),
      t(4, "d", { addedAtMs: 100 }),
      t(5, "e", { addedAtMs: 200 }),
    ];
    expect(sortTracks(input, "added", "asc").map((x) => x.id)).toEqual([3, 4, 5, 1, 2]);
    // Décroissant : plus récent d'abord, égalités par id décroissant, absents toujours en dernier.
    expect(sortTracks(input, "added", "desc").map((x) => x.id)).toEqual([1, 5, 4, 3, 2]);
  });

  it("« title » / asc : insensible à la casse et aux accents (eau, Éclat, Zèbre)", () => {
    const input = [t(1, "Zèbre"), t(2, "Éclat"), t(3, "eau")];
    expect(sortTracks(input, "title", "asc").map((x) => x.title)).toEqual(["eau", "Éclat", "Zèbre"]);
    expect(sortTracks(input, "title", "desc").map((x) => x.title)).toEqual(["Zèbre", "Éclat", "eau"]);
  });

  it("égalité → départage par id (croissant, quel que soit le sens)", () => {
    const input = [t(7, "Same"), t(3, "same"), t(5, "SAME")];
    expect(sortTracks(input, "title", "asc").map((x) => x.id)).toEqual([3, 5, 7]);
    expect(sortTracks(input, "title", "desc").map((x) => x.id)).toEqual([3, 5, 7]);
  });

  it("« artist » / « album » / « duration »", () => {
    const input = [
      t(1, "x", { artist: "beta", album: "Z", durationSec: 300 }),
      t(2, "y", { artist: "Alpha", album: "Y", durationSec: 120 }),
      t(3, "z", { artist: "alpha", album: "X", durationSec: 200 }),
    ];
    expect(sortTracks(input, "artist", "asc").map((x) => x.id)).toEqual([3, 2, 1]);
    expect(sortTracks(input, "album", "asc").map((x) => x.id)).toEqual([3, 2, 1]);
    expect(sortTracks(input, "duration", "asc").map((x) => x.id)).toEqual([2, 3, 1]);
    expect(sortTracks(input, "duration", "desc").map((x) => x.id)).toEqual([1, 3, 2]);
  });
});

describe("selectionAfterClick", () => {
  const none = { shift: false, ctrl: false };

  it("clic simple = sélection unique, l'ancre suit", () => {
    const r = selectionAfterClick(new Set([0, 4]), 2, none, 0);
    expect([...r.sel]).toEqual([2]);
    expect(r.anchor).toBe(2);
  });

  it("Maj+clic = plage depuis l'ancre (dans les deux sens) ; l'ancre reste", () => {
    const r = selectionAfterClick(new Set([2]), 5, { shift: true, ctrl: false }, 2);
    expect([...r.sel].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(r.anchor).toBe(2);
    const up = selectionAfterClick(new Set([5]), 3, { shift: true, ctrl: false }, 5);
    expect([...up.sel].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    // Sans ancre : la plage part de la ligne cliquée.
    expect([...selectionAfterClick(new Set(), 3, { shift: true, ctrl: false }, null).sel]).toEqual([3]);
  });

  it("Ctrl+clic = bascule (retire / ajoute), sans toucher l'entrée", () => {
    const input = new Set([2, 3, 4, 5]);
    const r = selectionAfterClick(input, 3, { shift: false, ctrl: true }, 2);
    expect([...r.sel].sort((a, b) => a - b)).toEqual([2, 4, 5]);
    expect(r.anchor).toBe(3);
    expect(input.has(3)).toBe(true);
    const add = selectionAfterClick(r.sel, 9, { shift: false, ctrl: true }, 3);
    expect(add.sel.has(9)).toBe(true);
  });

  it("Ctrl+Maj+clic = ajoute la plage à la sélection existante", () => {
    const r = selectionAfterClick(new Set([0]), 4, { shift: true, ctrl: true }, 2);
    expect([...r.sel].sort((a, b) => a - b)).toEqual([0, 2, 3, 4]);
  });
});

describe("versionInfo", () => {
  it("sans suffixe de version : pas de tag, base normalisée", () => {
    expect(versionInfo("LUZ ROJA")).toEqual({ base: "luz roja", tag: null });
    expect(versionInfo("  Éclat   de  Lune ")).toEqual({ base: "eclat de lune", tag: null });
  });

  it("suffixe entre () / [] ou après « - »", () => {
    expect(versionInfo("LUZ ROJA (Slowed)")).toEqual({ base: "luz roja", tag: "Slowed" });
    expect(versionInfo("PALADIN - Super Slowed")).toEqual({ base: "paladin", tag: "Super Slowed" });
    expect(versionInfo("MONTAGEM ROYAL (ULTRA SLOWED)")).toEqual({ base: "montagem royal", tag: "ULTRA SLOWED" });
    expect(versionInfo("LUZ ROJA (Vocal Version Remix - Slowed)").tag).toBe("Vocal Version Remix - Slowed");
    expect(versionInfo("Song [Sped Up]")).toEqual({ base: "song", tag: "Sped Up" });
    expect(versionInfo("Song (Tiktok Version)").tag).toBe("Tiktok Version");
    expect(versionInfo("Song - Radio Edit").tag).toBe("Radio Edit");
    expect(versionInfo("Song (2011 Remaster)").tag).toBe("2011 Remaster");
    expect(versionInfo("Song (Nightcore)").tag).toBe("Nightcore");
  });

  it("suffixes cumulés → tous détachés, tag lisible", () => {
    const v = versionInfo("Amor Na Praia (Slowed to Perfection) [Reverb]");
    expect(v.base).toBe("amor na praia");
    expect(v.tag).toContain("Slowed to Perfection");
    expect(v.tag).toContain("Reverb");
    expect(v.tag).toBe("Slowed to Perfection · Reverb");
  });

  it("suffixe sans mot-clé : ce n'est pas une version (reste dans la base)", () => {
    expect(versionInfo("Song (feat. X)")).toEqual({ base: "song (feat. x)", tag: null });
    expect(versionInfo("Album (Deluxe)").tag).toBeNull();
    expect(versionInfo("Song - Pt. 2").tag).toBeNull();
    // Une version après (ou avant) un featuring : le featuring reste dans la base.
    expect(versionInfo("Song (feat. X) (Slowed)")).toEqual({ base: "song (feat. x)", tag: "Slowed" });
    expect(versionInfo("Song (Slowed) (feat. X)")).toEqual({ base: "song (feat. x)", tag: "Slowed" });
  });

  it("mots-clés insensibles à la casse et aux accents, en mot entier", () => {
    expect(versionInfo("Song (SLOWÉD)").tag).toBe("SLOWÉD");
    expect(versionInfo("Song (Liveliness)").tag).toBeNull();
    expect(versionInfo("Song (Credit)").tag).toBeNull();
  });

  it("un titre entièrement « version » garde sa base (jamais vide)", () => {
    expect(versionInfo("(Slowed)").base).toBe("(slowed)");
    expect(versionInfo("(Slowed)").tag).toBeNull();
  });
});

describe("versionName", () => {
  it("titre sans ses suffixes de version, casse et accents d'origine", () => {
    expect(versionName("LUZ ROJA (VIP Mix - Super Slowed)")).toBe("LUZ ROJA");
    expect(versionName("PALADIN - Super Slowed")).toBe("PALADIN");
    expect(versionName("Amor Na Praia (Slowed to Perfection) [Reverb]")).toBe("Amor Na Praia");
    expect(versionName("TE CONOCÍ (Super Slowed)")).toBe("TE CONOCÍ");
    expect(versionName("Song (Slowed) (feat. X)")).toBe("Song (feat. X)");
    expect(versionName("Song (feat. X)")).toBe("Song (feat. X)");
    expect(versionName("(Slowed)")).toBe("(Slowed)");
  });
});

describe("groupVersions", () => {
  const t = (id: number, title: string, artist = "Artist") => track(id, { title, artist });

  it("LUZ ROJA + (Slowed) + (Vocal Version Remix - Slowed), même artiste → 1 groupe, lead « LUZ ROJA »", () => {
    const tracks = [t(4, "LUZ ROJA (Slowed)"), t(2, "LUZ ROJA"), t(9, "LUZ ROJA (Vocal Version Remix - Slowed)")];
    const g = groupVersions(tracks);
    expect(g).toHaveLength(1);
    expect(g[0]!.lead.title).toBe("LUZ ROJA");
    expect(g[0]!.versions.map((x) => x.id)).toEqual([4, 9]);
  });

  it("artiste principal : « A, B », « A & B », « A feat. B », « A ft. B », « A x B » → A", () => {
    const tracks = [
      t(1, "Song", "Kordhell"),
      t(2, "Song (Slowed)", "Kordhell, Scarlxrd"),
      t(3, "Song (Sped Up)", "KORDHELL & DJ X"),
      t(4, "Song (Remix)", "Kordhell feat. Y"),
      t(5, "Song (Edit)", "Kordhell ft. Z"),
      t(6, "Song (Live)", "Kordhell x Mythic"),
    ];
    const g = groupVersions(tracks);
    expect(g).toHaveLength(1);
    expect(g[0]!.versions).toHaveLength(5);
  });

  it("même titre chez deux artistes différents → 2 groupes", () => {
    const g = groupVersions([t(1, "Intro", "A"), t(2, "Intro", "B")]);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.versions.length === 0)).toBe(true);
  });

  it("sans original : lead = plus petit id (HEAVENLY JUMPSTYLE ×2 + Tiktok Version)", () => {
    const tracks = [
      t(30, "HEAVENLY JUMPSTYLE (Tiktok Version)"),
      t(12, "HEAVENLY JUMPSTYLE (Slowed)"),
      t(20, "HEAVENLY JUMPSTYLE (Slowed)"),
    ];
    const g = groupVersions(tracks);
    expect(g).toHaveLength(1);
    expect(g[0]!.lead.id).toBe(12);
    expect(g[0]!.versions.map((x) => x.id)).toEqual([20, 30]);
  });

  it("plusieurs pistes sans tag : lead = la plus petite id ; les autres sont des versions", () => {
    const g = groupVersions([t(8, "Same"), t(3, "same"), t(5, "Same (Slowed)")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.lead.id).toBe(3);
    expect(g[0]!.versions.map((x) => x.id)).toEqual([5, 8]);
  });

  it("« Amor Na Praia (Slowed to Perfection) [Reverb] » rejoint « Amor Na Praia »", () => {
    const g = groupVersions([t(1, "Amor Na Praia"), t(2, "Amor Na Praia (Slowed to Perfection) [Reverb]")]);
    expect(g).toHaveLength(1);
    expect(versionInfo(g[0]!.versions[0]!.title).tag).toBe("Slowed to Perfection · Reverb");
  });

  it("l'ordre des groupes suit l'ordre d'entrée de leur lead (compatible sortTracks)", () => {
    const tracks = [t(5, "B (Slowed)"), t(1, "A"), t(9, "C"), t(7, "B"), t(2, "A (Remix)")];
    // Leads : A (pos 1), C (pos 2), B (id 7, pos 3).
    expect(groupVersions(tracks).map((x) => x.lead.id)).toEqual([1, 9, 7]);
    const sorted = sortTracks(tracks, "title", "desc");
    expect(groupVersions(sorted).map((x) => x.lead.title)).toEqual(["C", "B", "A"]);
  });

  it("groupe d'une seule piste → versions: [] ; liste vide → aucun groupe", () => {
    const g = groupVersions([t(1, "Solo")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.lead.id).toBe(1);
    expect(g[0]!.versions).toEqual([]);
    expect(groupVersions([])).toEqual([]);
  });
});

describe("versionRows", () => {
  const t = (id: number, title: string) => track(id, { title });
  const groups = groupVersions([t(1, "A"), t(2, "A (Slowed)"), t(3, "A (Remix)"), t(4, "B")]);

  it("replié : une ligne par lead, avec le nombre de versions", () => {
    const rows = versionRows(groups, new Set());
    expect(rows.map((r) => [r.track.id, r.depth, r.versionCount])).toEqual([
      [1, 0, 2],
      [4, 0, 0],
    ]);
    expect(rows[0]!.expanded).toBe(false);
  });

  it("déplié : les versions suivent leur lead, indentées, avec leur tag", () => {
    const rows = versionRows(groups, new Set([1]));
    expect(rows.map((r) => [r.track.id, r.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 0],
    ]);
    expect(rows[0]!.expanded).toBe(true);
    expect(rows[1]!.tag).toBe("Slowed");
    expect(rows[1]!.groupId).toBe(1);
    expect(rows[0]!.groupId).toBe(1);
  });
});
