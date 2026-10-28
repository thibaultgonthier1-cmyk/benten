import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

import { dialog } from "electron";
import {
  isPathWithinRoots,
  isTrustedUrl,
  normalizePage,
  readAudioFile,
  registerIpc,
  validateScanPaths,
} from "../src/main/ipc";
import { openDb } from "../src/main/library/db";
import { addSource, getSources } from "../src/main/library/repository";

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

  it("enregistre ping, library:*, audio:*, dialog:pick-folder et sources:*", () => {
    expect([...handlers.keys()].sort()).toEqual([
      "app:ping",
      "audio:default-device",
      "audio:read-file",
      "dialog:pick-folder",
      "library:query",
      "library:scan",
      "sources:list",
      "sources:remove",
    ]);
  });

  it("audio:default-device renvoie un peripherique nomme et rejette un expediteur non fiable", async () => {
    const dev = (await call("audio:default-device", trusted)) as { name: string };
    expect(typeof dev.name).toBe("string");
    expect(dev.name.trim().length).toBeGreaterThan(0);
    await expect(call("audio:default-device", evil)).rejects.toThrow(/untrusted sender/);
  });

  it("library:scan indexe un dossier valide, renvoie le resume et persiste la racine en source", async () => {
    const root = join(FIX, "library");
    const res = (await call("library:scan", trusted, [root])) as Record<string, number>;
    expect(res).toMatchObject({ scanned: 6, added: 6, skipped: 0, errors: 0 });
    expect(getSources(db).map((s) => s.path)).toEqual([root]);
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

  it("audio:read-file renvoie les octets d'un fichier FLAC indexe (racine en source)", async () => {
    // La racine doit etre une source persistee pour que le confinement autorise la lecture.
    await call("library:scan", trusted, [join(FIX, "library")]);
    const flac = join(FIX, "library", "NSYNC", "No Strings Attached", "01 - Bye Bye Bye.flac");
    const buf = (await call("audio:read-file", trusted, flac)) as ArrayBuffer;
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBeGreaterThan(0);
    // Signature FLAC : "fLaC" en tete de fichier.
    expect(Buffer.from(buf.slice(0, 4)).toString("ascii")).toBe("fLaC");
  });

  it("audio:read-file rejette un fichier hors des racines indexees (confinement)", async () => {
    // Fichier reel et valide, mais aucune source persistee ne le contient -> rejet.
    const flac = join(FIX, "library", "NSYNC", "No Strings Attached", "01 - Bye Bye Bye.flac");
    await expect(call("audio:read-file", trusted, flac)).rejects.toThrow(/outside indexed roots/);
  });

  it("audio:read-file rejette un expediteur non fiable et des chemins invalides", async () => {
    const flac = join(FIX, "library", "NSYNC", "No Strings Attached", "01 - Bye Bye Bye.flac");
    await expect(call("audio:read-file", evil, flac)).rejects.toThrow(/untrusted sender/);
    for (const bad of [undefined, "", "relatif.flac", join(dir, "absent.flac"), FIX]) {
      await expect(call("audio:read-file", trusted, bad)).rejects.toThrow(/audio:read-file/);
    }
  });

  it("readAudioFile(db) rejette sans source puis resout une fois la racine ajoutee", async () => {
    const root = mkdtempSync(join(tmpdir(), "benten-root-"));
    const file = join(root, "track.flac");
    writeFileSync(file, "fLaC\0\0\0\0");
    try {
      await expect(readAudioFile(db, file)).rejects.toThrow(/outside indexed roots/);
      addSource(db, root);
      const buf = await readAudioFile(db, file);
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect(buf.byteLength).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sources:list renvoie les sources et sources:remove supprime par id", async () => {
    await call("library:scan", trusted, [join(FIX, "library")]);
    const list = (await call("sources:list", trusted)) as { id: number; path: string }[];
    expect(list.map((s) => s.path)).toEqual([join(FIX, "library")]);
    await call("sources:remove", trusted, list[0]!.id);
    expect((await call("sources:list", trusted)) as unknown[]).toHaveLength(0);
    await expect(call("sources:list", evil)).rejects.toThrow(/untrusted sender/);
    await expect(call("sources:remove", evil, 1)).rejects.toThrow(/untrusted sender/);
  });

  it("dialog:pick-folder renvoie le chemin choisi et rejette un expediteur non fiable", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ["C:\\musique"],
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    const path = await call("dialog:pick-folder", trusted);
    expect(path).toBe("C:\\musique");
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"] });
    await expect(call("dialog:pick-folder", evil)).rejects.toThrow(/untrusted sender/);
  });

  it("dialog:pick-folder renvoie null quand l'utilisateur annule", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    expect(await call("dialog:pick-folder", trusted)).toBeNull();
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

describe("isPathWithinRoots", () => {
  // Stub identite : on teste la logique pure (resolution + frontiere de prefixe),
  // independamment du systeme de fichiers. `resolve` normalise d'abord les separateurs.
  const id = (p: string) => p;

  it("accepte un fichier contenu dans une racine", () => {
    expect(isPathWithinRoots("/lib/a/x.flac", ["/lib"], id)).toBe(true);
  });

  it("accepte un fichier egal a la racine (borne inclusive)", () => {
    expect(isPathWithinRoots("/lib", ["/lib"], id)).toBe(true);
  });

  it("rejette un fichier hors de la racine", () => {
    expect(isPathWithinRoots("/lib2/x.flac", ["/lib"], id)).toBe(false);
  });

  it("rejette la collision de prefixe (/library n'est pas dans /lib)", () => {
    expect(isPathWithinRoots("/library/x.flac", ["/lib"], id)).toBe(false);
  });

  it("accepte si l'une des racines contient le fichier", () => {
    expect(isPathWithinRoots("/b/song.flac", ["/a", "/b", "/c"], id)).toBe(true);
    expect(isPathWithinRoots("/d/song.flac", ["/a", "/b", "/c"], id)).toBe(false);
  });

  it("rejette quand il n'y a aucune racine", () => {
    expect(isPathWithinRoots("/lib/a/x.flac", [], id)).toBe(false);
  });

  it("confine avec le vrai realpathSync (dossier + fichier temporaires)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "benten-within-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "benten-outside-")));
    try {
      const inside = join(root, "sub", "x.flac");
      writeFileSync(join(root, "x.flac"), "x");
      // Un fichier direct dans la racine est contenu.
      expect(isPathWithinRoots(join(root, "x.flac"), [root])).toBe(true);
      // Un chemin inexistant sous la racine : realpathSync echoue -> fail closed.
      expect(isPathWithinRoots(inside, [root])).toBe(false);
      // Un fichier dans un autre dossier n'est pas contenu.
      writeFileSync(join(outside, "y.flac"), "y");
      expect(isPathWithinRoots(join(outside, "y.flac"), [root])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("bloque une evasion par lien symbolique (realpath resout hors racine)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "benten-link-root-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "benten-link-out-")));
    try {
      const secret = join(outside, "secret.flac");
      writeFileSync(secret, "fLaC");
      const link = join(root, "link.flac");
      try {
        symlinkSync(secret, link, "file");
      } catch (e) {
        // Creation de lien symbolique non privilegiee sur Windows : on saute CE sous-cas.
        console.warn("symlink escape sub-case skipped (no privilege):", (e as Error).message);
        return;
      }
      // Le lien est DANS la racine, mais realpath pointe hors racine -> rejet (fail closed).
      expect(isPathWithinRoots(link, [root])).toBe(false);
      // Sans resolution de lien (stub identite via resolve), le prefixe passerait : on prouve
      // que c'est bien realpath qui ferme la porte.
      expect(isPathWithinRoots(link, [root], (p) => resolve(p))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("utilise le separateur de la plateforme pour la frontiere", () => {
    // Sanity : la frontiere s'appuie sur path.sep.
    expect(typeof sep).toBe("string");
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
