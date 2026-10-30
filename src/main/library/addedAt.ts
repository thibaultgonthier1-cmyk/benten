import type Database from "better-sqlite3";

type Db = Database.Database;

/** Ce que la date d'ajout lit d'un `fs.Stats` (injectable pour les tests). */
export interface AddedAtStat {
  birthtimeMs?: number;
  mtimeMs: number;
}

export type AddedAtStatFn = (path: string) => Promise<AddedAtStat>;

/** Stats lus en parallèle pendant le rattrapage (borne les descripteurs ouverts). */
const STAT_CONCURRENCY = 32;

const positive = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Date d'ajout d'un fichier (ms epoch, entier) : sa date de CRÉATION (birthtime), qui suit l'ordre
 * dans lequel la bibliothèque a été constituée ; repli sur mtime quand le système de fichiers ne
 * la fournit pas (0 / absente). `null` si aucune des deux n'est exploitable.
 */
export function addedAtFromStat(st: AddedAtStat): number | null {
  if (positive(st.birthtimeMs)) return Math.round(st.birthtimeMs);
  if (positive(st.mtimeMs)) return Math.round(st.mtimeMs);
  return null;
}

/**
 * Rattrapage unique au démarrage : complète `added_at_ms` des pistes indexées avant la v3 (NULL).
 * Les fichiers sont interrogés en parallèle (borné), puis TOUTES les dates sont écrites dans une
 * seule transaction. Un fichier absent ou illisible garde NULL (retenté au prochain démarrage).
 * Ne touche jamais une date déjà connue. Renvoie le nombre de pistes complétées.
 */
export async function backfillAddedAt(db: Db, statFn: AddedAtStatFn): Promise<number> {
  const rows = db.prepare("SELECT id, path FROM tracks WHERE added_at_ms IS NULL").all() as {
    id: number;
    path: string;
  }[];
  if (rows.length === 0) return 0;

  const found: { id: number; at: number }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const row = rows[next++]!;
      try {
        const at = addedAtFromStat(await statFn(row.path));
        if (at !== null) found.push({ id: row.id, at });
      } catch {
        // Fichier absent / inaccessible : la date reste inconnue.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, rows.length) }, worker));
  if (found.length === 0) return 0;

  // `IS NULL` dans l'UPDATE : une indexation concurrente qui aurait posé la date entre-temps gagne.
  const update = db.prepare("UPDATE tracks SET added_at_ms = ? WHERE id = ? AND added_at_ms IS NULL");
  let changed = 0;
  db.transaction(() => {
    for (const f of found) changed += update.run(f.at, f.id).changes;
  })();
  return changed;
}
