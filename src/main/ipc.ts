import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../shared/channels";
import type {
  AudioDeviceInfo,
  LibraryQueryArgs,
  LibraryQueryResult,
  LibraryView,
  Page,
  ScanSummary,
} from "../shared/types";
import { defaultOutputDevice } from "./audio/devices";
import { indexLibrary } from "./library/indexer";
import { getAlbums, getAllTracks, getArtists } from "./library/repository";

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

/** Lit les octets d'un fichier audio et les renvoie en `ArrayBuffer` (copie propre, sans offset). */
export async function readAudioFile(path: unknown): Promise<ArrayBuffer> {
  const file = validateAudioPath(path);
  const buf = await readFile(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

/** Enregistre les handlers IPC du process Main. audio:* arrive avec sa tache. */
export function registerIpc(db: Database.Database): void {
  ipcMain.handle(CHANNELS.PING, (): "pong" => "pong");

  ipcMain.handle(CHANNELS.LIBRARY_QUERY, (event, args: unknown): LibraryQueryResult => {
    assertTrusted(event);
    return queryLibrary(db, args);
  });

  ipcMain.handle(CHANNELS.LIBRARY_SCAN, async (event, paths: unknown): Promise<ScanSummary> => {
    assertTrusted(event);
    const roots = validateScanPaths(paths);
    let last: ScanSummary = { scanned: 0, added: 0, skipped: 0, errors: 0 };
    const { added, skipped } = await indexLibrary(db, roots, (p) => {
      last = p;
    });
    return { ...last, added, skipped };
  });

  ipcMain.handle(CHANNELS.AUDIO_DEFAULT_DEVICE, (event): AudioDeviceInfo => {
    assertTrusted(event);
    return defaultOutputDevice();
  });

  ipcMain.handle(CHANNELS.AUDIO_READ_FILE, (event, path: unknown): Promise<ArrayBuffer> => {
    assertTrusted(event);
    return readAudioFile(path);
  });
}
