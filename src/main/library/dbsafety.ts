import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db";
import { setState } from "./repository";

/**
 * Base de bibliotheque « crash-safe » (process Main).
 *
 *  - Copie PRE-OUVERTURE : apres un arret non propre (un `-wal`/`-shm` subsiste), les 3 fichiers sont
 *    COPIES sur disque dans `userData/db-preopen-<ts>/` AVANT la premiere ouverture (SQLite peut
 *    rejouer ou effacer le WAL en ouvrant). Cette copie n'est supprimee qu'une fois quick_check passe.
 *  - Ouverture verifiee : `openDb` puis `PRAGMA quick_check`. La RECUPERATION n'est declenchee QUE par
 *    une corruption averee : erreur SQLITE_CORRUPT* / SQLITE_NOTADB*, ou quick_check qui RENVOIE autre
 *    chose que "ok". Toute autre erreur (BUSY, IOERR — antivirus —, NOMEM, CANTOPEN...) est relancee :
 *    une base saine n'est jamais mise a l'ecart.
 *  - Recuperation : `userData/db-corrupted-<ts>/` recoit une COPIE verifiee (tailles) de chaque fichier
 *    present ; les originaux ne sont retires qu'ensuite (sinon : abandon, originaux intacts, l'appelant
 *    affiche l'erreur). Puis restauration de la sauvegarde la plus recente jugee saine, sinon base
 *    neuve ; `app_state.dbRecovered` = ISO (drapeau one-shot Renderer) ; entree `process`/`db` au
 *    journal ; l'app demarre normalement (la veille de dossiers re-indexe).
 *  - Sauvegardes : au plus une par 20 h (`db.backup()` a chaud) dans
 *    `userData/db-backups/benten-<YYYYMMDD-HHmmss>.db` ; retention = les 3 plus recentes + la plus
 *    recente de chacun des 7 derniers jours ; seuls les fichiers au motif EXACT (et leurs orphelins
 *    `-wal`/`-shm`) sont supprimes.
 *  - Fermeture ordonnee : `db.close()` sur `will-quit` et `session-end` (fermeture de session Windows).
 */

export const DB_FILE = "benten.db";
export const BACKUP_DIR = "db-backups";
export const BACKUP_KEEP_RECENT = 3;
export const BACKUP_DAILY_DAYS = 7;
/** Intervalle minimal entre deux sauvegardes de lancement. */
export const BACKUP_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const BACKUP_RE = /^benten-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
const BACKUP_ORPHAN_RE = /^benten-\d{8}-\d{6}\.db-(wal|shm)$/;
const DB_SIDE_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`] as const;
/**
 * Ordre de RETRAIT des originaux : `-wal` et `-shm` AVANT `benten.db`. Si un retrait echoue en
 * route, il ne peut jamais rester un WAL perime qu'une base neuve/restauree rejouerait.
 */
const REMOVAL_ORDER = [`${DB_FILE}-wal`, `${DB_FILE}-shm`, DB_FILE] as const;
/** Marqueur d'une copie pre-ouverture INACHEVEE (retire une fois la copie verifiee). */
const PREOPEN_MARKER = "INCOMPLETE";
const PREOPEN_DIR_RE = /^db-preopen-\d{8}-\d{6}(-\d+)?$/;

/** Horodatage local `YYYYMMDD-HHmmss` (tri lexical = chronologique). */
export function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Date locale d'une sauvegarde d'apres son nom (motif exact), sinon `null`. */
export function parseBackupDate(name: string): Date | null {
  const m = BACKUP_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return new Date(y!, mo! - 1, d!, h!, mi!, s!);
}

/**
 * Vrai si l'erreur signale une base CORROMPUE : code SQLITE_CORRUPT* / SQLITE_NOTADB*. Sans code
 * (erreur non SQLite), repli sur le message ("malformed" / "not a database").
 */
export function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return /^SQLITE_(CORRUPT|NOTADB)/.test(code);
  const msg = err instanceof Error ? err.message : "";
  return /malformed|not a database/i.test(msg);
}

/** La base s'ouvre mais quick_check renvoie autre chose que "ok". */
class CorruptionDetected extends Error {}

const safeClose = (db: { close(): unknown } | null | undefined): void => {
  try {
    db?.close();
  } catch {
    /* deja fermee */
  }
};

/**
 * `PRAGMA quick_check` : `true` si "ok", `false` si un resultat non "ok" OU une erreur de
 * corruption ; toute AUTRE erreur (BUSY, IOERR...) est relancee.
 */
function quickCheck(db: Database.Database): boolean {
  let result: unknown;
  try {
    result = db.pragma("quick_check", { simple: true });
  } catch (err) {
    if (isCorruptionError(err)) return false;
    throw err;
  }
  return result === "ok";
}

/** quick_check sans jamais lever (sauvegardes) : toute erreur = non saine. */
export function quickCheckOk(db: Database.Database): boolean {
  try {
    return quickCheck(db);
  } catch {
    return false;
  }
}

/** Ouvre et verifie ; leve `CorruptionDetected` si quick_check n'est pas "ok". */
function openChecked(path: string, openDbFn: (p: string) => Database.Database): Database.Database {
  const db = openDbFn(path);
  let ok: boolean;
  try {
    ok = quickCheck(db);
  } catch (err) {
    safeClose(db);
    throw err;
  }
  if (!ok) {
    safeClose(db);
    throw new CorruptionDetected("quick_check failed");
  }
  return db;
}

const isRecoverable = (err: unknown): boolean =>
  err instanceof CorruptionDetected || isCorruptionError(err);

/** `userData/<prefix>-<ts>` libre (suffixe -2, -3... si deja pris). */
function uniqueDir(userData: string, prefix: string, date: Date): string {
  const base = join(userData, `${prefix}-${stamp(date)}`);
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  return dir;
}

type CopyFile = (src: string, dest: string) => void;

/** Copie VERIFIEE (tailles) des fichiers de base presents vers `toDir` (cree). Leve si un pas echoue. */
function copyVerified(from: string, toDir: string, copyFile: CopyFile): string[] {
  mkdirSync(toDir, { recursive: true });
  const copied: string[] = [];
  for (const name of DB_SIDE_FILES) {
    const src = join(from, name);
    if (!existsSync(src)) continue;
    const dest = join(toDir, name);
    copyFile(src, dest);
    if (statSync(src).size !== statSync(dest).size) {
      throw new Error(`copy size mismatch: ${name}`);
    }
    copied.push(name);
  }
  return copied;
}

/** Sauvegardes au motif exact, de la plus recente a la plus ancienne (chemins complets). */
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

/**
 * Vrai si la sauvegarde est exploitable : quick_check "ok", `user_version >= 1` et table `tracks`
 * presente (un fichier vide ou une souche est rejete). La verification se fait sur une COPIE dans un
 * dossier temporaire, supprime ensuite : aucun `-wal`/`-shm` orphelin n'apparait dans db-backups.
 */
function backupIsSound(file: string): boolean {
  let tmp: string | null = null;
  let db: Database.Database | null = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "benten-bkchk-"));
    const copy = join(tmp, "check.db");
    copyFileSync(file, copy);
    db = new Database(copy, { readonly: true, fileMustExist: true });
    if (!quickCheckOk(db)) return false;
    if ((db.pragma("user_version", { simple: true }) as number) < 1) return false;
    const hasTracks = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tracks'")
      .get();
    return hasTracks !== undefined;
  } catch {
    return false;
  } finally {
    safeClose(db);
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true }); // notre propre copie temporaire
      } catch {
        /* ignore */
      }
    }
  }
}

/** Entree du journal audio (genre `process`, evenement `db`). */
export type DbJournalEntry = { kind: "process"; event: "db"; [detail: string]: unknown };

export interface DbRecovery {
  /** Horodatage ISO de la recuperation (aussi dans `app_state.dbRecovered`). */
  at: string;
  /** Raison (message de l'erreur de corruption ou "quick_check failed"). */
  reason: string;
  /** Dossier recevant la copie verifiee des fichiers fautifs. */
  corruptedDir: string;
  /** Copie pre-ouverture conservee (arret non propre), ou `null`. */
  preopenDir: string | null;
  /** Sauvegarde restauree, ou `null` (base neuve). */
  restoredFrom: string | null;
}

export interface OpenDbSafeOptions {
  now?: () => Date;
  log?: (entry: DbJournalEntry) => unknown;
  /** Injection (tests) : ouverture de la base. Defaut `openDb`. */
  openDbFn?: (path: string) => Database.Database;
  /** Injection (tests) : copie de fichier. Defaut `copyFileSync`. */
  copyFile?: CopyFile;
  /** Injection (tests) : retrait d'un original apres sa copie verifiee. Defaut `rmSync`. */
  removeFile?: (path: string) => void;
}

/**
 * Supprime les copies pre-ouverture INACHEVEES (motif exact `db-preopen-<ts>` + marqueur
 * `INCOMPLETE`) laissees par un echec de copie. Les copies COMPLETES (conservees par une
 * recuperation : pieces a conviction) et tout dossier hors motif ne sont jamais touches.
 */
function cleanupPartialPreopens(userData: string): void {
  let names: string[];
  try {
    names = readdirSync(userData);
  } catch {
    return;
  }
  for (const name of names) {
    if (!PREOPEN_DIR_RE.test(name)) continue;
    const dir = join(userData, name);
    if (!existsSync(join(dir, PREOPEN_MARKER))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const safeLog = (log: OpenDbSafeOptions["log"], entry: DbJournalEntry): void => {
  try {
    const r = log?.(entry);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch {
    /* best-effort */
  }
};

/**
 * Ouvre `userData/benten.db` avec copie pre-ouverture et recuperation automatique (voir l'en-tete).
 * Leve si la base est inutilisable pour une raison qui n'est PAS une corruption, ou si la mise a
 * l'ecart echoue (originaux alors laisses intacts) : l'appelant affiche l'erreur et quitte.
 */
export function openDbSafe(
  userData: string,
  opts: OpenDbSafeOptions = {},
): { db: Database.Database; recovered: DbRecovery | null } {
  const date = (opts.now ?? ((): Date => new Date()))();
  const openDbFn = opts.openDbFn ?? openDb;
  const copyFile = opts.copyFile ?? copyFileSync;
  const removeFile = opts.removeFile ?? ((p: string): void => rmSync(p));
  const path = join(userData, DB_FILE);

  // 1) Arret non propre : copie pre-ouverture sur disque, AVANT toute ouverture. Le marqueur
  //    `INCOMPLETE` est pose d'abord et retire une fois la copie verifiee.
  let preopenDir: string | null = null;
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    const dir = uniqueDir(userData, "db-preopen", date);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PREOPEN_MARKER), "");
      copyVerified(userData, dir, copyFile);
      rmSync(join(dir, PREOPEN_MARKER));
      preopenDir = dir;
    } catch (err) {
      // Copie impossible (disque plein...) : la copie partielle reste marquee INCOMPLETE (nettoyee au
      // prochain demarrage reussi) ; on ouvre quand meme (la reprise WAL de SQLite est le cas
      // nominal apres un crash) et on le consigne.
      safeLog(opts.log, {
        kind: "process",
        event: "db",
        action: "preopen-copy-failed",
        dir,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2) Ouverture verifiee. Seule une corruption averee mene a la recuperation.
  let reason: string;
  try {
    const db = openChecked(path, openDbFn);
    if (preopenDir) {
      let preopenCleared = false;
      try {
        rmSync(preopenDir, { recursive: true, force: true }); // quick_check ok : copie inutile
        preopenCleared = true;
      } catch {
        /* ignore */
      }
      // Arret non propre detecte puis surmonte : consigne (correlation avec les incidents).
      safeLog(opts.log, { kind: "process", event: "db", action: "unclean-start", preopenDir, preopenCleared });
    }
    cleanupPartialPreopens(userData); // copies inachevees d'un lancement precedent
    return { db, recovered: null };
  } catch (err) {
    if (!isRecoverable(err)) throw err;
    reason = err instanceof Error ? err.message : String(err);
  }

  // 3) Mise a l'ecart : copie verifiee d'abord, retrait des originaux ensuite seulement.
  const corruptedDir = uniqueDir(userData, "db-corrupted", date);
  copyVerified(userData, corruptedDir, copyFile); // leve -> originaux intacts
  for (const name of REMOVAL_ORDER) {
    const src = join(userData, name);
    if (existsSync(src)) removeFile(src); // leve -> abandon (aucun WAL perime ne subsiste)
  }

  // 4) Restauration de la sauvegarde saine la plus recente ; sinon base neuve.
  let restoredFrom: string | null = null;
  let db: Database.Database | null = null;
  for (const backup of listBackups(join(userData, BACKUP_DIR))) {
    if (!backupIsSound(backup)) continue;
    try {
      copyFile(backup, path);
      db = openChecked(path, openDbFn);
      restoredFrom = backup;
      break;
    } catch {
      // Notre copie restauree ne s'ouvre pas : on la range a cote des fichiers fautifs, puis suivante.
      for (const name of DB_SIDE_FILES) {
        const src = join(userData, name);
        if (!existsSync(src)) continue;
        try {
          renameSync(src, join(corruptedDir, `restore-failed-${name}`));
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!db) db = openDbFn(path); // base neuve, migree

  // 5) Drapeau one-shot pour le Renderer + journal.
  const at = date.toISOString();
  try {
    setState(db, "dbRecovered", at);
  } catch {
    /* best-effort */
  }
  const recovered: DbRecovery = { at, reason, corruptedDir, preopenDir, restoredFrom };
  safeLog(opts.log, { kind: "process", event: "db", action: "recovered", ...recovered });
  return { db, recovered };
}

/**
 * Noms de sauvegardes (motif exact) a SUPPRIMER selon la retention : on garde les
 * `BACKUP_KEEP_RECENT` plus recentes + la plus recente de chacun des `BACKUP_DAILY_DAYS` derniers
 * jours (jours locaux, aujourd'hui compris). Les noms hors motif ne sont jamais renvoyes. PURE.
 */
export function backupsToDelete(names: readonly string[], now: Date): string[] {
  const valid = names
    .map((n) => ({ n, d: parseBackupDate(n) }))
    .filter((x): x is { n: string; d: Date } => x.d !== null)
    .sort((a, b) => (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
  const keep = new Set(valid.slice(0, BACKUP_KEEP_RECENT).map((x) => x.n));
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (BACKUP_DAILY_DAYS - 1));
  const days = new Set<string>();
  for (const x of valid) {
    if (x.d < cutoff) continue;
    const day = x.n.slice("benten-".length, "benten-".length + 8);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(x.n);
  }
  return valid.filter((x) => !keep.has(x.n)).map((x) => x.n);
}

/**
 * Sauvegarde de lancement : elague d'abord les orphelins `-wal`/`-shm` au motif exact ; si la plus
 * recente sauvegarde a moins de 20 h, ne fait rien de plus que la retention ; sinon, si quick_check
 * est "ok", `db.backup()` a chaud vers `benten-<YYYYMMDD-HHmmss>.db`. Applique ensuite la retention.
 * Renvoie le chemin ecrit, ou `null` (sautee / base douteuse / erreur). Ne rejette jamais.
 */
export async function backupDb(
  db: Database.Database,
  userData: string,
  opts: { now?: () => Date } = {},
): Promise<string | null> {
  const date = (opts.now ?? ((): Date => new Date()))();
  try {
    const dir = join(userData, BACKUP_DIR);
    await mkdir(dir, { recursive: true });
    const names = await readdir(dir);
    for (const n of names) {
      if (BACKUP_ORPHAN_RE.test(n)) await rm(join(dir, n), { force: true });
    }
    const newest = names
      .filter((n) => BACKUP_RE.test(n))
      .sort()
      .pop();
    const newestDate = newest ? parseBackupDate(newest) : null;
    // Horloge reculee (plus recente « dans le futur », age < 0) : consideree FRAICHE — sinon on
    // sauvegarderait a chaque lancement jusqu'a ce que l'horloge rattrape.
    const age = newestDate ? date.getTime() - newestDate.getTime() : Infinity;
    let dest: string | null = null;
    if (age >= BACKUP_MIN_INTERVAL_MS && quickCheckOk(db)) {
      dest = join(dir, `benten-${stamp(date)}.db`);
      await db.backup(dest);
    }
    for (const old of backupsToDelete(await readdir(dir), date)) {
      await rm(join(dir, old), { force: true });
      await rm(join(dir, `${old}-wal`), { force: true });
      await rm(join(dir, `${old}-shm`), { force: true });
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
 * Ferme la base UNE fois, sur `will-quit` (apres la fermeture des fenetres : plus aucune requete IPC)
 * ou `session-end` (fermeture de session / arret de Windows, ou `will-quit` peut ne jamais venir),
 * pour un checkpoint WAL final propre. Jamais de levee.
 */
export function wireDbClose(app: QuitEmitter, db: { close(): unknown }): void {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    safeClose(db);
  };
  app.on("will-quit", close);
  app.on("session-end", close);
}
