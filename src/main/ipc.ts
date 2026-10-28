import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../shared/channels";
import type {
  AudioDeviceInfo,
  LibraryQueryArgs,
  LibraryQueryResult,
  LibraryView,
  Page,
  ScanSummary,
  SearchArgs,
  SourceRow,
  TrackRow,
} from "../shared/types";
import { defaultOutputDevice } from "./audio/devices";
import { indexLibrary } from "./library/indexer";
import {
  addSource,
  getAlbums,
  getAllTracks,
  getArtists,
  getSources,
  removeSource,
  searchTracks,
} from "./library/repository";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_SCAN_PATHS = 64;
/** Garde-fou : un fichier audio plus gros que ca est tenu pour aberrant (chemin errone). */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const VIEWS: ReadonlySet<string> = new Set<LibraryView>(["albums", "tracks", "artists"]);

/**
 * Vrai si `url` (celle de la frame appelante) est l'UI de l'application :
 * le serveur de dev (origine exacte) ou le `index.html` empaquete.
 */
export function isTrustedUrl(
  url: string | undefined,
  devServerUrl: string | undefined,
  rendererIndexFileUrl: string,
): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) {
    try {
      if (parsed.origin !== "null" && parsed.origin === new URL(devServerUrl).origin) return true;
    } catch {
      /* URL de dev invalide : on ne s'en sert pas. */
    }
  }
  if (parsed.protocol === "file:") {
    parsed.hash = "";
    parsed.search = "";
    return parsed.href === rendererIndexFileUrl;
  }
  return false;
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  const indexUrl = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  if (!isTrustedUrl(event.senderFrame?.url, process.env["ELECTRON_RENDERER_URL"], indexUrl)) {
    throw new Error("IPC rejected: untrusted sender");
  }
}

/** Valide `paths` : tableau borne de chemins absolus pointant vers des dossiers existants. */
export function validateScanPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_SCAN_PATHS) {
    throw new Error("library:scan: paths must be a non-empty array of directories");
  }
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0 || p.includes("\0") || !isAbsolute(p)) {
      throw new Error("library:scan: each path must be an absolute path string");
    }
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      /* inexistant / inaccessible */
    }
    if (!isDir) throw new Error(`library:scan: not a directory: ${p}`);
    out.push(p);
  }
  return out;
}

/** Valide le chemin d'un fichier audio : chaine absolue, sans octet nul, pointant un fichier existant. */
export function validateAudioPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    throw new Error("audio:read-file: path must be an absolute path string");
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`audio:read-file: not a file: ${path}`);
  }
  if (!st.isFile()) throw new Error(`audio:read-file: not a file: ${path}`);
  if (st.size > MAX_AUDIO_BYTES) throw new Error(`audio:read-file: file too large: ${path}`);
  return path;
}

/**
 * Vrai si `filePath` **résolu** est contenu dans l'une des `roots` **résolues**. Fonction PURE
 * (sécurité) : on résout le realpath du fichier ET de chaque racine (les liens symboliques sont
 * suivis, donc une évasion via lien est bloquée), on normalise les séparateurs via `path.resolve`,
 * puis on compare sur une frontière de préfixe terminée par `path.sep` — ainsi `/library` n'est
 * PAS considéré dans `/lib`. L'égalité exacte fichier == racine compte comme « dedans ».
 *
 * `realpath` est injectable pour les tests ; par défaut `fs.realpathSync`. Toute erreur de
 * résolution (chemin inexistant, lien cassé) => `false` (fail closed).
 */
export function isPathWithinRoots(
  filePath: string,
  roots: readonly string[],
  realpath: (p: string) => string = realpathSync,
): boolean {
  let resolvedFile: string;
  try {
    resolvedFile = realpath(resolve(filePath));
  } catch {
    return false; // chemin irrésoluble : on ferme la porte.
  }
  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = realpath(resolve(root));
    } catch {
      continue; // racine irrésoluble : on l'ignore, sans élargir le périmètre.
    }
    if (resolvedFile === resolvedRoot) return true;
    const withSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    if (resolvedFile.startsWith(withSep)) return true;
  }
  return false;
}

/**
 * Lit les octets d'un fichier audio et les renvoie en `ArrayBuffer` (copie propre, sans offset).
 * SÉCURITÉ : après les gardes de `validateAudioPath`, le chemin doit être confiné à l'une des
 * racines persistées (`sources`), realpath du fichier ET des racines ; sinon on rejette.
 *
 * Anti-TOCTOU : on résout le chemin réel UNE SEULE FOIS (`realpathSync`), on décide le confinement
 * sur ce chemin canonique, puis on **lit ce même chemin canonique** (et non le `file` d'origine).
 * Un lien symbolique échangé entre la vérification et la lecture ne peut donc pas rediriger la
 * lecture hors d'une racine : le chemin canonique ne contient plus aucun lien à ré-suivre.
 */
export async function readAudioFile(db: Database.Database, path: unknown): Promise<ArrayBuffer> {
  const file = validateAudioPath(path);
  let realFile: string;
  try {
    realFile = realpathSync(resolve(file));
  } catch {
    throw new Error(`audio:read-file: not a file: ${file}`);
  }
  const roots = getSources(db).map((s) => s.path);
  // `realFile` est déjà canonique : la ré-résolution interne d'`isPathWithinRoots` est idempotente.
  if (!isPathWithinRoots(realFile, roots)) {
    throw new Error(`audio:read-file: path outside indexed roots: ${file}`);
  }
  const buf = await readFile(realFile);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Ouvre le selecteur de dossier natif (`openDirectory`). Renvoie le chemin choisi, ou `null`
 * si l'utilisateur annule. Rattache la boite a la fenetre appelante quand elle est connue.
 */
export async function pickFolder(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ["openDirectory"] };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/** Normalise limit/offset : jamais NaN/undefined (better-sqlite3 leve sinon), borne a [1, MAX_LIMIT] / >= 0. */
export function normalizePage(args: Partial<Pick<LibraryQueryArgs, "limit" | "offset">>): Page {
  const int = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return {
    limit: Math.min(Math.max(int(args.limit, DEFAULT_LIMIT), 1), MAX_LIMIT),
    offset: Math.max(int(args.offset, 0), 0),
  };
}

export function queryLibrary(db: Database.Database, args: unknown): LibraryQueryResult {
  if (typeof args !== "object" || args === null) throw new Error("library:query: invalid args");
  const { view, ...rest } = args as Partial<LibraryQueryArgs>;
  if (typeof view !== "string" || !VIEWS.has(view)) throw new Error("library:query: invalid view");
  const page = normalizePage(rest);
  switch (view) {
    case "albums":
      return { view, rows: getAlbums(db, page) };
    case "tracks":
      return { view, rows: getAllTracks(db, page) };
    default:
      return { view: "artists", rows: getArtists(db).slice(page.offset, page.offset + page.limit) };
  }
}

/**
 * Valide les arguments de `library:search` et délègue à `searchTracks`. `q` doit être une
 * chaîne (sinon rejet) ; `limit` est borné via `normalizePage` (offset implicite = 0).
 */
export function searchLibrary(db: Database.Database, args: unknown): TrackRow[] {
  if (typeof args !== "object" || args === null) throw new Error("library:search: invalid args");
  const { q, limit } = args as Partial<SearchArgs>;
  if (typeof q !== "string") throw new Error("library:search: q must be a string");
  return searchTracks(db, q, normalizePage({ limit }));
}

/** Enregistre les handlers IPC du process Main. audio:* arrive avec sa tache. */
export function registerIpc(db: Database.Database): void {
  ipcMain.handle(CHANNELS.PING, (): "pong" => "pong");

  ipcMain.handle(CHANNELS.LIBRARY_QUERY, (event, args: unknown): LibraryQueryResult => {
    assertTrusted(event);
    return queryLibrary(db, args);
  });

  ipcMain.handle(CHANNELS.LIBRARY_SEARCH, (event, args: unknown): TrackRow[] => {
    assertTrusted(event);
    return searchLibrary(db, args);
  });

  ipcMain.handle(CHANNELS.LIBRARY_SCAN, async (event, paths: unknown): Promise<ScanSummary> => {
    assertTrusted(event);
    const roots = validateScanPaths(paths);
    // Les racines scannées deviennent des sources persistées (idempotent) : ce sont
    // exactement les racines que `audio:read-file` accepte de lire ensuite.
    for (const root of roots) addSource(db, root);
    let last: ScanSummary = { scanned: 0, added: 0, skipped: 0, errors: 0 };
    const { added, skipped } = await indexLibrary(db, roots, (p) => {
      last = p;
    });
    return { ...last, added, skipped };
  });

  ipcMain.handle(CHANNELS.AUDIO_DEFAULT_DEVICE, (event): Promise<AudioDeviceInfo> => {
    assertTrusted(event);
    return defaultOutputDevice();
  });

  ipcMain.handle(CHANNELS.AUDIO_READ_FILE, (event, path: unknown): Promise<ArrayBuffer> => {
    assertTrusted(event);
    return readAudioFile(db, path);
  });

  ipcMain.handle(CHANNELS.DIALOG_PICK_FOLDER, (event): Promise<string | null> => {
    assertTrusted(event);
    return pickFolder(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle(CHANNELS.SOURCES_LIST, (event): SourceRow[] => {
    assertTrusted(event);
    return getSources(db);
  });

  ipcMain.handle(CHANNELS.SOURCES_REMOVE, (event, id: unknown): void => {
    assertTrusted(event);
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new Error("sources:remove: id must be an integer");
    }
    removeSource(db, id);
  });
}
