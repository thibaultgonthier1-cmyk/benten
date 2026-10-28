import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Cache disque des pochettes.
 *
 * - Source : image embarquee dans le fichier audio (prioritaire), sinon `cover.*` puis
 *   `folder.*` du dossier de la piste.
 * - Cle (`artKey`) : SHA-1 de `<taille>:<octets de l'image source>` — derivee du CONTENU,
 *   donc stable et partagee par toutes les pistes d'un meme album ; la taille cible en fait
 *   partie pour qu'un changement de reglage regenere les vignettes.
 * - Fichier : `<cacheDir>/<artKey>.img` (le type MIME est reconnu a la lecture, par signature).
 * - Une seule taille est mise en cache en Phase 1 (`size`, 512 px par defaut).
 *
 * Ce module ne depend pas d'Electron (testable sous Node) : le redimensionnement reel est
 * injecte via `Resizer` (cf. `src/main/artprotocol.ts`, qui fournit un resizer `nativeImage`).
 * Sans resizer, l'image d'origine est mise en cache telle quelle.
 */

/** Taille cible par defaut (cote le plus long, en px). */
export const DEFAULT_ART_SIZE = 512;
/** Une image plus grosse n'est pas lue (fichier de dossier aberrant). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{40}$/;
const FOLDER_NAMES = ["cover", "folder"] as const;
const FOLDER_EXTS = ["jpg", "jpeg", "png", "webp"] as const;

/** Reduit `data` a `size` px max ; `null` = pas de vignette (garder l'original). Peut lever. */
export type Resizer = (data: Buffer, size: number) => Buffer | null | Promise<Buffer | null>;

export interface ArtOptions {
  /** Dossier du cache ; defaut : celui de `configureArtCache`. Sans lui : pas de cache (`null`). */
  cacheDir?: string;
  size?: number;
  resize?: Resizer;
}

let defaults: ArtOptions = {};

/** Fixe le dossier de cache / la taille / le resizer utilises par defaut (appele par le Main). */
export function configureArtCache(opts: ArtOptions): void {
  defaults = { ...opts };
}

/** Type MIME reconnu a la signature des octets ; `null` si ce n'est pas une image gerees. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
}

/** music-metadata est ESM-only (main compile en CJS) : import dynamique, comme metadata.ts. */
let parserModule: Promise<typeof import("music-metadata")> | undefined;
const loadParser = (): Promise<typeof import("music-metadata")> =>
  (parserModule ??= import("music-metadata"));

async function embeddedPicture(path: string): Promise<Buffer | null> {
  try {
    const { parseFile } = await loadParser();
    const meta = await parseFile(path, { duration: false, skipPostHeaders: true });
    const pics = meta.common.picture;
    if (!pics || pics.length === 0) return null;
    const front = pics.find((p) => /front/i.test(p.type ?? "")) ?? pics[0]!;
    return Buffer.from(front.data);
  } catch {
    return null;
  }
}

async function folderPicture(path: string): Promise<Buffer | null> {
  try {
    const dir = dirname(path);
    const names = await readdir(dir);
    for (const base of FOLDER_NAMES) {
      for (const ext of FOLDER_EXTS) {
        const wanted = `${base}.${ext}`;
        const found = names.find((n) => n.toLowerCase() === wanted);
        if (!found) continue;
        const file = join(dir, found);
        if ((await stat(file)).size > MAX_IMAGE_BYTES) continue;
        const data = await readFile(file);
        if (sniffImageMime(data)) return data;
      }
    }
  } catch {
    /* dossier illisible : pas de pochette */
  }
  return null;
}

/** Ecritures en cours, par fichier final : evite deux ecritures concurrentes de la meme pochette. */
const inflight = new Map<string, Promise<void>>();

/**
 * Extrait la pochette de `track` (embarquee, sinon `cover.*`/`folder.*`), ecrit la vignette
 * en cache si elle n'y est pas deja, et renvoie son `artKey` stable. `null` s'il n'y a pas de
 * pochette (ou pas de cache configure) ; ne leve jamais.
 */
export async function getOrCreateArt(
  track: { path: string },
  opts: ArtOptions = {},
): Promise<string | null> {
  const cacheDir = opts.cacheDir ?? defaults.cacheDir;
  if (!cacheDir) return null;
  const size = opts.size ?? defaults.size ?? DEFAULT_ART_SIZE;
  const resize = opts.resize ?? defaults.resize;
  try {
    const source = (await embeddedPicture(track.path)) ?? (await folderPicture(track.path));
    if (!source || source.length === 0 || !sniffImageMime(source)) return null;

    const key = createHash("sha1").update(`${size}:`).update(source).digest("hex");
    const file = join(cacheDir, `${key}.img`);
    if (existsSync(file)) return key; // cache hit : ni redimensionnement ni reecriture

    let pending = inflight.get(file);
    if (!pending) {
      pending = (async () => {
        let data = source;
        if (resize) {
          try {
            const thumb = await resize(source, size);
            if (thumb && thumb.length > 0 && sniffImageMime(thumb)) data = thumb;
          } catch {
            /* resizer defaillant : on garde l'original */
          }
        }
        await mkdir(cacheDir, { recursive: true });
        // Ecriture atomique : jamais de fichier partiel visible sous son nom final.
        const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(tmp, data);
          await rename(tmp, file);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
      })().finally(() => inflight.delete(file));
      inflight.set(file, pending);
    }
    await pending;
    return key;
  } catch {
    return null; // echec d'ecriture du cache : la piste s'affichera avec le repli generatif
  }
}

/** Chemin du fichier cache de `artKey`, ou `null` (cle invalide ou absente du cache). */
export function resolveArtFile(artKey: string, cacheDir: string): string | null {
  if (!KEY_RE.test(artKey)) return null; // pas de traversee de chemin
  const file = join(cacheDir, `${artKey}.img`);
  return existsSync(file) ? file : null;
}

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

/**
 * Reponse du protocole `benten-art://<artKey>?size=<n>`. 404 si la cle est invalide ou
 * absente (le Renderer affiche alors son repli generatif). `size` est accepte mais ignore :
 * une seule taille est cachee en Phase 1.
 */
export async function serveArt(url: string, cacheDir: string): Promise<Response> {
  try {
    const key = new URL(url).hostname;
    const file = resolveArtFile(key, cacheDir);
    if (!file) return NOT_FOUND();
    const data = await readFile(file);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": sniffImageMime(data) ?? "application/octet-stream",
        // Contenu adresse par son hash : immuable.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NOT_FOUND();
  }
}
