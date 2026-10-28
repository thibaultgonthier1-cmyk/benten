import type Database from "better-sqlite3";
import type { ScanSummary, TrackInput } from "../../shared/types";
import { readMetadata as defaultReadMetadata } from "./metadata";
import { upsertTracks } from "./repository";
import { AUDIO_EXTENSIONS, scanAudioFiles } from "./scanner";

type Db = Database.Database;

/** Nombre maximal de lectures de metadonnees simultanees. */
const DEFAULT_CONCURRENCY = 8;
/** Pistes ecrites par transaction SQLite. */
const DEFAULT_BATCH_SIZE = 64;

/**
 * Extensions parcourues : l'audio connu + `.m4p` (protege par DRM). Ce dernier n'est
 * jamais lisible mais doit etre vu par l'indexeur pour etre compte dans `skipped`.
 */
const INDEXED_EXTENSIONS: ReadonlySet<string> = new Set([...AUDIO_EXTENSIONS, ".m4p"]);

export interface IndexResult {
  added: number;
  skipped: number;
}

export type IndexProgressHandler = (progress: ScanSummary) => void;

export interface IndexOptions {
  /** Lecteur de metadonnees (injectable pour les tests). */
  readMetadata?: (path: string) => Promise<TrackInput>;
  concurrency?: number;
  batchSize?: number;
}

/** Chaque racine parcourue, sans doublon de chemin entre racines qui se chevauchent. */
async function* scanRoots(roots: readonly string[]): AsyncGenerator<string> {
  const seen = new Set<string>();
  for (const root of roots) {
    for await (const file of scanAudioFiles(root, undefined, INDEXED_EXTENSIONS)) {
      if (seen.has(file)) continue;
      seen.add(file);
      yield file;
    }
  }
}

/**
 * Indexe les bibliotheques `roots` dans `db` sans bloquer la boucle d'evenements :
 * les metadonnees sont lues par un pool de `concurrency` workers et les pistes sont
 * ecrites par lots (une transaction par lot, entre deux `await`).
 *
 * - `added` : pistes lisibles absentes de la base avant ce passage (donc 0 au 2e passage).
 * - `skipped` : fichiers non lisibles (.m4p, tronques, illisibles) ou dont la lecture a
 *   echoue ; ils ne sont pas inseres. Un echec de lecture n'interrompt jamais le passage.
 * - Une erreur d'ecriture en base fait rejeter `indexLibrary` (jamais avalee, `added` non gonfle).
 * - `onProgress` est appele apres chaque lot ecrit et une derniere fois a la fin.
 */
export async function indexLibrary(
  db: Db,
  roots: readonly string[],
  onProgress?: IndexProgressHandler,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const read = options.readMetadata ?? defaultReadMetadata;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));

  const exists = db.prepare("SELECT 1 FROM tracks WHERE path = ?").pluck();
  const stats: ScanSummary = { scanned: 0, added: 0, skipped: 0, errors: 0 };
  let buffer: TrackInput[] = [];

  const emit = (): void => onProgress?.({ ...stats });

  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    // Les chemins sont uniques (dedoublonnes par scanRoots) : le comptage est exact.
    let fresh = 0;
    for (const t of batch) if (exists.get(t.path) === undefined) fresh++;
    // Une erreur d'ecriture (disque plein, SQLITE_BUSY...) remonte : jamais avalee,
    // et `added` n'est incremente qu'apres un upsert reussi.
    upsertTracks(db, batch);
    stats.added += fresh;
    emit();
  };

  const files = scanRoots(roots);

  let failed = false;
  const worker = async (): Promise<void> => {
    try {
      while (!failed) {
        const next = await files.next();
        if (next.done) return;
        stats.scanned++;
        let track: TrackInput | undefined;
        try {
          track = await read(next.value);
        } catch {
          // Seul l'echec de LECTURE d'un fichier est tolere (compte skipped + errors).
          stats.skipped++;
          stats.errors++;
          continue;
        }
        if (!track.playable) {
          stats.skipped++;
          continue;
        }
        buffer.push(track);
        if (buffer.length >= batchSize) flush();
      }
    } catch (err) {
      failed = true; // arrete les autres workers ; Promise.all rejette avec cette erreur
      throw err;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  flush();
  emit();
  return { added: stats.added, skipped: stats.skipped };
}
