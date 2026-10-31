import { join } from "node:path";
import { app, nativeImage, protocol } from "electron";
import { configureArtCache, DEFAULT_ART_SIZE, serveArt, type Resizer } from "./library/artcache";
import { findContentBox } from "./library/artcrop";

export const ART_SCHEME = "benten-art";

/** Dossier du cache de pochettes, sous le dossier de donnees de l'app. */
export const artCacheDir = (): string => join(app.getPath("userData"), "art-cache");

/**
 * A appeler au chargement du module Main, AVANT `app.whenReady()` : declare le schema
 * (standard, utilisable par `fetch`/`<img>` depuis le Renderer).
 */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ART_SCHEME,
      // corsEnabled : `fetch` depuis le renderer (origine http/file) est autorise par l'en-tete
      // Access-Control-Allow-Origin de `serveArt` (pochette des touches media en blob).
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/** Vignette JPEG via `nativeImage` ; `null` si l'image est illisible ou deja assez petite. */
export const nativeImageResizer: Resizer = (data, size) => {
  let img = nativeImage.createFromBuffer(data);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();

  // Recadrage des pochettes à BANDES (visuels de clips, vignettes letterboxées) : sans ça la
  // grille affiche deux bandes claires autour du visuel. Le calcul se fait sur les pixels déjà en
  // mémoire — aucun outil externe, aucune requête.
  const bitmap = img.toBitmap(); // Buffer BGRA : c'est la forme documentée pour lire les pixels
  const box = bitmap && bitmap.length >= width * height * 4 ? findContentBox(bitmap, width, height) : null;
  if (box) img = img.crop(box);

  const cropped = img.getSize();
  if (Math.max(cropped.width, cropped.height) <= size) return null; // garder l'original tel quel
  const scale = size / Math.max(cropped.width, cropped.height);
  const out = img.resize({
    width: Math.max(1, Math.round(cropped.width * scale)),
    height: Math.max(1, Math.round(cropped.height * scale)),
    quality: "best",
  });
  return out.toJPEG(85);
};

/**
 * A appeler apres `app.whenReady()` : configure le cache (dossier + redimensionneur) et
 * installe le handler de `benten-art://<artKey>?size=<n>` (404 si pas de pochette).
 */
let resolveArtSource: ((artKey: string) => string | null) | null = null;

/**
 * Branche le résolveur `artKey -> chemin du fichier audio`. Appelé par le Main après ouverture de
 * la base : sans lui, une pochette absente du cache reste introuvable (404 → repli génératif).
 */
export function setArtSourceResolver(resolver: (artKey: string) => string | null): void {
  resolveArtSource = resolver;
}

export function registerArtProtocol(): void {
  const cacheDir = artCacheDir();
  configureArtCache({ cacheDir, size: DEFAULT_ART_SIZE, resize: nativeImageResizer });
  protocol.handle(ART_SCHEME, (request) =>
    serveArt(request.url, cacheDir, (artKey) => resolveArtSource?.(artKey) ?? null),
  );
}




