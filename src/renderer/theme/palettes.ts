/**
 * Palettes de Benten.
 *
 * Le thème or est l'identité d'origine (Benzaiten, laque et or). Il n'est plus le seul : chaque
 * palette garde la même structure (encre de nuit, surfaces profondes, un accent unique) et change
 * seulement l'ACCENT, les dégradés et les teintes dérivées. On ne touche jamais au texte ni aux
 * surfaces : c'est ce qui garantit que toutes les palettes restent lisibles.
 *
 * Application : `document.documentElement.dataset.palette = id`, et le bloc CSS correspondant
 * (voir `palettes.css`) écrase les variables d'accent.
 */

export type PaletteId = "or" | "argent" | "indigo" | "jade" | "rouge" | "brume";

export interface Palette {
  id: PaletteId;
  /** Nom affiché dans le sélecteur. */
  label: string;
  /** Nuance de référence, pour la pastille de choix. */
  swatch: string;
  /** Ce que la palette évoque — sert d'infobulle, pas de décoration. */
  hint: string;
}

export const PALETTES: readonly Palette[] = Object.freeze([
  { id: "or", label: "Or", swatch: "#d4aa50", hint: "Laque et or — l'identité d'origine" },
  { id: "argent", label: "Argent", swatch: "#c9cfd6", hint: "Clair de lune sur métal" },
  { id: "indigo", label: "Indigo", swatch: "#6f86d6", hint: "Bleu de nuit, encre profonde" },
  { id: "jade", label: "Jade", swatch: "#63c9a0", hint: "Pierre verte, eau calme" },
  { id: "rouge", label: "Vermillon", swatch: "#e0573f", hint: "Rouge des torii" },
  { id: "brume", label: "Brume", swatch: "#b9b2a6", hint: "Gris de papier ancien" },
]);

export const DEFAULT_PALETTE: PaletteId = "or";

/** Vrai si l'identifiant correspond à une palette connue (garde contre une sauvegarde corrompue). */
export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && PALETTES.some((palette) => palette.id === value);
}

/** Normalise une valeur quelconque en identifiant de palette valide. */
export function normalizePalette(value: unknown): PaletteId {
  return isPaletteId(value) ? value : DEFAULT_PALETTE;
}

/** Applique la palette au document (no-op hors navigateur). */
export function applyPalette(id: PaletteId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.palette = id;
}
