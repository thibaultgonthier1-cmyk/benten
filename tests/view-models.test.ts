import { describe, expect, it } from "vitest";
import {
  albumAddedKey,
  albumIsFavorite,
  albumSummary,
  canResume,
  arrangeAlbums,
  discGroups,
  formatTotal,
  gridLayout,
  GRID_MAX_COLS,
  summaryLine,
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
