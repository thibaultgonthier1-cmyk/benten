import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/main/library/db";
import {
  addSource,
  addToPlaylist,
  createPlaylist,
  deletePlaylist,
  getAlbums,
  getAllTracks,
  getArtists,
  getFavoriteIds,
  getPlaylists,
  getPlaylistTracks,
  getSources,
  getState,
  getTrackByPath,
  getTracksByAlbum,
  getTracksByIds,
  isFavorite,
  removeFromPlaylist,
  removeSource,
  removeTracks,
  renamePlaylist,
  reorderPlaylist,
  searchTracks,
  setFavorite,
  setState,
  upsertTracks,
} from "../src/main/library/repository";
import type { SortField, TrackInput } from "../src/shared/types";

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

  it("addSource is idempotent on path and getSources returns the rows", () => {
    addSource(db, "/m/a");
    addSource(db, "/m/b");
    addSource(db, "/m/a"); // doublon : ignore
    const sources = getSources(db);
    expect(sources.map((s) => s.path)).toEqual(["/m/a", "/m/b"]);
    for (const s of sources) {
      expect(typeof s.id).toBe("number");
      expect(typeof s.addedAt).toBe("number");
      expect(s.addedAt).toBeGreaterThan(0);
    }
  });

  it("removeSource deletes the row by id", () => {
    addSource(db, "/m/a");
    addSource(db, "/m/b");
    const toRemove = getSources(db).find((s) => s.path === "/m/a")!;
    removeSource(db, toRemove.id);
    expect(getSources(db).map((s) => s.path)).toEqual(["/m/b"]);
  });

  it("searchTracks matches title/artist/album case-insensitively (NOCASE, cross-column)", () => {
    upsertTracks(db, [
      track({ path: "/s/1.flac", title: "Café", artist: "Nobody", album: "Album Z" }),
      track({ path: "/s/2.flac", title: "Plain", artist: "CAFÉ latte", album: "Album Z" }),
      track({ path: "/s/3.flac", title: "x", artist: "Someone", album: "Café Bar" }),
      track({ path: "/s/4.flac", title: "unrelated", artist: "zzz", album: "Other" }),
    ]);
    const rows = searchTracks(db, "caf", { limit: 50, offset: 0 });
    expect(rows.map((r) => r.path).sort()).toEqual(["/s/1.flac", "/s/2.flac", "/s/3.flac"]);
  });

  it("searchTracks treats LIKE metacharacters (% and _) in the query literally (escaped)", () => {
    upsertTracks(db, [
      track({ path: "/p/1.flac", title: "50% Off", artist: "A", album: "AA" }),
      track({ path: "/p/2.flac", title: "50 Fifty", artist: "A", album: "AA" }),
      track({ path: "/p/3.flac", title: "a_b", artist: "A", album: "AA" }),
      track({ path: "/p/4.flac", title: "axb", artist: "A", album: "AA" }),
    ]);
    // `%` ne doit PAS agir comme joker : seule la piste contenant un `%` littéral matche.
    expect(searchTracks(db, "50%", { limit: 50, offset: 0 }).map((r) => r.path)).toEqual(["/p/1.flac"]);
    // `_` idem : littéral, pas « n'importe quel caractère ».
    expect(searchTracks(db, "a_b", { limit: 50, offset: 0 }).map((r) => r.path)).toEqual(["/p/3.flac"]);
  });

  it("searchTracks returns [] for empty/whitespace query without querying", () => {
    upsertTracks(db, records());
    expect(searchTracks(db, "", { limit: 50, offset: 0 })).toEqual([]);
    expect(searchTracks(db, "   ", { limit: 50, offset: 0 })).toEqual([]);
  });

  it("searchTracks respects the page limit", () => {
    upsertTracks(db, [
      track({ path: "/l/1.flac", title: "match one", album: "ZZ" }),
      track({ path: "/l/2.flac", title: "match two", album: "ZZ" }),
      track({ path: "/l/3.flac", title: "match three", album: "ZZ" }),
    ]);
    expect(searchTracks(db, "match", { limit: 2, offset: 0 })).toHaveLength(2);
  });

  it("sorts albums by title NOCASE, asc then desc (whitelisted order)", () => {
    upsertTracks(db, [
      track({ path: "/o/b.flac", album: "b", albumArtist: "Band" }),
      track({ path: "/o/a.flac", album: "A", albumArtist: "Band" }),
      track({ path: "/o/c.flac", album: "c", albumArtist: "Band" }),
    ]);
    const asc = getAlbums(db, { limit: 50, offset: 0 }, { sort: "title", dir: "asc" });
    expect(asc.map((a) => a.title)).toEqual(["A", "b", "c"]);
    const desc = getAlbums(db, { limit: 50, offset: 0 }, { sort: "title", dir: "desc" });
    expect(desc.map((a) => a.title)).toEqual(["c", "b", "A"]);
  });

  it("sorts albums by total duration (SUM of track durations)", () => {
    upsertTracks(db, [
      track({ path: "/dur/short.flac", album: "Short", albumArtist: "Band", durationSec: 100 }),
      track({ path: "/dur/mid.flac", album: "Mid", albumArtist: "Band", durationSec: 200 }),
      track({ path: "/dur/long1.flac", album: "Long", albumArtist: "Band", durationSec: 200 }),
      track({ path: "/dur/long2.flac", album: "Long", albumArtist: "Band", durationSec: 250, trackNo: 2 }),
    ]);
    const asc = getAlbums(db, { limit: 50, offset: 0 }, { sort: "duration", dir: "asc" });
    expect(asc.map((a) => a.title)).toEqual(["Short", "Mid", "Long"]);
    const desc = getAlbums(db, { limit: 50, offset: 0 }, { sort: "duration", dir: "desc" });
    expect(desc.map((a) => a.title)).toEqual(["Long", "Mid", "Short"]);
  });

  it("falls back to the default sort for an unknown/injection sort field (no throw, no injection)", () => {
    upsertTracks(db, [
      track({ path: "/x/b.flac", album: "b", albumArtist: "Band" }),
      track({ path: "/x/a.flac", album: "A", albumArtist: "Band" }),
      track({ path: "/x/c.flac", album: "c", albumArtist: "Band" }),
    ]);
    const evil = "al.title); DROP TABLE albums;--" as unknown as SortField;
    const rows = getAlbums(db, { limit: 50, offset: 0 }, { sort: evil, dir: "asc" });
    // Retombe sur le tri par défaut (title asc), sans lever ni exécuter le DROP.
    expect(rows.map((a) => a.title)).toEqual(["A", "b", "c"]);
    // La table est intacte : une requête ultérieure renvoie toujours les 3 albums.
    expect(getAlbums(db, { limit: 50, offset: 0 })).toHaveLength(3);
  });

  it("falls back to default for prototype-named sort keys (__proto__/toString), no throw", () => {
    upsertTracks(db, [
      track({ path: "/pp/b.flac", title: "b", album: "b", albumArtist: "Band" }),
      track({ path: "/pp/a.flac", title: "A", album: "A", albumArtist: "Band" }),
      track({ path: "/pp/c.flac", title: "c", album: "c", albumArtist: "Band" }),
    ]);
    // Clés héritées d'Object.prototype : truthy par indexation, mais PAS des propriétés propres.
    // Elles doivent retomber sur le tri par défaut (title asc) sans lever (sinon db.prepare throw).
    for (const proto of ["__proto__", "toString", "constructor", "valueOf"]) {
      const key = proto as unknown as SortField;
      expect(() => getAlbums(db, { limit: 50, offset: 0 }, { sort: key })).not.toThrow();
      expect(getAlbums(db, { limit: 50, offset: 0 }, { sort: key }).map((a) => a.title)).toEqual([
        "A",
        "b",
        "c",
      ]);
      expect(() => getAllTracks(db, { limit: 50, offset: 0 }, { sort: key })).not.toThrow();
      expect(
        getAllTracks(db, { limit: 50, offset: 0 }, { sort: key }).map((t) => t.path),
      ).toEqual(["/pp/a.flac", "/pp/b.flac", "/pp/c.flac"]);
    }
  });

  it("filter.losslessOnly keeps only albums/tracks with a non-null bit_depth", () => {
    upsertTracks(db, [
      track({ path: "/ll/flac.flac", album: "Lossless", albumArtist: "Band", bitDepth: 16 }),
      track({ path: "/ll/mp3.mp3", album: "Lossy", albumArtist: "Band", bitDepth: null, format: "mp3" }),
    ]);
    const albums = getAlbums(db, { limit: 50, offset: 0 }, { filter: { losslessOnly: true } });
    expect(albums.map((a) => a.title)).toEqual(["Lossless"]);
    const tracks = getAllTracks(db, { limit: 50, offset: 0 }, { filter: { losslessOnly: true } });
    expect(tracks.map((t) => t.path)).toEqual(["/ll/flac.flac"]);
  });

  it("filter.favoritesOnly keeps only favorited albums/tracks (favorites inserted via raw SQL)", () => {
    upsertTracks(db, records());
    const fav = getTrackByPath(db, "/m/a/01.flac")!;
    db.prepare("INSERT INTO favorites (track_id, added_at) VALUES (?, ?)").run(fav.id, Date.now());
    const albums = getAlbums(db, { limit: 50, offset: 0 }, { filter: { favoritesOnly: true } });
    expect(albums.map((a) => a.title)).toEqual(["Album X"]);
    const tracks = getAllTracks(db, { limit: 50, offset: 0 }, { filter: { favoritesOnly: true } });
    expect(tracks.map((t) => t.path)).toEqual(["/m/a/01.flac"]);
  });

  it("setFavorite(true) marks a track favorite (isFavorite + getFavoriteIds), idempotent, and setFavorite(false) removes it", () => {
    upsertTracks(db, records());
    const t = getTrackByPath(db, "/m/a/01.flac")!;
    expect(isFavorite(db, t.id)).toBe(false);
    expect(getFavoriteIds(db)).toEqual([]);

    setFavorite(db, t.id, true);
    expect(isFavorite(db, t.id)).toBe(true);
    expect(getFavoriteIds(db)).toContain(t.id);

    // Idempotent : un second setFavorite(true) ne duplique pas (PK track_id + INSERT OR IGNORE).
    setFavorite(db, t.id, true);
    expect(getFavoriteIds(db).filter((id) => id === t.id)).toHaveLength(1);

    setFavorite(db, t.id, false);
    expect(isFavorite(db, t.id)).toBe(false);
    expect(getFavoriteIds(db)).not.toContain(t.id);
  });

  it("getAlbums(filter:{favoritesOnly:true}) keeps only albums with >=1 favorited track (via setFavorite)", () => {
    upsertTracks(db, records());
    // Un favori dans Album X seulement.
    const fav = getTrackByPath(db, "/m/a/01.flac")!;
    setFavorite(db, fav.id, true);

    const albums = getAlbums(db, { limit: 50, offset: 0 }, { filter: { favoritesOnly: true } });
    expect(albums.map((a) => a.title)).toEqual(["Album X"]);
    const tracks = getAllTracks(db, { limit: 50, offset: 0 }, { filter: { favoritesOnly: true } });
    expect(tracks.map((t) => t.path)).toEqual(["/m/a/01.flac"]);

    // En retirant le favori, plus aucun album favori.
    setFavorite(db, fav.id, false);
    expect(getAlbums(db, { limit: 50, offset: 0 }, { filter: { favoritesOnly: true } })).toEqual([]);
  });

  // ── Playlists (Task 10) ──────────────────────────────────────────────────
  const seedTrackIds = (): [number, number, number] => {
    upsertTracks(db, records());
    return [
      getTrackByPath(db, "/m/a/01.flac")!.id,
      getTrackByPath(db, "/m/a/02.flac")!.id,
      getTrackByPath(db, "/m/b/01.mp3")!.id,
    ];
  };
  // Lit directement les colonnes (track_id, position) pour asserter les valeurs de position.
  const positions = (id: number): { trackId: number; position: number }[] =>
    db
      .prepare("SELECT track_id AS trackId, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position")
      .all(id) as { trackId: number; position: number }[];

  it("createPlaylist + addToPlaylist appends tracks in order (getPlaylistTracks by position)", () => {
    const [t1, t2, t3] = seedTrackIds();
    const id = createPlaylist(db, "Road Trip");
    expect(typeof id).toBe("number");
    addToPlaylist(db, id, [t1, t2, t3]);
    expect(getPlaylistTracks(db, id).map((t) => t.id)).toEqual([t1, t2, t3]);
    expect(positions(id)).toEqual([
      { trackId: t1, position: 0 },
      { trackId: t2, position: 1 },
      { trackId: t3, position: 2 },
    ]);
  });

  it("addToPlaylist appends after the current max position (dense, contiguous)", () => {
    const [t1, t2, t3] = seedTrackIds();
    const id = createPlaylist(db, "P");
    addToPlaylist(db, id, [t1]);
    addToPlaylist(db, id, [t2, t3]);
    expect(positions(id).map((p) => p.position)).toEqual([0, 1, 2]);
    expect(getPlaylistTracks(db, id).map((t) => t.id)).toEqual([t1, t2, t3]);
  });

  it("removeFromPlaylist removes the row at a position then recompacts positions to 0..n-1", () => {
    const [t1, t2, t3] = seedTrackIds();
    const id = createPlaylist(db, "P");
    addToPlaylist(db, id, [t1, t2, t3]);
    removeFromPlaylist(db, id, 1); // position de t2
    expect(getPlaylistTracks(db, id).map((t) => t.id)).toEqual([t1, t3]);
    // Positions recompactées : valeurs de colonne réelles 0,1 (pas juste l'ordre).
    expect(positions(id)).toEqual([
      { trackId: t1, position: 0 },
      { trackId: t3, position: 1 },
    ]);
  });

  it("reorderPlaylist moves item from->to and re-densifies positions (no PK collision)", () => {
    const [t1, t2, t3] = seedTrackIds();
    const id = createPlaylist(db, "P");
    addToPlaylist(db, id, [t1, t2, t3]);
    reorderPlaylist(db, id, 0, 2); // t1 -> fin
    expect(getPlaylistTracks(db, id).map((t) => t.id)).toEqual([t2, t3, t1]);
    expect(positions(id).map((p) => p.position)).toEqual([0, 1, 2]);
    reorderPlaylist(db, id, 2, 0); // retour : index 2 -> index 0
    expect(getPlaylistTracks(db, id).map((t) => t.id)).toEqual([t1, t2, t3]);
    expect(positions(id).map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("deletePlaylist cascades playlist_tracks (no orphan rows)", () => {
    const [t1, t2] = seedTrackIds();
    const id = createPlaylist(db, "P");
    addToPlaylist(db, id, [t1, t2]);
    const count = (): number =>
      db.prepare("SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?").pluck().get(id) as number;
    expect(count()).toBe(2);
    deletePlaylist(db, id);
    expect(getPlaylists(db).find((p) => p.id === id)).toBeUndefined();
    expect(count()).toBe(0);
  });

  it("getPlaylists returns trackCount; renamePlaylist updates name + updated_at (not created_at)", () => {
    const [t1, t2] = seedTrackIds();
    const id = createPlaylist(db, "Old");
    addToPlaylist(db, id, [t1, t2]);
    // Fige des horodatages connus pour prouver que SEUL updated_at bouge au renommage.
    db.prepare("UPDATE playlists SET created_at = 1000, updated_at = 1000 WHERE id = ?").run(id);
    renamePlaylist(db, id, "New");
    const row = getPlaylists(db).find((p) => p.id === id)!;
    expect(row.name).toBe("New");
    expect(row.trackCount).toBe(2);
    expect(row.createdAt).toBe(1000);
    expect(row.updatedAt).toBeGreaterThan(1000);
  });

  it("getPlaylists reports trackCount 0 for an empty playlist (LEFT JOIN)", () => {
    const id = createPlaylist(db, "Empty");
    const row = getPlaylists(db).find((p) => p.id === id)!;
    expect(row.trackCount).toBe(0);
    expect(getPlaylistTracks(db, id)).toEqual([]);
  });

  // ── app_state (Task 14A) ─────────────────────────────────────────────────
  it("setState writes a value, getState reads it back, and getState(missing) is undefined", () => {
    expect(getState(db, "player")).toBeUndefined();
    setState(db, "player", '{"a":1}');
    expect(getState(db, "player")).toBe('{"a":1}');
    expect(getState(db, "absent")).toBeUndefined();
  });

  it("setState upsert is idempotent on key (second write overwrites, no duplicate rows)", () => {
    setState(db, "k", "first");
    setState(db, "k", "second");
    expect(getState(db, "k")).toBe("second");
    const count = db.prepare("SELECT COUNT(*) FROM app_state WHERE key = ?").pluck().get("k");
    expect(count).toBe(1);
  });

  it("app_state survives a close/reopen (persisted)", () => {
    setState(db, "player", "payload");
    const path = db.name;
    db.close();
    db = openDb(path);
    expect(getState(db, "player")).toBe("payload");
  });

  // ── getTracksByIds (Task 14A, resume restore) ────────────────────────────
  it("getTracksByIds preserves the requested order and drops ids no longer present", () => {
    const [t1, t2, t3] = seedTrackIds();
    // Ordre demande volontairement different de l'ordre d'insertion, avec un id absent (999).
    const rows = getTracksByIds(db, [t3, 999, t1, t2]);
    expect(rows.map((r) => r.id)).toEqual([t3, t1, t2]);
    // Les lignes sont des TrackRow complets (playable booleen, chemin present).
    expect(rows.every((r) => typeof r.playable === "boolean" && typeof r.path === "string")).toBe(true);
  });

  it("getTracksByIds keeps duplicate ids (a queue may repeat a track) and returns [] for []", () => {
    const [t1, t2] = seedTrackIds();
    expect(getTracksByIds(db, [])).toEqual([]);
    expect(getTracksByIds(db, [t1, t2, t1]).map((r) => r.id)).toEqual([t1, t2, t1]);
    // Tous les ids disparus -> liste vide (reprise propre).
    expect(getTracksByIds(db, [999, 1000])).toEqual([]);
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
