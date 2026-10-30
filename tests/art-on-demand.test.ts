import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateArt, serveArt, type Resizer } from "../src/main/library/artcache";

/**
 * La pochette doit revenir MÊME si le cache a été vidé (ou vidé à la main par l'utilisateur).
 * Sans le résolveur de source, `serveArt` renvoyait 404 et l'app retombait sur les visuels
 * génératifs — définitivement, jusqu'à une ré-indexation.
 */

// Pochette de dossier : un JPEG à côté du fichier audio, cas réel d'une bibliothèque locale.
const COVER_JPG = join(__dirname, "fixtures/art/cover.jpg");
const SRC_FLAC = join(__dirname, "fixtures/library/Ridsa/Tranquille/13 - Pardon.flac");
const thumb: Resizer = (data) => data;

describe("serveArt — ré-extraction à la demande", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("extrait la pochette quand le cache est vide, puis la sert", async () => {
    dir = mkdtempSync(join(tmpdir(), "benten-art-"));
    // On connaît la clé attendue : on la fait produire par un premier passage, puis on vide tout.
    // On copie le FLAC dans un dossier temporaire avec une pochette `cover.jpg` à côté : c'est le
    // cas « pochette de dossier », sans dépendre de l'art embarqué du fixture.
    const audioDir = mkdtempSync(join(tmpdir(), "benten-audio-"));
    const audio = join(audioDir, "01 - Titre.flac");
    copyFileSync(SRC_FLAC, audio);
    copyFileSync(COVER_JPG, join(audioDir, "cover.jpg"));
    const first = await getOrCreateArt({ path: audio }, { cacheDir: dir });
    expect(first).toBeTypeOf("string");
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "benten-art-"));

    const resolve = vi.fn(() => audio);
    const response = await serveArt(`benten-art://${first}?size=512`, dir, resolve);
    expect(resolve).toHaveBeenCalledWith(first);
    expect(response.status).toBe(200);
    expect((response.headers.get("content-type") ?? "").startsWith("image/")).toBe(true);
  });

  it("renvoie 404 si la source est introuvable", async () => {
    dir = mkdtempSync(join(tmpdir(), "benten-art-"));
    const response = await serveArt(`benten-art://${"a".repeat(40)}?size=512`, dir, () => null);
    expect(response.status).toBe(404);
  });

  it("renvoie 404 si le résolveur ne trouve pas de fichier exploitable", async () => {
    dir = mkdtempSync(join(tmpdir(), "benten-art-"));
    const response = await serveArt(`benten-art://${"b".repeat(40)}?size=512`, dir, () => join(dir, "absent.flac"));
    expect(response.status).toBe(404);
  });
});


