import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db";
import { setState } from "./repository";

/**
 * Base de bibliotheque « crash-safe » (process Main).
 *
 *  - Ouverture verifiee : `openDb` puis `PRAGMA quick_check`. Une base corrompue (SQLITE_CORRUPT /
 *    SQLITE_NOTADB a l'ouverture, ou quick_check != ok) declenche la RECUPERATION automatique :
 *      1. les fichiers fautifs (`benten.db`, `-wal`, `-shm`) sont DEPLACES (jamais supprimes) dans
 *         `userData/db-corrupted-<YYYYMMDD-HHmmss>/` ;
 *      2. la sauvegarde la plus recente qui passe quick_check est restauree ; a defaut, base neuve ;
 *      3. `app_state.dbRecovered` = horodatage ISO (drapeau one-shot pour le Renderer) et une entree
 *         `process`/`db` est ecrite dans le journal ;
 *      4. l'app demarre normalement (la veille de dossiers re-indexe les pistes manquantes).
 *  - Sauvegardes tournantes : une par lancement, a chaud (`db.backup()`), dans
 *    `userData/db-backups/benten-<YYYYMMDD-HHmmss>.db` ; les 3 plus recentes sont gardees, seuls les
 *    fichiers au motif EXACT de ce dossier sont elagues.
 *  - Fermeture ordonnee : `db.close()` sur `will-quit` (checkpoint WAL final propre).
 */

export const DB_FILE = "benten.db";
export const BACKUP_DIR = "db-backups";
export const BACKUP_KEEP = 3;
const BACKUP_RE = /^benten-\d{8}-\d{6}\.db$/;
const DB_SIDE_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`] as const;

/** Horodatage local `YYYYMMDD-HHmmss` (noms de dossiers / fichiers, tri lexical = chronologique). */
export function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Vrai si l'erreur SQLite signale une base corrompue / qui n'est pas une base. */
export function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_(CORRUPT|NOTADB)/.test(code)) return true;
  const msg = err instanceof Error ? err.message : "";
  return /malformed|not a database/i.test(msg);
}

/** `PRAGMA quick_check` == "ok" (toute exception = non). */
export function quickCheckOk(db: Database.Database): boolean {
  try {
    return db.pragma("quick_check", { simple: true }) === "ok";
  } catch {
    return false;
  }
}

/** Erreur interne : la base s'ouvre mais quick_check echoue. */
class QuickCheckFailed extends Error {
  constructor() {
    super("quick_check failed");
  }
}

/** Entree du journal audio (genre `process`, evenement `db`). */
export type DbJournalEntry = { kind: "process"; event: "db"; [detail: string]: unknown };

export interface DbRecovery {
  /** Horodatage ISO de la recuperation (aussi ecrit dans `app_state.dbRecovered`). */
  at: string;
  /** Raison (message de l'erreur d'ouverture ou "quick_check failed"). */
  reason: string;
  /** Dossier ou les fichiers fautifs ont ete deplaces. */
  corruptedDir: string;
  /** Sauvegarde restauree, ou `null` (base neuve). */
  restoredFrom: string | null;
}

export interface OpenDbSafeOptions {
  now?: () => Date;
  log?: (entry: DbJournalEntry) => unknown;
}

/** Ouvre la base et verifie quick_check ; leve `QuickCheckFailed` si la base est incoherente. */
function openChecked(path: string): Database.Database {
  const db = openDb(path);
  if (!quickCheckOk(db)) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new QuickCheckFailed();
  }
  return db;
}

/** Plafond de l'instantane memoire pris apres un arret non propre (au-dela : pas d'instantane). */
const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Si un `-wal` ou un `-shm` subsiste (arret non propre : la fermeture ordonnee les supprime),
 * lit en memoire `benten.db` + `-wal` + `-shm` tels quels. Sinon (cas nominal) : `null`, aucun cout.
 */
function snapshotIfUnclean(userData: string): Map<string, Buffer> | null {
  const present = DB_SIDE_FILES.filter((n) => existsSync(join(userData, n)));
  if (!present.some((n) => n !== DB_FILE)) return null;
  try {
    let total = 0;
    for (const n of present) total += statSync(join(userData, n)).size;
    if (total > SNAPSHOT_MAX_BYTES) return null;
    const out = new Map<string, Buffer>();
    for (const n of present) out.set(n, readFileSync(join(userData, n)));
    return out;
  } catch {
    return null;
  }
}

/** Sauvegardes au motif exact, de la plus recente a la plus ancienne. */
function listBackups(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_RE.test(n))
    .sort()
    .reverse()
    .map((n) => join(dir, n));
}

/** Vrai si `file` s'ouvre en lecture seule et passe quick_check. */
function backupIsSound(file: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return quickCheckOk(db);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Ouvre `userData/benten.db` avec recuperation automatique (voir l'en-tete du module). Une erreur
 * qui n'est PAS une corruption (droits, disque plein...) est relancee telle quelle : on ne deplace
 * jamais une base saine.
 */
export function openDbSafe(
  userData: string,
  opts: OpenDbSafeOptions = {},
): { db: Database.Database; recovered: DbRecovery | null } {
  const now = opts.now ?? ((): Date => new Date());
  const path = join(userData, DB_FILE);
  // Arret non propre (un -wal/-shm subsiste) : SQLite peut, en ouvrant puis en fermant une base
  // fautive, rejouer ou EFFACER ces fichiers. On fige donc les originaux en memoire AVANT la
  // tentative, pour pouvoir les conserver intacts si la recuperation s'avere necessaire.
  const originals = snapshotIfUnclean(userData);
  let reason: string;
  try {
    return { db: openChecked(path), recovered: null };
  } catch (err) {
    if (!(err instanceof QuickCheckFailed) && !isCorruptionError(err)) throw err;
    reason = err instanceof Error ? err.message : String(err);
  }

  // 1) Mise a l'ecart des fichiers fautifs (deplaces, jamais supprimes).
  const date = now();
  let corruptedDir = join(userData, `db-corrupted-${stamp(date)}`);
  for (let i = 2; existsSync(corruptedDir); i++) {
    corruptedDir = join(userData, `db-corrupted-${stamp(date)}-${i}`);
  }
  mkdirSync(corruptedDir, { recursive: true });
  for (const name of DB_SIDE_FILES) {
    const src = join(userData, name);
    // Si l'original a ete fige, l'etat laisse par la tentative d'ouverture est garde A COTE.
    const destName = originals?.has(name) ? `after-open-${name}` : name;
    if (existsSync(src)) renameSync(src, join(corruptedDir, destName));
  }
  if (originals) {
    for (const [name, bytes] of originals) writeFileSync(join(corruptedDir, name), bytes);
  }

  // 2) Restauration de la sauvegarde saine la plus recente ; sinon base neuve.
  let restoredFrom: string | null = null;
  let db: Database.Database | null = null;
  for (const backup of listBackups(join(userData, BACKUP_DIR))) {
    if (!backupIsSound(backup)) continue;
    try {
      copyFileSync(backup, path);
      db = openChecked(path);
      restoredFrom = backup;
      break;
    } catch {
      // La copie restauree ne s'ouvre pas : elle rejoint le dossier fautif, on essaie la suivante.
      for (const name of DB_SIDE_FILES) {
        const src = join(userData, name);
        if (existsSync(src)) {
          try {
            renameSync(src, join(corruptedDir, `restore-failed-${name}`));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  if (!db) db = openDb(path); // base neuve, migree

  // 3) Drapeau one-shot pour le Renderer + journal.
  const at = date.toISOString();
  try {
    setState(db, "dbRecovered", at);
  } catch {
    /* best-effort */
  }
  const recovered: DbRecovery = { at, reason, corruptedDir, restoredFrom };
  try {
    const r = opts.log?.({ kind: "process", event: "db", action: "recovered", ...recovered });
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch {
    /* best-effort */
  }
  return { db, recovered };
}

/**
 * Sauvegarde a chaud de la base (`db.backup()`, asynchrone) vers
 * `userData/db-backups/benten-<YYYYMMDD-HHmmss>.db`, uniquement si quick_check == ok, puis elague :
 * seules les `keep` plus recentes au motif EXACT sont gardees (les autres fichiers du dossier ne sont
 * jamais touches). Renvoie le chemin ecrit, ou `null` (base douteuse / erreur). Ne rejette jamais.
 */
export async function backupDb(
  db: Database.Database,
  userData: string,
  opts: { now?: () => Date; keep?: number } = {},
): Promise<string | null> {
  const now = opts.now ?? ((): Date => new Date());
  const keep = opts.keep ?? BACKUP_KEEP;
  try {
    if (!quickCheckOk(db)) return null;
    const dir = join(userData, BACKUP_DIR);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, `benten-${stamp(now())}.db`);
    await db.backup(dest);
    const names = (await readdir(dir)).filter((n) => BACKUP_RE.test(n)).sort().reverse();
    for (const old of names.slice(keep)) {
      await rm(join(dir, old), { force: true });
    }
    return dest;
  } catch {
    return null;
  }
}

/** Emetteur minimal (`app`). */
export interface QuitEmitter {
  // `any[]` : meme signature qu'`EventEmitter.on`.
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Ferme la base UNE fois, sur `will-quit` (apres la fermeture des fenetres : plus aucune requete
 * IPC ne peut arriver), pour que le checkpoint WAL final se fasse proprement. Jamais de levee.
 */
export function wireDbClose(app: QuitEmitter, db: { close(): unknown }): void {
  let closed = false;
  app.on("will-quit", () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      /* deja fermee / occupee : rien a faire de plus a la sortie */
    }
  });
}
