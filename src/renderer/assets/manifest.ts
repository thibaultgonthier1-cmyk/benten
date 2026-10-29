/**
 * Manifeste des ressources DA « Biwa & Or » : UN point de branchement par ressource (texture,
 * effet vidéo, illustration, logo, intro). Chaque composant signature demande son url ici et, tant
 * qu'elle vaut `null`, rend son repli dessiné en code (permanent : c'est aussi la version Réduit).
 *
 * DA2 : rien n'est branché — toutes les entrées valent `null`. DA4 remplit la carte avec les
 * ressources validées (embarquées, hors-ligne). Les effets `fx.*` sont rendus sur fond noir
 * OPAQUE et composés par le CSS `mix-blend-mode: screen` (pas d'alpha VP9).
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

const ASSET_MAP: Readonly<Record<AssetId, string | null>> = Object.freeze({
  "tex.goldLeaf": null,
  "tex.lacquer": null,
  "tex.seigaihaDisc": null,
  "tex.washi": null,
  "fx.pluck": null,
  "fx.inkVeil": null,
  "fx.goldFlakes": null,
  "fx.ripple": null,
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
