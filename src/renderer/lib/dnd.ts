/**
 * Glisser-déposer de titres entre vues (Phase 3, Tâche 4) : la charge est une liste d'ids de pistes
 * sérialisée en JSON sous un type MIME dédié — les autres glissers (fichiers, texte) l'ignorent.
 *
 * Pendant `dragover`, Chromium ne livre PAS les données (mode protégé : `getData` renvoie "") ;
 * une cible de dépôt teste donc `hasDragTracks` (types seuls) pour accepter, puis `readDragTracks`
 * au `drop`.
 */

export const BENTEN_TRACKS_MIME = "application/x-benten-tracks";

/** Repli texte (déposer dans un éditeur ne produit pas de JSON brut). */
const TEXT_PREFIX = "benten:tracks:";

const isTrackId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Pose la charge « titres » sur un `DataTransfer` (à appeler dans `dragstart`). */
export function setDragTracks(dt: DataTransfer, trackIds: readonly number[]): void {
  const ids = trackIds.filter(isTrackId);
  dt.setData(BENTEN_TRACKS_MIME, JSON.stringify(ids));
  dt.setData("text/plain", TEXT_PREFIX + ids.join(","));
  dt.effectAllowed = "copyMove";
}

/** Vrai si le glisser transporte des titres Benten (lisible dès `dragenter`/`dragover`). */
export function hasDragTracks(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes(BENTEN_TRACKS_MIME);
}

/**
 * Ids de pistes transportés, ou `null` si la charge est absente, corrompue, vide ou contient autre
 * chose que des ids entiers positifs. Ne lève jamais.
 */
export function readDragTracks(dt: DataTransfer): number[] | null {
  let raw: string;
  try {
    raw = dt.getData(BENTEN_TRACKS_MIME);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isTrackId)) return null;
  return parsed.slice();
}
