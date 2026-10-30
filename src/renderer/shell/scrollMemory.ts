/**
 * Mémoire de défilement des pages (clé = `routeKey`). Le `RouteView` relève la position de la page
 * quittée et, au retour par « Précédent », la restaure AVANT toute mesure de layout (phase de
 * mutation) ; il annonce la position prévue pour que la grille virtualisée monte directement les
 * bonnes rangées (`plannedScroll`).
 */

const saved = new Map<string, number>();
let planned: { key: string; top: number } | null = null;

/** Retient la position de défilement de la page `key`. */
export function rememberScroll(key: string, top: number): void {
  saved.set(key, Math.max(0, top));
}

/** Position mémorisée de `key` (ou `null`). */
export function savedScroll(key: string): number | null {
  return saved.get(key) ?? null;
}

/** Annonce la position que va prendre la page `key` (`null` : haut de page). */
export function planScroll(key: string, top: number | null): void {
  planned = top === null ? null : { key, top };
}

/** Position annoncée pour `key` si elle est restaurée, sinon `null`. */
export function plannedScroll(key: string): number | null {
  return planned && planned.key === key ? planned.top : null;
}
