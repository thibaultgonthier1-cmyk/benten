import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/main/library/db";

/** Schéma v1 exact (copié de `MIGRATIONS[0]`), pour fabriquer une base "ancienne". */
const V1_SQL = `
  CREATE TABLE artists (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE albums (
    id        INTEGER PRIMARY KEY,
    title     TEXT NOT NULL,
    artist_id INTEGER NOT NULL REFERENCES artists(id),
    art_key   TEXT,
    UNIQUE (title, artist_id)
  );

  CREATE TABLE tracks (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL,
    album        TEXT NOT NULL,
    artist_id    INTEGER NOT NULL REFERENCES artists(id),
    album_id     INTEGER NOT NULL REFERENCES albums(id),
    track_no     INTEGER,
    duration_sec REAL NOT NULL,
    format       TEXT NOT NULL,
    sample_rate  INTEGER,
    bit_depth    INTEGER,
    playable     INTEGER NOT NULL DEFAULT 1,
    art_key      TEXT
  );

  CREATE INDEX idx_tracks_album_id ON tracks(album_id);
  CREATE INDEX idx_tracks_artist   ON tracks(artist);
  CREATE INDEX idx_tracks_title    ON tracks(title);
`;

/** Fabrique une base v1 remplie (2 artistes / 1 album / 3 pistes) et pose `user_version = 1`. */
function seedV1(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(V1_SQL);

  const insArtist = db.prepare("INSERT INTO artists (id, name) VALUES (?, ?)");
  insArtist.run(1, "Artist A");
  insArtist.run(2, "Artist B");

  db.prepare("INSERT INTO albums (id, title, artist_id, art_key) VALUES (?, ?, ?, ?)").run(
    1,
    "Album X",
    1,
    null,
  );

  const insTrack = db.prepare(`
    INSERT INTO tracks
      (id, path, title, artist, album, artist_id, album_id, track_no,
       duration_sec, format, sample_rate, bit_depth, playable, art_key)
    VALUES
      (@id, @path, @title, @artist, @album, @artistId, @albumId, @trackNo,
       @durationSec, @format, @sampleRate, @bitDepth, @playable, @artKey)`);
  for (let i = 1; i <= 3; i++) {
    insTrack.run({
      id: i,
      path: `/m/a/0${i}.flac`,
      title: `Track ${i}`,
      artist: "Artist A",
      album: "Album X",
      artistId: 1,
      albumId: 1,
      trackNo: i,
      durationSec: 180,
      format: "FLAC",
      sampleRate: 44100,
      bitDepth: 16,
      playable: 1,
      artKey: null,
    });
  }

  db.pragma("user_version = 1");
  db.close();
}

const count = (db: Database.Database, sql: string): number =>
  (db.prepare(sql).get() as { c: number }).c;

const colNames = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

describe("migration v2", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "benten-mig-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("(a) upgrades a v1 database to v2 without losing data", () => {
    const path = join(dir, "v1.db");
    seedV1(path);

    const db = openDb(path);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(2);

      // Les données v1 survivent.
      expect(count(db, "SELECT COUNT(*) AS c FROM tracks")).toBe(3);
      expect(count(db, "SELECT COUNT(*) AS c FROM albums")).toBe(1);
      expect(count(db, "SELECT COUNT(*) AS c FROM artists")).toBe(2);

      // Nouvelles colonnes présentes.
      const tcols = colNames(db, "tracks");
      expect(tcols).toContain("album_artist");
      expect(tcols).toContain("disc_no");
      expect(tcols).toContain("mtime_ms");
      expect(tcols).toContain("size_bytes");
      expect(colNames(db, "albums")).toContain("created_at");

      // Colonnes additives nullables : NULL sur les lignes existantes.
      const row = db.prepare("SELECT album_artist, disc_no FROM tracks WHERE id = 1").get() as {
        album_artist: string | null;
        disc_no: number | null;
      };
      expect(row.album_artist).toBeNull();
      expect(row.disc_no).toBeNull();

      // albums.created_at a bien son DEFAULT 0 sur l'ancienne ligne.
      expect(count(db, "SELECT created_at AS c FROM albums WHERE id = 1")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("(b) a fresh database opens directly at v2", () => {
    const db = openDb(join(dir, "fresh.db"));
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });

  it("(c) recreates the sort indexes with COLLATE NOCASE", () => {
    const db = openDb(join(dir, "idx.db"));
    try {
      const sqlArtist = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_tracks_artist'").get() as {
          sql: string;
        }
      ).sql;
      const sqlTitle = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_tracks_title'").get() as {
          sql: string;
        }
      ).sql;
      expect(sqlArtist).toMatch(/NOCASE/i);
      expect(sqlTitle).toMatch(/NOCASE/i);
    } finally {
      db.close();
    }
  });

  it("(d) creates the five phase-2 tables", () => {
    const db = openDb(join(dir, "tables.db"));
    try {
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      for (const t of ["sources", "playlists", "playlist_tracks", "favorites", "app_state"]) {
        expect(names).toContain(t);
      }
    } finally {
      db.close();
    }
  });

  it("(e) ON DELETE CASCADE removes a favorite when its track is deleted", () => {
    const path = join(dir, "cascade.db");
    seedV1(path);

    const db = openDb(path);
    try {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

      db.prepare("INSERT INTO favorites (track_id, added_at) VALUES (?, ?)").run(1, Date.now());
      expect(count(db, "SELECT COUNT(*) AS c FROM favorites")).toBe(1);

      db.prepare("DELETE FROM tracks WHERE id = 1").run();
      expect(count(db, "SELECT COUNT(*) AS c FROM favorites")).toBe(0);
    } finally {
      db.close();
    }
  });
});
