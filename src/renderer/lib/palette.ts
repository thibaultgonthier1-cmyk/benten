/**
 * Extraction de palette depuis les pixels d'une pochette (fonctions pures, sans DOM).
 *
 * Pipeline : pixels RGBA (typiquement 32×32 échantillonnés sur canvas) → filtrage des pixels
 * presque noirs / presque blancs / transparents → quantification 4 bits par canal (4096 boîtes)
 * → dominante (boîte la plus peuplée) + vive (boîte maximisant chroma × population, hors boîtes
 * quasi noires / quasi blanches).
 * Chaque couleur renvoyée est la MOYENNE des pixels de sa boîte (plus fidèle que le centre).
 */

export type RGB = [number, number, number];

export interface CoverPalette {
  dominant: RGB;
  vibrant: RGB;
}

/** Repli quand aucun pixel exploitable ne reste : l'accent magenta de Benten (#e73c82). */
export const FALLBACK_RGB: RGB = [231, 60, 130];

/** Seuils de luma (Rec. 601, 0..255) en dessous / au-dessus desquels un pixel est ignoré. */
const LUMA_MIN = 18;
const LUMA_MAX = 245;
/** Pixels plus transparents que ça : ignorés (PNG détourés). */
const ALPHA_MIN = 128;
/** Contraste WCAG minimal visé sur `#000` (texte normal, niveau AA). */
const MIN_CONTRAST = 4.5;
/** Chroma (max − min, 0..255) sous laquelle une couleur est jugée « trop grise » pour l'accent. */
export const GREY_CHROMA = Math.round(0.12 * 255);
/** Bornes de luminosité HSL des boîtes candidates à la couleur vive (hors quasi-noir / quasi-blanc). */
const VIBRANT_L_MIN = 0.15;
const VIBRANT_L_MAX = 0.85;
/** Luminosité HSL maximale d'un accent : une teinte pâle reste une teinte, pas un blanc cassé. */
export const ACCENT_L_MAX = 0.75;

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Chroma (0..255) = max − min. Contrairement à la saturation HSL, elle n'est pas gonflée près du
 * noir ni près du blanc (un marine `(20,30,80)` ou une crème `(249,243,226)` ont une S HSL élevée
 * mais une chroma faible) : c'est la bonne mesure de « vivacité » perçue.
 */
export function chroma([r, g, b]: RGB): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Luminosité HSL (0..1). */
const hslLightness = ([r, g, b]: RGB) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;

/**
 * Palette dominante + vive d'une image RGBA `width×height`.
 * - dominante : boîte la plus peuplée ;
 * - vive : boîte maximisant chroma × population, parmi celles de luminosité HSL dans
 *   [0.15, 0.85] (repli : la dominante si aucune boîte n'y entre).
 * Déterministe : à pixels égaux, résultat égal (égalités départagées par l'index de boîte).
 */
export function extractPalette(rgba: Uint8ClampedArray, width: number, height: number): CoverPalette {
  const n = Math.min(rgba.length >> 2, Math.max(0, width * height));
  const count = new Uint32Array(4096);
  const sumR = new Uint32Array(4096);
  const sumG = new Uint32Array(4096);
  const sumB = new Uint32Array(4096);
  let kept = 0;

  for (let p = 0; p < n; p++) {
    const i = p << 2;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const a = rgba[i + 3]!;
    if (a < ALPHA_MIN) continue;
    const y = luma(r, g, b);
    if (y < LUMA_MIN || y > LUMA_MAX) continue;
    const box = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    count[box]!++;
    sumR[box]! += r;
    sumG[box]! += g;
    sumB[box]! += b;
    kept++;
  }

  if (kept === 0) return { dominant: [...FALLBACK_RGB], vibrant: [...FALLBACK_RGB] };

  const mean = (box: number): RGB => {
    const c = count[box]!;
    return [Math.round(sumR[box]! / c), Math.round(sumG[box]! / c), Math.round(sumB[box]! / c)];
  };

  let domBox = -1;
  let domCount = 0;
  let vibBox = -1;
  let vibScore = -1;
  for (let box = 0; box < 4096; box++) {
    const c = count[box]!;
    if (c === 0) continue;
    if (c > domCount) {
      domCount = c;
      domBox = box;
    }
    const m = mean(box);
    const l = hslLightness(m);
    if (l < VIBRANT_L_MIN || l > VIBRANT_L_MAX) continue;
    const score = chroma(m) * c;
    if (score > vibScore) {
      vibScore = score;
      vibBox = box;
    }
  }

  const dominant = mean(domBox);
  return { dominant, vibrant: vibBox < 0 ? dominant : mean(vibBox) };
}

/* ---------------------------------------- HSL ---------------------------------------- */

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) => Math.min(255, Math.max(0, Math.round((v + m) * 255)));
  return [to(r), to(g), to(b)];
}

/* -------------------------------------- Contraste -------------------------------------- */

/** Luminance relative WCAG 2.x (0..1). */
function relativeLuminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rapport de contraste WCAG d'une couleur sur `#000` (1..21). */
export function contrastOnBlack(rgb: RGB): number {
  return (relativeLuminance(rgb) + 0.05) / 0.05;
}

/**
 * Remonte la luminosité HSL (teinte et saturation conservées) jusqu'au plus petit niveau qui
 * donne un contraste ≥ 4.5:1 sur `#000`. Une couleur déjà lisible est renvoyée telle quelle.
 * Recherche dichotomique sur L ∈ [L courant, 1] ; L = 1 (blanc, 21:1) garantit la terminaison.
 */
export function readableOnBlack(rgb: RGB): RGB {
  if (contrastOnBlack(rgb) >= MIN_CONTRAST) return [rgb[0], rgb[1], rgb[2]];
  const [h, s, l0] = rgbToHsl(rgb);
  let lo = l0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastOnBlack(hslToRgb(h, s, mid)) >= MIN_CONTRAST) hi = mid;
    else lo = mid;
  }
  // L'arrondi à l'entier peut retomber juste sous le seuil : on remonte par petits pas.
  let l = hi;
  let out = hslToRgb(h, s, l);
  while (contrastOnBlack(out) < MIN_CONTRAST && l < 1) {
    l = Math.min(1, l + 0.002);
    out = hslToRgb(h, s, l);
  }
  return out;
}

/**
 * Met une couleur en forme d'accent sur noir : `readableOnBlack` (plancher 4.5:1), puis luminosité
 * HSL bornée à ≤ 0.75 (teinte et saturation conservées) pour qu'un ton pâle garde sa couleur.
 * Si la borne faisait repasser sous 4.5:1 (impossible en pratique : à L = 0.75 le pire cas, le
 * bleu pur, est ≈ 6.4:1), le plancher l'emporte.
 */
export function toAccent(rgb: RGB): RGB {
  const readable = readableOnBlack(rgb);
  const [h, s, l] = rgbToHsl(readable);
  if (l <= ACCENT_L_MAX) return readable;
  const bounded = hslToRgb(h, s, ACCENT_L_MAX);
  return contrastOnBlack(bounded) >= MIN_CONTRAST ? bounded : readableOnBlack(bounded);
}

/**
 * Règle d'accent (couleur d'UI posée sur le fond noir), en chroma (max − min) :
 * 1. la vive si sa chroma ≥ 0.12 × 255 ;
 * 2. sinon la dominante si sa chroma ≥ 0.12 × 255 ;
 * 3. sinon (pochette grise / N&B) le magenta Benten `FALLBACK_RGB`.
 * Puis `toAccent` : contraste ≥ 4.5:1 sur `#000` ET luminosité HSL ≤ 0.75.
 */
export function pickAccent({ dominant, vibrant }: CoverPalette): RGB {
  const base =
    chroma(vibrant) >= GREY_CHROMA ? vibrant : chroma(dominant) >= GREY_CHROMA ? dominant : FALLBACK_RGB;
  return toAccent(base);
}

/** `rgb(r, g, b)` ou, avec `alpha`, `rgba(r, g, b, a)`. */
export function toCss([r, g, b]: RGB, alpha?: number): string {
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** `#rrggbb` / `#rgb` → RGB ; `null` si la chaîne n'est pas un hex valide. */
export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
