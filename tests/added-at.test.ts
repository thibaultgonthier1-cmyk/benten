import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/main/library/db";
import { addedAtFromStat, backfillAddedAt } from "../src/main/library/addedAt";
import { getAllTracks, upsertTracks } from "../src/main/library/repository";
import type { TrackInput } from "../src/shared/types";

const input = (path: string, over: Partial<TrackInput> = {}): TrackInput => ({
  path,
  title: path,
  artist: "A",
  album: "B",
  albumArtist: null,
  trackNo: null,
  discNo: null,
  durationSec: 1,
  format: "FLAC",
  sampleRate: 44100,
  bitDepth: 16,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  ...over,
});

describe("addedAtFromStat", () => {
  it("birthtime d'abord ; mtime si birthtime vaut 0, est absent ou invalide ; arrondi entier", () => {
    expect(addedAtFromStat({ birthtimeMs: 1234.6, mtimeMs: 99 })).toBe(1235);
    expect(addedAtFromStat({ birthtimeMs: 0, mtimeMs: 99.2 })).toBe(99);
    expect(addedAtFromStat({ mtimeMs: 42 })).toBe(42);
    expect(addedAtFromStat({ birthtimeMs: Number.NaN, mtimeMs: 7 })).toBe(7);
    expect(addedAtFromStat({ birthtimeMs: 0, mtimeMs: 0 })).toBeNull();
  });
});

describe("backfillAddedAt", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "benten-added-"));
    db = openDb(join(dir, "lib.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const addedAt = (): Record<string, number | null> =>
    Object.fromEntries(getAllTracks(db, { limit: 100, offset: 0 }).map((t) => [t.path, t.addedAtMs]));

  it("remplit les lignes NULL depuis le stat injecté ; fichier absent → reste NULL ; existantes intactes", async () => {
    upsertTracks(db, [input("/m/a.flac"), input("/m/b.flac"), input("/m/gone.flac")]);
    upsertTracks(db, [input("/m/kept.flac", { addedAtMs: 111 })]);
    const seen: string[] = [];
    const stat = async (p: string) => {
      seen.push(p);
      if (p.includes("gone")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return p.includes("/a.") ? { birthtimeMs: 2000, mtimeMs: 5 } : { birthtimeMs: 0, mtimeMs: 3000 };
    };

    const n = await backfillAddedAt(db, stat);
    expect(n).toBe(2);
    expect(addedAt()).toEqual({ "/m/a.flac": 2000, "/m/b.flac": 3000, "/m/gone.flac": null, "/m/kept.flac": 111 });
    // Seules les lignes NULL sont interrogées.
    expect(seen.sort()).toEqual(["/m/a.flac", "/m/b.flac", "/m/gone.flac"]);

    // Une seconde passe ne retouche que ce qui reste NULL (le fichier absent).
    seen.length = 0;
    expect(await backfillAddedAt(db, stat)).toBe(0);
    expect(seen).toEqual(["/m/gone.flac"]);
  });

  it("aucune ligne à compléter : aucun stat, renvoie 0", async () => {
    upsertTracks(db, [input("/m/x.flac", { addedAtMs: 5 })]);
    let calls = 0;
    expect(
      await backfillAddedAt(db, async () => {
        calls++;
        return { mtimeMs: 1 };
      }),
    ).toBe(0);
    expect(calls).toBe(0);
  });

  it("écrit tout dans UNE transaction (un échec d'écriture n'en laisse aucune à moitié)", async () => {
    upsertTracks(db, [input("/m/1.flac"), input("/m/2.flac"), input("/m/3.flac")]);
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF added_at_ms ON tracks WHEN NEW.path = '/m/3.flac'
             BEGIN SELECT RAISE(ABORT, 'busy'); END`);
    await expect(backfillAddedAt(db, async () => ({ birthtimeMs: 10, mtimeMs: 1 }))).rejects.toThrow(/busy/);
    expect(Object.values(addedAt()).every((v) => v === null)).toBe(true);
  });
});
