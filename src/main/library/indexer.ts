import { promises as fs } from "node:fs";
import type Database from "better-sqlite3";
import type { ScanSummary, TrackInput } from "../../shared/types";
import { getOrCreateArt } from "./artcache";
import { readMetadata as defaultReadMetadata } from "./metadata";
import { getTrackStat, upsertTracks } from "./repository";
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
  /** Extraction/cache de pochette (injectable pour les tests) ; defaut : `getOrCreateArt`. */
  getArt?: (path: string) => Promise<string | null>;
  /** Stat du fichier (injectable pour les tests) ; defaut : `fs.promises.stat`. */
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  concurrency?: number;
  batchSize?: number;
}

type ReadFn = (path: string) => Promise<TrackInput>;
type ArtFn = (path: string) => Promise<string | null>;
type StatFn = (path: string) => Promise<{ mtimeMs: number; size: number }>;

/** Resout les options injectables une seule fois (lecture metadonnees / pochette / stat). */
function resolveDeps(options: IndexOptions): { read: ReadFn; getArt: ArtFn; stat: StatFn } {
  return {
    read: options.readMetadata ?? defaultReadMetadata,
    getArt: options.getArt ?? ((path: string) => getOrCreateArt({ path })),
    stat: options.stat ?? ((path: string) => fs.stat(path)),
  };
}

type Resolved =
  | { status: "ok"; track: TrackInput }
  | { status: "unreadable" }
  | { status: "unplayable" };

/**
 * Prepare une piste pour l'upsert : lecture des metadonnees, puis stat + saut de pochette
 * (reutilisation de `art_key` si `mtime`/`size` inchanges, sinon (re)extraction). Partage par
 * `indexLibrary` (chemin par lot) et `indexOne` (chemin unitaire de la veille) afin que la meme
 * logique de pochette/mtime s'applique partout.
 *
 * - `unreadable` : la lecture de metadonnees a leve (fichier tronque/illisible).
 * - `unplayable` : lu mais non lisible (`.m4p`, flux absent...).
 * - `ok` : `track` prete, `artKey`/`mtimeMs`/`sizeBytes` renseignes.
 */
async function resolveTrack(
  db: Db,
  path: string,
  read: ReadFn,
  getArt: ArtFn,
  stat: StatFn,
): Promise<Resolved> {
  let track: TrackInput;
  try {
    track = await read(path);
  } catch {
    return { status: "unreadable" };
  }
  if (!track.playable) return { status: "unplayable" };
  // Stat du fichier pour l'indexation incrementale. mtimeMs est arrondi : la colonne est INTEGER
  // et la comparaison de saut doit porter sur la meme valeur.
  let mtimeMs: number | null = null;
  let sizeBytes: number | null = null;
  try {
    const st = await stat(track.path);
    mtimeMs = Math.round(st.mtimeMs);
    sizeBytes = st.size;
  } catch {
    // Stat indisponible : on laisse null (la pochette sera (re)lue).
  }
  // Saut de pochette : si la piste existe deja avec un art_key et un mtime/size identiques, on
  // reutilise la cle sans rappeler getArt (fix pochette).
  const prev = getTrackStat(db, track.path);
  let artKey: string | null;
  if (
    prev !== undefined &&
    prev.artKey !== null &&
    mtimeMs !== null &&
    prev.mtimeMs === mtimeMs &&
    prev.sizeBytes === sizeBytes
  ) {
    artKey = prev.artKey;
  } else {
    // Une pochette manquante ou en erreur n'empeche jamais d'indexer la piste.
    try {
      artKey = await getArt(track.path);
    } catch {
      artKey = null;
    }
  }
  return { status: "ok", track: { ...track, artKey, mtimeMs, sizeBytes } };
}

/**
 * Indexe (ou met a jour) UN SEUL fichier et renvoie `true` s'il a ete upserte, `false` s'il etait
 * illisible ou non lisible. Reutilise exactement la logique metadonnees + pochette/mtime +
 * `upsertTracks` d'`indexLibrary` ; c'est le point d'entree unitaire de la veille (Task 14B).
 * Ne leve pas sur un fichier illisible (renvoie `false`) ; une erreur d'ecriture en base remonte.
 */
export async function indexOne(db: Db, path: string, options: IndexOptions = {}): Promise<boolean> {
  const { read, getArt, stat } = resolveDeps(options);
  const resolved = await resolveTrack(db, path, read, getArt, stat);
  if (resolved.status !== "ok") return false;
  upsertTracks(db, [resolved.track]);
  return true;
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
 * - `artKey` est renseigne via `getArt` (pochette en cache) ; `null` sans pochette ou en cas d'erreur.
 * - `onProgress` est appele apres chaque lot ecrit et une derniere fois a la fin.
 */
export async function indexLibrary(
  db: Db,
  roots: readonly string[],
  onProgress?: IndexProgressHandler,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const { read, getArt, stat } = resolveDeps(options);
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
        const resolved = await resolveTrack(db, next.value, read, getArt, stat);
        if (resolved.status === "unreadable") {
          // Seul l'echec de LECTURE d'un fichier est tolere (compte skipped + errors).
          stats.skipped++;
          stats.errors++;
          continue;
        }
        if (resolved.status === "unplayable") {
          stats.skipped++;
          continue;
        }
        buffer.push(resolved.track);
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
