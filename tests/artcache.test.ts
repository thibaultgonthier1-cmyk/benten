import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getOrCreateArt, resolveArtFile, serveArt, type Resizer } from "../src/main/library/artcache";
import { openDb } from "../src/main/library/db";
import { indexLibrary } from "../src/main/library/indexer";
import { getAllTracks } from "../src/main/library/repository";
import { flacWithPicture, makePng } from "./helpers/art";

const SRC_FLAC = join(__dirname, "fixtures/library/Ridsa/Tranquille/13 - Pardon.flac");
const UNTAGGED = join(__dirname, "fixtures/untagged/Artiste X/Album Y/03 - Titre.flac");

describe("artcache", () => {
  let root: string;
  let cacheDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "benten-art-"));
    cacheDir = join(root, "cache");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** FLAC avec pochette embarquee dans `<root>/lib/<name>/`. */
  const embedded = (name: string, png = makePng(1)): string => {
    const dir = join(root, "lib", name);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "01 - a.flac");
    writeFileSync(p, flacWithPicture(SRC_FLAC, png));
    return p;
  };
  const plain = (name: string): string => {
    const dir = join(root, "lib", name);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "01 - a.flac");
    copyFileSync(UNTAGGED, p);
    return p;
  };
  const cached = () => (existsSync(cacheDir) ? readdirSync(cacheDir) : []);

  it("pochette embarquee : ecrit un fichier en cache et renvoie une cle stable", async () => {
    const path = embedded("A");
    const key = await getOrCreateArt({ path }, { cacheDir });
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(cached()).toHaveLength(1);
    const file = resolveArtFile(key!, cacheDir);
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);
    // Stable : meme contenu depuis un autre fichier/dossier => meme cle (dedoublonnage par album).
    const key2 = await getOrCreateArt({ path: embedded("B") }, { cacheDir });
    expect(key2).toBe(key);
    expect(cached()).toHaveLength(1);
    // Contenu different => cle differente.
    const key3 = await getOrCreateArt({ path: embedded("C", makePng(99)) }, { cacheDir });
    expect(key3).not.toBe(key);
    expect(cached()).toHaveLength(2);
  });

  it("2e appel : reutilise le cache (ni redimensionnement ni reecriture)", async () => {
    const path = embedded("A");
    const thumb = makePng(77, 2, 2);
    const resize = vi.fn<Resizer>(() => thumb);
    const key = await getOrCreateArt({ path }, { cacheDir, resize });
    expect(resize).toHaveBeenCalledTimes(1);
    const file = resolveArtFile(key!, cacheDir)!;
    const before = statSync(file);
    await new Promise((r) => setTimeout(r, 25));
    const again = await getOrCreateArt({ path }, { cacheDir, resize });
    expect(again).toBe(key);
    expect(resize).toHaveBeenCalledTimes(1); // pas de retravail
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs); // pas de reecriture
    // Le fichier cache contient la vignette produite par le resizer.
    expect(readFileSync(file).equals(thumb)).toBe(true);
  });

  it("appels concurrents sur la meme pochette : un seul fichier, aucun temporaire restant", async () => {
    const paths = ["A", "B", "C", "D"].map((n) => embedded(n));
    const keys = await Promise.all(paths.map((path) => getOrCreateArt({ path }, { cacheDir })));
    expect(new Set(keys).size).toBe(1);
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  it("un resizer qui echoue ou renvoie null : repli sur l'image d'origine", async () => {
    const png = makePng(5);
    const key = await getOrCreateArt(
      { path: embedded("A", png) },
      {
        cacheDir,
        resize: () => {
          throw new Error("boom");
        },
      },
    );
    expect(readFileSync(resolveArtFile(key!, cacheDir)!).equals(png)).toBe(true);
    const png2 = makePng(6);
    const key2 = await getOrCreateArt({ path: embedded("B", png2) }, { cacheDir, resize: () => null });
    expect(readFileSync(resolveArtFile(key2!, cacheDir)!).equals(png2)).toBe(true);
  });

  it("la taille cible fait partie de la cle (changer le reglage regenere la vignette)", async () => {
    const path = embedded("A");
    const k1 = await getOrCreateArt({ path }, { cacheDir, size: 256 });
    const k2 = await getOrCreateArt({ path }, { cacheDir, size: 512 });
    expect(k1).not.toBe(k2);
  });

  it("pas de pochette embarquee ni de fichier de dossier : null, rien d'ecrit", async () => {
    expect(await getOrCreateArt({ path: plain("A") }, { cacheDir })).toBeNull();
    expect(cached()).toHaveLength(0);
  });

  it("fichier illisible / inexistant : null (ne leve pas)", async () => {
    expect(await getOrCreateArt({ path: join(root, "nope.flac") }, { cacheDir })).toBeNull();
    const bad = join(root, "bad.flac");
    writeFileSync(bad, "not audio");
    expect(await getOrCreateArt({ path: bad }, { cacheDir })).toBeNull();
  });

  it("repli sur cover.* / folder.* du dossier (insensible a la casse), l'embarquee prime", async () => {
    const path = plain("A");
    writeFileSync(join(dirname(path), "Folder.JPG"), makePng(7));
    const key = await getOrCreateArt({ path }, { cacheDir });
    expect(key).toMatch(/^[0-9a-f]{40}$/);

    // Un autre nom (front.png) est ignore ; cover.* prime sur folder.*.
    const p2 = plain("B");
    writeFileSync(join(dirname(p2), "front.png"), makePng(8));
    expect(await getOrCreateArt({ path: p2 }, { cacheDir })).toBeNull();
    writeFileSync(join(dirname(p2), "folder.png"), makePng(10));
    writeFileSync(join(dirname(p2), "cover.png"), makePng(9));
    const k2 = await getOrCreateArt({ path: p2 }, { cacheDir });
    expect(k2).not.toBeNull();
    expect(k2).toBe(await getOrCreateArt({ path: embedded("X", makePng(9)) }, { cacheDir }));

    // Embarquee > dossier.
    const p3 = embedded("C", makePng(1));
    writeFileSync(join(dirname(p3), "cover.jpg"), makePng(50));
    const kEmb = await getOrCreateArt({ path: p3 }, { cacheDir });
    expect(kEmb).toBe(await getOrCreateArt({ path: embedded("D", makePng(1)) }, { cacheDir }));
  });

  it("cache non configure : null (jamais d'ecriture implicite)", async () => {
    expect(await getOrCreateArt({ path: embedded("A") })).toBeNull();
  });

  describe("resolveArtFile / serveArt", () => {
    it("refuse toute cle qui n'est pas un hash (pas de traversee de chemin)", () => {
      for (const k of ["", "..", "../x", "a/b", "A".repeat(40), "g".repeat(40), "abc"]) {
        expect(resolveArtFile(k, cacheDir)).toBeNull();
      }
    });

    it("sert le fichier cache en 200 avec le bon type MIME", async () => {
      const png = makePng(3);
      const key = (await getOrCreateArt({ path: embedded("A", png) }, { cacheDir }))!;
      const res = await serveArt(`benten-art://${key}?size=256`, cacheDir);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    });

    it("cle absente du cache, URL invalide ou cle nulle : 404 sans lever", async () => {
      expect((await serveArt(`benten-art://${"a".repeat(40)}`, cacheDir)).status).toBe(404);
      expect((await serveArt("benten-art://null", cacheDir)).status).toBe(404);
      expect((await serveArt("benten-art://", cacheDir)).status).toBe(404);
      expect((await serveArt("::pas une url", cacheDir)).status).toBe(404);
    });
  });

  describe("indexation", () => {
    it("renseigne artKey pour les pistes avec pochette, null sinon", async () => {
      embedded("Avec");
      plain("Sans");
      const db = openDb(join(root, "lib.db"));
      try {
        await indexLibrary(db, [join(root, "lib")], undefined, {
          getArt: (path) => getOrCreateArt({ path }, { cacheDir }),
        });
        const rows = getAllTracks(db, { limit: 10, offset: 0 });
        expect(rows).toHaveLength(2);
        const withArt = rows.filter((r) => r.artKey !== null);
        expect(withArt).toHaveLength(1);
        expect(withArt[0]!.artKey).toMatch(/^[0-9a-f]{40}$/);
        expect(cached()).toHaveLength(1);
      } finally {
        db.close();
      }
    });

    it("une erreur d'extraction de pochette n'interrompt pas l'indexation (artKey null)", async () => {
      plain("Sans");
      const db = openDb(join(root, "lib.db"));
      try {
        const res = await indexLibrary(db, [join(root, "lib")], undefined, {
          getArt: async () => {
            throw new Error("boom");
          },
        });
        expect(res.added).toBe(1);
        expect(getAllTracks(db, { limit: 10, offset: 0 })[0]!.artKey).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});
