import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DIAG_MAX_BATCH,
  DIAG_MAX_ENTRY_BYTES,
  RENDERER_DIAG_KINDS,
  type DiagEntry,
  type MainDiagKind,
} from "../shared/diagnostics";

/**
 * Journal audio cote Main : validation du payload Renderer, ecriture JSON-lines avec rotation, et
 * evenements processus (service audio, renderer, fenetre, alimentation).
 *
 * Fichiers : `<dossier>/audio-journal.log` et, apres rotation, `<dossier>/audio-journal.1.log`
 * (un seul ancien conserve). Le dossier est fixe par le Main (`userData/logs`) : AUCUN chemin ne
 * vient du Renderer. Aucun autre fichier n'est cree ; les fichiers musicaux ne sont pas touches.
 */

export const JOURNAL_FILE = "audio-journal.log";
export const JOURNAL_OLD_FILE = "audio-journal.1.log";
/** Plafond du fichier courant avant rotation (1 Mo). */
export const JOURNAL_MAX_BYTES = 1024 * 1024;

const RENDERER_KINDS: ReadonlySet<string> = new Set(RENDERER_DIAG_KINDS);
const CH = "diagnostics:append";

/**
 * Validation STRICTE de `diagnostics:append` : tableau de ≤ 200 entrees ; chaque entree est un
 * objet simple (ni tableau ni null), horodate (`t` chaine), dont `kind` appartient aux genres
 * Renderer connus, serialisable JSON en ≤ 2 Ko. Toute violation rejette le lot ENTIER.
 */
export function validateDiagEntries(payload: unknown): DiagEntry[] {
  if (!Array.isArray(payload)) throw new Error(`${CH}: entries must be an array`);
  if (payload.length > DIAG_MAX_BATCH) {
    throw new Error(`${CH}: at most ${DIAG_MAX_BATCH} entries per call`);
  }
  for (const e of payload) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      throw new Error(`${CH}: each entry must be an object`);
    }
    const rec = e as Record<string, unknown>;
    if (typeof rec["t"] !== "string" || rec["t"].length > 64) {
      throw new Error(`${CH}: entry.t must be a timestamp string`);
    }
    if (typeof rec["kind"] !== "string" || !RENDERER_KINDS.has(rec["kind"])) {
      throw new Error(`${CH}: unknown entry kind`);
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(e);
    } catch {
      throw new Error(`${CH}: entry is not serializable`);
    }
    if (typeof json !== "string") throw new Error(`${CH}: entry is not serializable`);
    if (Buffer.byteLength(json, "utf8") > DIAG_MAX_ENTRY_BYTES) {
      throw new Error(`${CH}: entry larger than ${DIAG_MAX_ENTRY_BYTES} bytes`);
    }
  }
  return payload as DiagEntry[];
}

/** Entree ecrite par le Main lui-meme (`t` ajoute a l'ecriture). */
export interface MainDiagEntry {
  kind: MainDiagKind;
  [detail: string]: unknown;
}

export interface JournalWriter {
  /** Ajoute des entrees (deja validees). Ne rejette jamais. */
  append(entries: readonly DiagEntry[]): Promise<void>;
  /** Ajoute une entree du Main, horodatee maintenant. Ne rejette jamais. */
  log(entry: MainDiagEntry): Promise<void>;
  /**
   * Ajoute une entree du Main de facon SYNCHRONE (durable avant le retour), pour les evenements
   * suivis d'une sortie immediate (`app.exit(1)`). Hors chaine asynchrone : une ecriture `log()`
   * encore en vol peut atterrir apres (l'horodatage `t` fait foi). Ne leve jamais.
   */
  logSync(entry: MainDiagEntry): void;
  /** Chemin du fichier courant. */
  readonly file: string;
}

/**
 * Ecrivain du journal. Les ecritures sont SERIALISEES (chaine de promesses) : l'ordre des lignes
 * est celui des appels et la rotation ne court jamais contre un ajout. Rotation avant ecriture : si
 * le fichier courant (non vide) depasserait `maxBytes` avec le nouveau lot, il est renomme en
 * `audio-journal.1.log` (l'ancien est remplace). Toute erreur d'E/S est avalee (best-effort : le
 * journal ne doit jamais casser l'app).
 */
export function createJournalWriter(
  dir: string,
  opts: { maxBytes?: number } = {},
): JournalWriter {
  const maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES;
  const file = join(dir, JOURNAL_FILE);
  const oldFile = join(dir, JOURNAL_OLD_FILE);
  let chain: Promise<void> = Promise.resolve();

  const write = async (lines: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0; // pas encore de fichier
    }
    if (size > 0 && size + Buffer.byteLength(lines, "utf8") > maxBytes) {
      await rm(oldFile, { force: true });
      await rename(file, oldFile);
    }
    await appendFile(file, lines, "utf8");
  };

  const enqueue = (entries: readonly object[]): Promise<void> => {
    if (entries.length === 0) return chain;
    let lines = "";
    try {
      for (const e of entries) lines += JSON.stringify(e) + "\n";
    } catch {
      return chain;
    }
    chain = chain.then(
      () => write(lines).catch(() => undefined),
      () => undefined,
    );
    return chain;
  };

  return {
    file,
    append: (entries) => enqueue(entries),
    log: (entry) => enqueue([{ t: new Date().toISOString(), ...entry }]),
    logSync: (entry) => {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n", "utf8");
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Emetteur minimal (`app`, `powerMonitor`, `BrowserWindow`) — injectable pour les tests. */
export interface EmitterLike {
  // `any[]` : meme signature qu'`EventEmitter.on` (app, powerMonitor, BrowserWindow, tests).
  on(event: string, listener: (...args: any[]) => void): unknown;
}

type LogFn = (entry: MainDiagEntry) => unknown;

/** Appelle `log` sans jamais laisser fuir une exception vers l'emetteur. */
const safeLog =
  (log: LogFn) =>
  (entry: MainDiagEntry): void => {
    try {
      const r = log(entry);
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).then(undefined, () => undefined);
      }
    } catch {
      /* best-effort */
    }
  };

/**
 * Evenements processus journalises par le Main : `child-process-gone` (le service audio de
 * Chromium est un processus utilitaire : `serviceName` le designe), `render-process-gone`, et
 * `powerMonitor` `suspend`/`resume`.
 */
export function attachMainJournal(deps: {
  app: EmitterLike;
  powerMonitor: EmitterLike;
  log: LogFn;
}): void {
  const log = safeLog(deps.log);
  deps.app.on("child-process-gone", (_e: unknown, d: Record<string, unknown> = {}) => {
    log({
      kind: "process",
      event: "child-process-gone",
      type: d["type"] ?? null,
      serviceName: d["serviceName"] ?? null,
      name: d["name"] ?? null,
      reason: d["reason"] ?? null,
      exitCode: d["exitCode"] ?? null,
    });
  });
  deps.app.on("render-process-gone", (_e: unknown, _wc: unknown, d: Record<string, unknown> = {}) => {
    log({
      kind: "process",
      event: "render-process-gone",
      reason: d["reason"] ?? null,
      exitCode: d["exitCode"] ?? null,
    });
  });
  deps.powerMonitor.on("suspend", () => log({ kind: "power", event: "suspend" }));
  deps.powerMonitor.on("resume", () => log({ kind: "power", event: "resume" }));
}

/** Fenetre : `unresponsive` / `responsive` (thread principal du renderer bloque). */
export function watchWindowJournal(win: EmitterLike, logFn: LogFn): void {
  const log = safeLog(logFn);
  win.on("unresponsive", () => log({ kind: "process", event: "window-unresponsive" }));
  win.on("responsive", () => log({ kind: "process", event: "window-responsive" }));
}
