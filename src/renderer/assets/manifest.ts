/**
 * Manifeste des ressources DA « Biwa & Or » : UN point de branchement par ressource (texture,
 * effet vidéo, illustration, logo, intro). Chaque composant signature demande son url ici et, tant
 * qu'elle vaut `null`, rend son repli dessiné en code (permanent : c'est aussi la version Réduit).
 *
 * ATTENTION : les `new URL("./…", import.meta.url)` doivent rester **littéraux**, écrits sur place.
 * Vite ne reconnaît que cette forme pour émettre le fichier dans le bundle ; passer par une
 * fonction utilitaire (`url(relative)`) l'en empêchait, et les ressources manquaient à l'exécution
 * — silencieusement, puisque chaque composant possède un repli.
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
  "scene.torii",
  "scene.benten",
  "intro.gold",
] as const;

export type AssetId = (typeof ASSET_IDS)[number];

const ASSET_MAP: Readonly<Record<AssetId, string | null>> = Object.freeze({
  "tex.goldLeaf": new URL("./tex/gold-leaf.png", import.meta.url).href,
  "tex.lacquer": new URL("./tex/lacquer.png", import.meta.url).href,
  "tex.seigaihaDisc": new URL("./tex/seigaiha-disc.png", import.meta.url).href,
  "tex.washi": new URL("./tex/washi.webp", import.meta.url).href,
  "fx.pluck": new URL("./fx/pluck.webm", import.meta.url).href,
  "fx.inkVeil": new URL("./fx/inkveil.webm", import.meta.url).href,
  "fx.goldFlakes": new URL("./fx/goldflakes.webm", import.meta.url).href,
  "fx.ripple": new URL("./fx/ripple.webm", import.meta.url).href,
  "ill.emptyLibrary": new URL("./ill/empty-library.webp", import.meta.url).href,
  "ill.emptyPlaylist": new URL("./ill/empty-playlist.webp", import.meta.url).href,
  "ill.noResults": new URL("./ill/no-results.webp", import.meta.url).href,
  "ill.onboarding": new URL("./ill/onboarding.webp", import.meta.url).href,
  "logo.animated": new URL("./motion/logo.webm", import.meta.url).href,
  // Scène 3D (Blender) : torii, soleil, eau et anneaux, boucle de 6 s avec transparence.
  "scene.torii": new URL("./motion/scene-torii.webm", import.meta.url).href,
  // Scène Benten : la joueuse de biwa en trois plans (icônes DA), caméra qui avance.
  "scene.benten": new URL("./motion/scene-benten.webm", import.meta.url).href,
  "intro.gold": new URL("./intro/gold.mp4", import.meta.url).href,
});

/** Url embarquée de la ressource, ou `null` tant qu'elle n'est pas produite (→ repli en code). */
export function assetUrl(id: AssetId): string | null {
  return Object.prototype.hasOwnProperty.call(ASSET_MAP, id) ? ASSET_MAP[id] : null;
}




