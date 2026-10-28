import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/main/library/db";
import {
  getAlbums,
  getAllTracks,
  getArtists,
  getTrackByPath,
  getTracksByAlbum,
  removeTracks,
  upsertTracks,
} from "../src/main/library/repository";
import type { TrackInput } from "../src/shared/types";

function track(over: Partial<TrackInput> & { path: string }): TrackInput {
  return {
    title: "Untitled",
    artist: "Artist A",
    album: "Album X",
    albumArtist: null,
    trackNo: 1,
    discNo: null,
    durationSec: 180,
    format: "flac",
    sampleRate: 44100,
    bitDepth: 16,
    playable: true,
    artKey: null,
    mtimeMs: null,
    sizeBytes: null,
    ...over,
  };
}

describe("repository", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "benten-db-"));
    db = openDb(join(dir, "library.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const records = (): TrackInput[] => [
    track({ path: "/m/a/02.flac", title: "Second", trackNo: 2 }),
    track({ path: "/m/a/01.flac", title: "First", trackNo: 1 }),
    track({ path: "/m/b/01.mp3", title: "Other", artist: "Artist B", album: "Album Y", format: "mp3", bitDepth: null }),
  ];

  it("groups tracks into albums with the right trackCount", () => {
    upsertTracks(db, records());
    const albums = getAlbums(db, { limit: 50, offset: 0 });
    expect(albums).toHaveLength(2);
    const x = albums.find((a) => a.title === "Album X")!;
    expect(x.trackCount).toBe(2);
    expect(x.artist).toBe("Artist A");
    expect(albums.find((a) => a.title === "Album Y")!.trackCount).toBe(1);
  });

  it("returns an album's tracks sorted by trackNo", () => {
    upsertTracks(db, records());
    const x = getAlbums(db, { limit: 50, offset: 0 }).find((a) => a.title === "Album X")!;
    const rows = getTracksByAlbum(db, x.id);
    expect(rows.map((r) => r.title)).toEqual(["First", "Second"]);
    expect(rows.map((r) => r.trackNo)).toEqual([1, 2]);
    expect(rows[0]!.playable).toBe(true);
  });

  it("is idempotent on path (no duplicates, fields updated)", () => {
    upsertTracks(db, records());
    upsertTracks(db, [...records(), track({ path: "/m/a/01.flac", title: "First (remaster)", trackNo: 1 })]);
    const all = getAllTracks(db, { limit: 100, offset: 0 });
    expect(all).toHaveLength(3);
    expect(all.find((t) => t.path === "/m/a/01.flac")!.title).toBe("First (remaster)");
    const albums = getAlbums(db, { limit: 50, offset: 0 });
    expect(albums).toHaveLength(2);
    expect(albums.find((a) => a.title === "Album X")!.trackCount).toBe(2);
    expect(getArtists(db)).toHaveLength(2);
  });

  it("paginates getAllTracks and lists artists with counts", () => {
    upsertTracks(db, records());
    expect(getAllTracks(db, { limit: 2, offset: 0 })).toHaveLength(2);
    expect(getAllTracks(db, { limit: 2, offset: 2 })).toHaveLength(1);
    const artists = getArtists(db);
    expect(artists.map((a) => a.name)).toEqual(["Artist A", "Artist B"]);
    expect(artists[0]!.trackCount).toBe(2);
  });

  it("groups a compilation under its albumArtist (one album, track artists differ)", () => {
    upsertTracks(db, [
      track({ path: "/c/01.flac", title: "T1", artist: "Artist One", album: "Comp", albumArtist: "Various Artists", trackNo: 1 }),
      track({ path: "/c/02.flac", title: "T2", artist: "Artist Two", album: "Comp", albumArtist: "Various Artists", trackNo: 2 }),
    ]);
    const albums = getAlbums(db, { limit: 50, offset: 0 });
    const comp = albums.filter((a) => a.title === "Comp");
    expect(comp).toHaveLength(1);
    expect(comp[0]!.trackCount).toBe(2);
    expect(comp[0]!.artist).toBe("Various Artists");
  });

  it("sorts an album's tracks by disc then track (disc 1 before disc 2)", () => {
    upsertTracks(db, [
      track({ path: "/d/d2t1.flac", title: "Disc2", album: "Multi", albumArtist: "Band", discNo: 2, trackNo: 1 }),
      track({ path: "/d/d1t1.flac", title: "Disc1", album: "Multi", albumArtist: "Band", discNo: 1, trackNo: 1 }),
    ]);
    const multi = getAlbums(db, { limit: 50, offset: 0 }).find((a) => a.title === "Multi")!;
    const rows = getTracksByAlbum(db, multi.id);
    expect(rows.map((r) => r.title)).toEqual(["Disc1", "Disc2"]);
    expect(rows.map((r) => r.discNo)).toEqual([1, 2]);
  });

  it("round-trips albumArtist/discNo (not undefined) through getAllTracks/getTracksByAlbum", () => {
    upsertTracks(db, [
      track({ path: "/r/01.flac", title: "Round", artist: "Track Artist", album: "RT", albumArtist: "Album Artist", discNo: 3, trackNo: 7 }),
    ]);
    const all = getAllTracks(db, { limit: 10, offset: 0 });
    const row = all.find((t) => t.path === "/r/01.flac")!;
    expect(row.albumArtist).toBe("Album Artist");
    expect(row.discNo).toBe(3);
    expect(row.artist).toBe("Track Artist");
    const album = getAlbums(db, { limit: 50, offset: 0 }).find((a) => a.title === "RT")!;
    const byAlbum = getTracksByAlbum(db, album.id)[0]!;
    expect(byAlbum.albumArtist).toBe("Album Artist");
    expect(byAlbum.discNo).toBe(3);
  });

  it("removeTracks retire la piste, purge album/artiste vides, cascade les favoris et renvoie le compte", () => {
    upsertTracks(db, records());
    const target = getTrackByPath(db, "/m/b/01.mp3")!;
    expect(target).toBeDefined();
    // Un favori pointe cette piste : il doit disparaitre en cascade.
    db.prepare("INSERT INTO favorites (track_id, added_at) VALUES (?, ?)").run(target.id, Date.now());

    const removed = removeTracks(db, ["/m/b/01.mp3"]);
    expect(removed).toBe(1);
    expect(getTrackByPath(db, "/m/b/01.mp3")).toBeUndefined();

    // Album Y / Artist B n'etaient references que par cette piste -> purges.
    expect(getAlbums(db, { limit: 50, offset: 0 }).map((a) => a.title)).toEqual(["Album X"]);
    expect(getArtists(db).map((a) => a.name)).toEqual(["Artist A"]);
    expect(db.prepare("SELECT COUNT(*) FROM favorites").pluck().get()).toBe(0);

    // Album X / Artist A restent references par deux pistes -> conserves.
    expect(getAllTracks(db, { limit: 100, offset: 0 })).toHaveLength(2);
  });

  it("migrates by user_version and is reopenable", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    upsertTracks(db, records());
    const path = db.name;
    db.close();
    db = openDb(path);
    expect(getAllTracks(db, { limit: 10, offset: 0 })).toHaveLength(3);
  });
});
