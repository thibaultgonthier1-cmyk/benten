/**
 * Couleurs dynamiques d'une pochette : cache LRU (512) + déduplication des chargements en vol +
 * limiteur de concurrence + repli génératif (TTL après erreur), et le hook React
 * `useCoverColors` qui s'appuie dessus.
 *
 * Paresseux par construction : le hook ne lance l'extraction que dans un effet, donc seulement
 * pour les composants MONTÉS (pochettes visibles) ; rien ne pré-scanne la bibliothèque.
 * La couche « image → canvas » (`CoverSampler`) est injectable pour tester le cache en node.
 */

import { useEffect, useMemo, useState } from "react";
import { generativeCover } from "./cover";
import { artUrl } from "./library";
import { FALLBACK_RGB, extractPalette, hexToRgb, pickAccent, toAccent, toCss } from "./palette";

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
/** Durée de vie d'un repli mis en cache après une erreur (on réessaie ensuite). */
export const COVER_ERROR_TTL_MS = 30_000;
/** Décodages simultanés au plus (une grille de 200 tuiles ne lance pas 200 décodages d'un coup). */
export const COVER_CONCURRENCY = 4;
/** Taille demandée au protocole `benten-art://` (petite : on réduit ensuite à 32×32). */
const ART_SIZE = 64;
/** Côté de l'échantillonnage canvas. */
const SAMPLE_SIZE = 32;

/* ------------------------------------- Repli génératif ------------------------------------- */

/**
 * Couleurs d'une pochette absente (ou illisible) : dérivées de `generativeCover(fallbackKey).accent`.
 * `dominant` et `vibrant` = l'accent génératif tel quel ; `accent` = sa version `toAccent`
 * (≥ 4.5:1 sur noir, luminosité bornée : certains accents génératifs, ex. `#d6442f`, sont sous
 * 4.5:1, d'autres, ex. `#c9c2e0`, quasi blancs).
 */
export function fallbackCoverColors(fallbackKey: string): CoverColors {
  const rgb = hexToRgb(generativeCover(fallbackKey).accent) ?? FALLBACK_RGB;
  return { dominant: toCss(rgb), vibrant: toCss(rgb), accent: toCss(toAccent(rgb)) };
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
  /**
   * Lecture PURE (chemin de rendu) : couleurs en cache et non expirées pour `artKey`, sinon
   * `undefined`. Ne réordonne pas le LRU.
   */
  peek(artKey: string): CoverColors | undefined;
  /**
   * Couleurs de `artKey` : hit (marqué récemment utilisé), sinon chargement dédupliqué et limité
   * en concurrence ; repli génératif sur erreur (mis en cache `COVER_ERROR_TTL_MS`).
   */
  load(artKey: string, fallbackKey: string): Promise<CoverColors>;
  size(): number;
}

export interface CoverColorCacheOptions {
  sampler?: CoverSampler;
  capacity?: number;
  concurrency?: number;
  errorTtlMs?: number;
  /** Horloge injectable (tests du TTL). */
  now?: () => number;
}

interface Entry {
  colors: CoverColors;
  /** Échéance (ms) d'un repli après erreur ; `Infinity` pour une extraction réussie. */
  expires: number;
}

export function createCoverColorCache(options: CoverColorCacheOptions = {}): CoverColorCache {
  const sampler = options.sampler ?? browserCoverSampler;
  const capacity = Math.max(1, options.capacity ?? COVER_COLOR_CACHE_SIZE);
  const concurrency = Math.max(1, options.concurrency ?? COVER_CONCURRENCY);
  const errorTtl = options.errorTtlMs ?? COVER_ERROR_TTL_MS;
  const now = options.now ?? Date.now;
  // Map = ordre d'insertion : la première clé est la moins récemment utilisée.
  const lru = new Map<string, Entry>();
  const inflight = new Map<string, Promise<CoverColors>>();

  /* Limiteur : au plus `concurrency` extractions actives. File LIFO : la demande la plus récente
   * (la tuile qui vient d'apparaître pendant un défilement) passe en premier. */
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.pop();
    if (next) next(); // le créneau passe directement au suivant (active inchangé)
    else active--;
  };

  const live = (artKey: string): Entry | undefined => {
    const e = lru.get(artKey);
    if (!e) return undefined;
    if (e.expires <= now()) {
      lru.delete(artKey);
      return undefined;
    }
    return e;
  };

  const remember = (artKey: string, entry: Entry) => {
    lru.delete(artKey);
    lru.set(artKey, entry);
    while (lru.size > capacity) lru.delete(lru.keys().next().value!);
  };

  const peek = (artKey: string): CoverColors | undefined => {
    const e = lru.get(artKey);
    return e && e.expires > now() ? e.colors : undefined;
  };

  const extract = async (artKey: string, fallbackKey: string): Promise<Entry> => {
    await acquire();
    try {
      const url = artUrl(artKey, ART_SIZE);
      if (!url) return { colors: fallbackCoverColors(fallbackKey), expires: Infinity };
      const { data, width, height } = await sampler(url);
      const palette = extractPalette(data, width, height);
      return {
        colors: {
          dominant: toCss(palette.dominant),
          vibrant: toCss(palette.vibrant),
          accent: toCss(pickAccent(palette)),
        },
        expires: Infinity,
      };
    } catch {
      // Image introuvable, canvas « tainted »… : repli génératif, mis en cache pour un TTL court
      // (pas de reboucle immédiate, mais un nouvel essai plus tard si le fichier réapparaît).
      return { colors: fallbackCoverColors(fallbackKey), expires: now() + errorTtl };
    } finally {
      release();
    }
  };

  const load = (artKey: string, fallbackKey: string): Promise<CoverColors> => {
    const hit = live(artKey);
    if (hit) {
      remember(artKey, hit); // « touche » : devient la plus récente
      return Promise.resolve(hit.colors);
    }
    const pending = inflight.get(artKey);
    if (pending) return pending;
    const p = extract(artKey, fallbackKey).then((entry) => {
      inflight.delete(artKey);
      remember(artKey, entry);
      return entry.colors;
    });
    inflight.set(artKey, p);
    return p;
  };

  return { peek, load, size: () => lru.size };
}

/** Cache partagé par toute l'app (une seule extraction par pochette, quel que soit le composant). */
export const coverColorCache: CoverColorCache = createCoverColorCache();

/* ------------------------------------------ Hook ------------------------------------------ */

/** État du hook : couleurs résolues pour une `artKey` donnée. */
export interface CoverColorsState {
  key: string;
  colors: CoverColors;
}

/** État initial : un hit au montage est FIGÉ dans l'état (une éviction LRU ultérieure ne l'efface pas). */
export function initCoverState(artKey: string | null, cache: CoverColorCache): CoverColorsState | null {
  if (!artKey) return null;
  const hit = cache.peek(artKey);
  return hit ? { key: artKey, colors: hit } : null;
}

/** Couleurs à rendre : état de la même `artKey`, sinon lecture pure du cache, sinon repli. */
export function selectCoverColors(
  artKey: string | null,
  state: CoverColorsState | null,
  cache: CoverColorCache,
  fallback: CoverColors,
): CoverColors {
  if (!artKey) return fallback;
  if (state?.key === artKey) return state.colors;
  return cache.peek(artKey) ?? fallback;
}

/**
 * Couleurs `{ dominant, vibrant, accent }` (chaînes CSS) d'une pochette.
 * - `artKey` null → repli génératif `fallbackKey`, aucun chargement.
 * - Sinon : valeur en cache immédiate, ou repli le temps de l'extraction (lancée au montage).
 * - L'effet appelle toujours `cache.load` (résolu aussitôt sur un hit, qui « touche » le LRU) et
 *   fige le résultat dans l'état ; il n'est appliqué que si le composant est toujours monté ET
 *   que `artKey` n'a pas changé entre-temps (pas de setState périmé).
 * - Le chemin de rendu ne fait que des lectures pures (`peek`) : il ne réordonne pas le LRU.
 */
export function useCoverColors(
  artKey: string | null,
  fallbackKey: string,
  cache: CoverColorCache = coverColorCache,
): CoverColors {
  const fallback = useMemo(() => fallbackCoverColors(fallbackKey), [fallbackKey]);
  const [state, setState] = useState<CoverColorsState | null>(() => initCoverState(artKey, cache));

  useEffect(() => {
    if (!artKey) return;
    let alive = true;
    void cache.load(artKey, fallbackKey).then((colors) => {
      if (!alive) return;
      setState((prev) => (prev?.key === artKey && prev.colors === colors ? prev : { key: artKey, colors }));
    });
    return () => {
      alive = false;
    };
  }, [artKey, fallbackKey, cache]);

  return selectCoverColors(artKey, state, cache, fallback);
}
