import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { scanAudioFiles, type ScanFs } from "../src/main/library/scanner";
import { readMetadata } from "../src/main/library/metadata";

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("scanAudioFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "benten-scan-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function touch(rel: string): void {
    const p = join(root, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
  }
  const rels = (paths: string[]) => paths.map((p) => relative(root, p).split(sep).join("/")).sort();

  it("ne renvoie que les extensions connues, recursivement", async () => {
    touch("A/Al/01 - a.flac");
    touch("A/Al/02 - b.MP3");
    touch("A/Al/cover.jpg");
    touch("A/Al/notes.txt");
    touch("A/Al/Disc 2/03 - c.opus");
    touch("B/x.wav");
    touch("B/x.m4a");
    touch("B/x.aac");
    touch("B/x.ogg");
    touch("B/x.aiff");
    touch("B/x.m4p");
    touch("top.flac");
    expect(rels(await collect(scanAudioFiles(root)))).toEqual([
      "A/Al/01 - a.flac",
      "A/Al/02 - b.MP3",
      "A/Al/Disc 2/03 - c.opus",
      "B/x.aac",
      "B/x.aiff",
      "B/x.m4a",
      "B/x.ogg",
      "B/x.wav",
      "top.flac",
    ]);
  });

  it("ignore les dossiers caches (.cache/) et les fichiers caches", async () => {
    touch("A/Al/01 - a.flac");
    touch(".cache/ghost.flac");
    touch("A/.hidden/deep/ghost.flac");
    touch("A/Al/._01 - a.flac");
    expect(rels(await collect(scanAudioFiles(root)))).toEqual(["A/Al/01 - a.flac"]);
  });

  it("parcourt les vraies fixtures", async () => {
    const found = await collect(scanAudioFiles(join(__dirname, "fixtures", "library")));
    expect(found).toHaveLength(6);
    expect(found.every((p) => p.endsWith(".flac"))).toBe(true);
  });

  it("un dossier illisible n'interrompt pas le parcours", async () => {
    const fake: ScanFs = {
      async readdir(dir) {
        const e = (name: string, d: boolean) => ({ name, isDirectory: () => d, isFile: () => !d });
        if (dir === "/r") return [e("bad", true), e("ok", true), e("z.flac", false)];
        if (dir === join("/r", "bad")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        if (dir === join("/r", "ok")) return [e("y.flac", false)];
        return [];
      },
    };
    const out = await collect(scanAudioFiles("/r", fake));
    expect(out).toEqual([join("/r", "ok", "y.flac"), join("/r", "z.flac")]);
  });

  // Review Focus : un fichier corrompu ne doit jamais casser le scan.
  it("renvoie un fichier corrompu et continue l'iteration ; readMetadata le marque non lisible", async () => {
    const fx = join(__dirname, "fixtures");
    const good = join(fx, "library", "Ridsa", "Tranquille", "13 - Pardon.flac");
    const bad = join(fx, "corrupt", "Artiste Z", "Album Cassé", "01 - Tronqué.flac");
    // un seul dossier d'album : bon, corrompu (au milieu), bon
    const album = join(root, "Artiste", "Album");
    mkdirSync(album, { recursive: true });
    copyFileSync(good, join(album, "01 - a.flac"));
    copyFileSync(bad, join(album, "02 - b.flac"));
    copyFileSync(good, join(album, "03 - c.flac"));

    const scanned = await collect(scanAudioFiles(root));
    expect(scanned.map((p) => basename(p))).toEqual(["01 - a.flac", "02 - b.flac", "03 - c.flac"]);

    const playable: boolean[] = [];
    for (const p of scanned) playable.push((await readMetadata(p)).playable);
    expect(playable).toEqual([true, false, true]);
  });
});
