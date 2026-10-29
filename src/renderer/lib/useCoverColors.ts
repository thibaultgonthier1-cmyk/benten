/**
 * Couleurs dynamiques d'une pochette : cache LRU (512) + déduplication des chargements en vol +
 * repli génératif, et le hook React `useCoverColors` qui s'appuie dessus.
 *
 * Paresseux par construction : le hook ne lance l'extraction que dans un effet, donc seulement
 * pour les composants MONTÉS (pochettes visibles) ; rien ne pré-scanne la bibliothèque.
 * La couche « image → canvas » (`CoverSampler`) est injectable pour tester le cache en node.
 */

import { useEffect, useMemo, useState } from "react";
import { generativeCover } from "./cover";
import { artUrl } from "./library";
import { FALLBACK_RGB, extractPalette, hexToRgb, pickAccent, readableOnBlack, toCss } from "./palette";

export interface CoverColors {
  dominant: string;
  vibrant: string;
  accent: string;
}

/** Pixels RGBA échantillonnés d'une pochette. */
export interface CoverSample {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Charge l'image à `url` et renvoie ses pixels réduits (rejette sur erreur / canvas « tainted »). */
export type CoverSampler = (url: string) => Promise<CoverSample>;

export const COVER_COLOR_CACHE_SIZE = 512;
/** Taille demandée au protocole `benten-art://` (petite : on réduit ensuite à 32×32). */
const ART_SIZE = 64;
/** Côté de l'échantillonnage canvas. */
const SAMPLE_SIZE = 32;

/* ------------------------------------- Repli génératif ------------------------------------- */

/**
 * Couleurs d'une pochette absente (ou illisible) : dérivées de `generativeCover(fallbackKey).accent`.
 * `dominant` et `vibrant` = l'accent génératif tel quel ; `accent` = sa version `readableOnBlack`
 * (certains accents génératifs, ex. `#d6442f`, sont sous 4.5:1 sur noir).
 */
export function fallbackCoverColors(fallbackKey: string): CoverColors {
  const rgb = hexToRgb(generativeCover(fallbackKey).accent) ?? FALLBACK_RGB;
  return { dominant: toCss(rgb), vibrant: toCss(rgb), accent: toCss(readableOnBlack(rgb)) };
}

/* ------------------------------------ Sampler navigateur ------------------------------------ */

let sharedCtx: CanvasRenderingContext2D | null = null;

/** Contexte 2D 32×32 unique, réutilisé pour toutes les extractions. */
function sampleContext(): CanvasRenderingContext2D {
  if (sharedCtx) return sharedCtx;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d indisponible");
  sharedCtx = ctx;
  return ctx;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // `benten-art://` est corsEnabled et répond `access-control-allow-origin: *` : en mode CORS
    // anonyme le canvas n'est pas « tainted » et `getImageData` est autorisé.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cover load failed: ${url}`));
    img.src = url;
  });
}

/** Sampler réel : `Image` CORS → canvas partagé 32×32 → `getImageData`. */
export const browserCoverSampler: CoverSampler = async (url) => {
  const img = await loadImage(url);
  const ctx = sampleContext();
  ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return { data, width: SAMPLE_SIZE, height: SAMPLE_SIZE };
};

/* ----------------------------------------- Cache ----------------------------------------- */

export interface CoverColorCache {
  /** Couleurs en cache pour `artKey` (et la marque comme récemment utilisée), sinon `undefined`. */
  peek(artKey: string): CoverColors | undefined;
  /** Couleurs de `artKey` : cache, sinon chargement (dédupliqué) ; repli génératif sur erreur. */
  load(artKey: string, fallbackKey: string): Promise<CoverColors>;
  size(): number;
}

export interface CoverColorCacheOptions {
  sampler?: CoverSampler;
  capacity?: number;
}

export function createCoverColorCache(options: CoverColorCacheOptions = {}): CoverColorCache {
  const sampler = options.sampler ?? browserCoverSampler;
  const capacity = Math.max(1, options.capacity ?? COVER_COLOR_CACHE_SIZE);
  // Map = ordre d'insertion : la première clé est la moins récemment utilisée.
  const lru = new Map<string, CoverColors>();
  const inflight = new Map<string, Promise<CoverColors>>();

  const remember = (artKey: string, colors: CoverColors) => {
    lru.delete(artKey);
    lru.set(artKey, colors);
    while (lru.size > capacity) lru.delete(lru.keys().next().value!);
  };

  const peek = (artKey: string): CoverColors | undefined => {
    const hit = lru.get(artKey);
    if (hit) {
      lru.delete(artKey);
      lru.set(artKey, hit);
    }
    return hit;
  };

  const extract = async (artKey: string, fallbackKey: string): Promise<CoverColors> => {
    try {
      const url = artUrl(artKey, ART_SIZE);
      if (!url) return fallbackCoverColors(fallbackKey);
      const { data, width, height } = await sampler(url);
      const palette = extractPalette(data, width, height);
      return {
        dominant: toCss(palette.dominant),
        vibrant: toCss(palette.vibrant),
        accent: toCss(pickAccent(palette)),
      };
    } catch {
      // Image introuvable, canvas « tainted »… : repli génératif, MIS EN CACHE (pas de reboucle).
      return fallbackCoverColors(fallbackKey);
    }
  };

  const load = (artKey: string, fallbackKey: string): Promise<CoverColors> => {
    const hit = peek(artKey);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(artKey);
    if (pending) return pending;
    const p = extract(artKey, fallbackKey).then((colors) => {
      inflight.delete(artKey);
      remember(artKey, colors);
      return colors;
    });
    inflight.set(artKey, p);
    return p;
  };

  return { peek, load, size: () => lru.size };
}

/** Cache partagé par toute l'app (une seule extraction par pochette, quel que soit le composant). */
export const coverColorCache: CoverColorCache = createCoverColorCache();

/* ------------------------------------------ Hook ------------------------------------------ */

/**
 * Couleurs `{ dominant, vibrant, accent }` (chaînes CSS) d'une pochette.
 * - `artKey` null → repli génératif `fallbackKey`, aucun chargement.
 * - Sinon : valeur en cache immédiate, ou repli le temps de l'extraction (lancée au montage).
 * - Le résultat d'un chargement n'est appliqué que si le composant est toujours monté ET que
 *   `artKey` n'a pas changé entre-temps (pas de setState périmé).
 */
export function useCoverColors(
  artKey: string | null,
  fallbackKey: string,
  cache: CoverColorCache = coverColorCache,
): CoverColors {
  const fallback = useMemo(() => fallbackCoverColors(fallbackKey), [fallbackKey]);
  const [loaded, setLoaded] = useState<{ key: string; colors: CoverColors } | null>(null);

  useEffect(() => {
    if (!artKey || cache.peek(artKey)) return;
    let alive = true;
    void cache.load(artKey, fallbackKey).then((colors) => {
      if (alive) setLoaded({ key: artKey, colors });
    });
    return () => {
      alive = false;
    };
  }, [artKey, fallbackKey, cache]);

  if (!artKey) return fallback;
  if (loaded?.key === artKey) return loaded.colors;
  return cache.peek(artKey) ?? fallback;
}
