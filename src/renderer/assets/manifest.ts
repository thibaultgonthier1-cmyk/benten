/**
 * Manifeste des ressources DA « Biwa & Or » : UN point de branchement par ressource (texture,
 * effet vidéo, illustration, logo, intro). Chaque composant signature demande son url ici et, tant
 * qu'elle vaut `null`, rend son repli dessiné en code (permanent : c'est aussi la version Réduit).
 *
 * DA4 : les effets et les textures validés sont branchés (4,98 Mo au total, très en dessous du
 * plafond de 20 Mo). Les illustrations et l'intro restent `null` tant qu'elles ne sont pas
 * approuvées. Les effets `fx.*` sont rendus sur fond noir OPAQUE et composés par le CSS
 * `mix-blend-mode: screen` (pas d'alpha VP9).
 */

export const ASSET_IDS = [
  "tex.goldLeaf",
  "tex.lacquer",
  "tex.seigaihaDisc",
  "tex.washi",
  "fx.pluck",
  "fx.inkVeil",
  "fx.goldFlakes",
  "fx.ripple",
  "ill.emptyLibrary",
  "ill.emptyPlaylist",
  "ill.noResults",
  "ill.onboarding",
  "logo.animated",
  "intro.gold",
] as const;

export type AssetId = (typeof ASSET_IDS)[number];

/**
 * `new URL(..., import.meta.url)` : Vite résout l'asset au build et laisse passer en dev.
 * Les fichiers vivent sous `src/renderer/assets/` et sont donc embarqués, hors-ligne.
 */
const url = (relative: string): string => new URL(relative, import.meta.url).href;

const ASSET_MAP: Readonly<Record<AssetId, string | null>> = Object.freeze({
  "tex.goldLeaf": url("./tex/gold-leaf.png"),
  "tex.lacquer": url("./tex/lacquer.png"),
  "tex.seigaihaDisc": url("./tex/seigaiha-disc.png"),
  "tex.washi": null,
  "fx.pluck": url("./fx/pluck.webm"),
  "fx.inkVeil": url("./fx/inkveil.webm"),
  "fx.goldFlakes": url("./fx/goldflakes.webm"),
  "fx.ripple": url("./fx/ripple.webm"),
  "ill.emptyLibrary": null,
  "ill.emptyPlaylist": null,
  "ill.noResults": null,
  "ill.onboarding": null,
  "logo.animated": null,
  "intro.gold": null,
});

/** Url embarquée de la ressource, ou `null` tant qu'elle n'est pas produite (→ repli en code). */
export function assetUrl(id: AssetId): string | null {
  return Object.prototype.hasOwnProperty.call(ASSET_MAP, id) ? ASSET_MAP[id] : null;
}
