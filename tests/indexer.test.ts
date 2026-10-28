import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/main/library/db";
import { indexLibrary } from "../src/main/library/indexer";
import { getAllTracks } from "../src/main/library/repository";
import type { ScanSummary, TrackInput } from "../src/shared/types";

const FIX = join(__dirname, "fixtures");

describe("indexLibrary", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "benten-idx-"));
    db = openDb(join(dir, "lib.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const count = () => (db.prepare("SELECT COUNT(*) FROM tracks").pluck().get() as number);

  it("indexe les fichiers lisibles et compte .m4p + fichier corrompu en skipped", async () => {
    const res = await indexLibrary(db, [FIX]);
    // 6 (library) + 1 (untagged) lisibles ; 1 .m4p + 1 flac tronque ignores.
    expect(res).toEqual({ added: 7, skipped: 2 });
    expect(count()).toBe(7);
    // Aucune piste illisible n'est inseree.
    expect(getAllTracks(db, { limit: 100, offset: 0 }).every((t) => t.playable)).toBe(true);
  });

  it("est idempotent : une 2e passe n'ajoute rien", async () => {
    await indexLibrary(db, [FIX]);
    const again = await indexLibrary(db, [FIX]);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
    expect(count()).toBe(7);
  });

  it("emet la progression au moins une fois, avec un dernier etat coherent", async () => {
    const events: ScanSummary[] = [];
    const res = await indexLibrary(db, [FIX], (p) => events.push({ ...p }));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last.scanned).toBe(9);
    expect(last.added).toBe(res.added);
    expect(last.skipped).toBe(res.skipped);
    // Monotone.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.scanned).toBeGreaterThanOrEqual(events[i - 1]!.scanned);
    }
  });

  // Review Focus : un dossier avec un fichier corrompu ne doit pas interrompre l'indexation.
  it("un dossier avec un fichier corrompu : pas d'exception, fichier compte skipped", async () => {
    const res = await indexLibrary(db, [join(FIX, "corrupt")]);
    expect(res).toEqual({ added: 0, skipped: 1 });
    expect(count()).toBe(0);
    // Et les autres racines sont toujours indexees quand une racine est corrompue.
    const mixed = await indexLibrary(db, [join(FIX, "corrupt"), join(FIX, "library")]);
    expect(mixed).toEqual({ added: 6, skipped: 1 });
  });

  it("une racine inexistante ou en double n'echoue pas et ne double pas les comptes", async () => {
    const lib = join(FIX, "library");
    const res = await indexLibrary(db, [join(FIX, "nope"), lib, lib]);
    expect(res).toEqual({ added: 6, skipped: 0 });
  });

  it("un lecteur qui leve est compte skipped + errors, sans interrompre", async () => {
    let calls = 0;
    const flaky = async (path: string): Promise<TrackInput> => {
      calls++;
      if (calls === 2) throw new Error("boom");
      return {
        path, title: "t", artist: "a", album: "b", trackNo: null, durationSec: 1,
        format: "FLAC", sampleRate: 44100, bitDepth: 16, playable: true, artKey: null,
      };
    };
    let last: ScanSummary | undefined;
    const res = await indexLibrary(db, [join(FIX, "library")], (p) => (last = { ...p }), {
      readMetadata: flaky,
    });
    expect(res).toEqual({ added: 5, skipped: 1 });
    expect(last?.errors).toBe(1);
  });

  it("borne la concurrence de lecture des metadonnees", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (path: string): Promise<TrackInput> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return {
        path, title: path, artist: "a", album: "b", trackNo: null, durationSec: 1,
        format: "FLAC", sampleRate: 44100, bitDepth: 16, playable: true, artKey: null,
      };
    };
    // 6 fichiers, concurrence 3 : le pic doit etre exactement 3 (ni 1, ni 6).
    const res = await indexLibrary(db, [join(FIX, "library")], undefined, {
      readMetadata: slow,
      concurrency: 3,
    });
    expect(res.added).toBe(6);
    expect(peak).toBe(3);
  });

  // Fix round 1 : une erreur d'ecriture DB ne doit ni etre avalee ni gonfler `added`.
  it("une erreur d'ecriture DB fait rejeter indexLibrary et n'est pas comptee dans added", async () => {
    db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON tracks BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const events: ScanSummary[] = [];
    await expect(
      indexLibrary(db, [join(FIX, "library")], (p) => events.push({ ...p })),
    ).rejects.toThrow(/disk full/);
    expect(count()).toBe(0);
    // Aucun etat de progression ne rapporte de titres ajoutes qui n'ont pas ete ecrits.
    expect(events.every((e) => e.added === 0)).toBe(true);
  });

  it("une erreur d'ecriture DB en milieu de passe : added reflete uniquement les lots ecrits", async () => {
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON tracks WHEN NEW.title = 'Pardon'
             BEGIN SELECT RAISE(ABORT, 'busy'); END`);
    let last: ScanSummary | undefined;
    await expect(
      indexLibrary(db, [join(FIX, "library")], (p) => (last = { ...p }), { batchSize: 2, concurrency: 1 }),
    ).rejects.toThrow(/busy/);
    // Les lots precedents (2 pistes chacun) sont persistes ; added == lignes reellement en base.
    expect(last?.added ?? 0).toBe(count());
    expect(last?.errors ?? 0).toBe(0);
  });
});
