import { join } from "node:path";
import { app, nativeImage, protocol } from "electron";
import { configureArtCache, DEFAULT_ART_SIZE, serveArt, type Resizer } from "./library/artcache";

export const ART_SCHEME = "benten-art";

/** Dossier du cache de pochettes, sous le dossier de donnees de l'app. */
export const artCacheDir = (): string => join(app.getPath("userData"), "art-cache");

/**
 * A appeler au chargement du module Main, AVANT `app.whenReady()` : declare le schema
 * (standard, utilisable par `fetch`/`<img>` depuis le Renderer).
 */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Vignette JPEG via `nativeImage` ; `null` si l'image est illisible ou deja assez petite. */
export const nativeImageResizer: Resizer = (data, size) => {
  const img = nativeImage.createFromBuffer(data);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= size) return null; // garder l'original tel quel
  const scale = size / Math.max(width, height);
  const out = img.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "best",
  });
  return out.toJPEG(85);
};

/**
 * A appeler apres `app.whenReady()` : configure le cache (dossier + redimensionneur) et
 * installe le handler de `benten-art://<artKey>?size=<n>` (404 si pas de pochette).
 */
export function registerArtProtocol(): void {
  const cacheDir = artCacheDir();
  configureArtCache({ cacheDir, size: DEFAULT_ART_SIZE, resize: nativeImageResizer });
  protocol.handle(ART_SCHEME, (request) => serveArt(request.url, cacheDir));
}
