import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) },
}));

import { isTrustedUrl, normalizePage, registerIpc, validateScanPaths } from "../src/main/ipc";
import { openDb } from "../src/main/library/db";

const FIX = join(__dirname, "fixtures");
// ipc.ts resout l'UI empaquetee relativement a son propre dossier (src/main sous vitest).
const INDEX_URL = pathToFileURL(join(__dirname, "..", "src", "renderer", "index.html")).href;
const trusted = { senderFrame: { url: INDEX_URL } };
const evil = { senderFrame: { url: "https://evil.example/x.html" } };

describe("registerIpc", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    handlers.clear();
    delete process.env["ELECTRON_RENDERER_URL"];
    dir = mkdtempSync(join(tmpdir(), "benten-ipc-"));
    db = openDb(join(dir, "lib.db"));
    registerIpc(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (ch: string, event: unknown, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(ch)!(event, ...args));

  it("enregistre ping, library:query et library:scan", () => {
    expect([...handlers.keys()].sort()).toEqual(["app:ping", "library:query", "library:scan"]);
  });

  it("library:scan indexe un dossier valide et renvoie le resume", async () => {
    const res = (await call("library:scan", trusted, [join(FIX, "library")])) as Record<string, number>;
    expect(res).toMatchObject({ scanned: 6, added: 6, skipped: 0, errors: 0 });
  });

  it("library:query sans limit/offset ne passe pas NaN/undefined a SQLite", async () => {
    await call("library:scan", trusted, [join(FIX, "library")]);
    const albums = (await call("library:query", trusted, { view: "albums" })) as { rows: unknown[] };
    expect(albums.rows).toHaveLength(6);
    const tracks = (await call("library:query", trusted, { view: "tracks" })) as { rows: unknown[] };
    expect(tracks.rows).toHaveLength(6);
    const artists = (await call("library:query", trusted, { view: "artists" })) as { rows: unknown[] };
    expect(artists.rows).toHaveLength(6);
    const paged = (await call("library:query", trusted, { view: "tracks", limit: 2, offset: 1 })) as {
      rows: unknown[];
    };
    expect(paged.rows).toHaveLength(2);
    const nan = (await call("library:query", trusted, { view: "tracks", limit: NaN, offset: NaN })) as {
      rows: unknown[];
    };
    expect(nan.rows).toHaveLength(6);
  });

  it("rejette une vue inconnue ou des arguments invalides", async () => {
    await expect(call("library:query", trusted, { view: "nope" })).rejects.toThrow(/invalid view/);
    await expect(call("library:query", trusted, undefined)).rejects.toThrow(/invalid args/);
  });

  it("rejette un expediteur non fiable sur library:*", async () => {
    await expect(call("library:scan", evil, [FIX])).rejects.toThrow(/untrusted sender/);
    await expect(call("library:query", evil, { view: "albums" })).rejects.toThrow(/untrusted sender/);
    await expect(call("library:scan", {}, [FIX])).rejects.toThrow(/untrusted sender/);
  });

  it("library:scan rejette des chemins invalides", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    for (const bad of [undefined, "C:\\", [], [42], [""], ["relatif/dossier"], [join(dir, "absent")], [file]]) {
      await expect(call("library:scan", trusted, bad)).rejects.toThrow(/library:scan/);
    }
  });
});

describe("isTrustedUrl", () => {
  it("accepte l'index empaquete (hash/query ignores) et l'origine du serveur de dev", () => {
    expect(isTrustedUrl(INDEX_URL + "#/x?y=1", undefined, INDEX_URL)).toBe(true);
    expect(isTrustedUrl("http://localhost:5173/", "http://localhost:5173", INDEX_URL)).toBe(true);
    expect(isTrustedUrl("http://localhost:5173/a/b", "http://localhost:5173", INDEX_URL)).toBe(true);
  });
  it("refuse tout le reste", () => {
    expect(isTrustedUrl(undefined, undefined, INDEX_URL)).toBe(false);
    expect(isTrustedUrl("not a url", undefined, INDEX_URL)).toBe(false);
    expect(isTrustedUrl("https://evil.example/", "http://localhost:5173", INDEX_URL)).toBe(false);
    expect(isTrustedUrl("http://localhost:5174/", "http://localhost:5173", INDEX_URL)).toBe(false);
    expect(isTrustedUrl("http://localhost:5173/", undefined, INDEX_URL)).toBe(false);
    expect(isTrustedUrl("file:///C:/evil/index.html", undefined, INDEX_URL)).toBe(false);
  });
});

describe("normalizePage / validateScanPaths", () => {
  it("applique des valeurs par defaut et des bornes", () => {
    expect(normalizePage({})).toEqual({ limit: 200, offset: 0 });
    expect(normalizePage({ limit: 0, offset: -5 })).toEqual({ limit: 1, offset: 0 });
    expect(normalizePage({ limit: 1e9, offset: 3.7 })).toEqual({ limit: 1000, offset: 3 });
    expect(normalizePage({ limit: Infinity })).toEqual({ limit: 200, offset: 0 });
  });
  it("accepte des dossiers absolus existants", () => {
    expect(validateScanPaths([FIX])).toEqual([FIX]);
  });
});
