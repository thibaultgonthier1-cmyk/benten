import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../shared/channels";
import type {
  AudioDeviceInfo,
  LibraryFilter,
  LibraryQueryArgs,
  LibraryQueryResult,
  LibraryView,
  Page,
  PlaylistRow,
  ScanSummary,
  SearchArgs,
  SortDir,
  SortField,
  SourceRow,
  TrackRow,
} from "../shared/types";
import { defaultOutputDevice, listOutputDevices } from "./audio/devices";
import { indexLibrary } from "./library/indexer";
import { parseImportFile } from "./importer/applePlaylist";
import { matchTracks } from "./importer/matcher";
import { validateDiagEntries, type JournalWriter } from "./journal";
import {
  addSource,
  addToPlaylist,
  createPlaylist,
  deletePlaylist,
  getAlbums,
  getAllTracks,
  getArtists,
  getFavoriteIds,
  getPlaylists,
  getPlaylistTracks,
  getSources,
  getState,
  getTracksByIds,
  removeFromPlaylist,
  removeSource,
  renamePlaylist,
  reorderPlaylist,
  insertIntoPlaylist,
  searchTracks,
  setFavorite,
  setState,
  type SortOpts,
} from "./library/repository";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_SCAN_PATHS = 64;
/** Garde-fou : un fichier audio plus gros que ca est tenu pour aberrant (chemin errone). */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const VIEWS: ReadonlySet<string> = new Set<LibraryView>(["albums", "tracks", "artists"]);
/** Garde-fou : un nom de playlist au-dela de cette longueur est tenu pour aberrant. */
const MAX_PLAYLIST_NAME = 200;

/** Exige un entier (sinon rejet avec le prefixe du canal). */
function requireInt(v: unknown, channel: string, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`${channel}: ${field} must be an integer`);
  }
  return v;
}

/** Exige un nom non vide (apres trim) et borne ; renvoie le nom TRIM. */
function requireName(v: unknown, channel: string): string {
  if (typeof v !== "string") throw new Error(`${channel}: name must be a string`);
  const name = v.trim();
  if (name.length === 0 || name.length > MAX_PLAYLIST_NAME) {
    throw new Error(`${channel}: name must be a non-empty string`);
  }
  return name;
}

/** Exige un tableau borne d'ids entiers (pour `playlists:add`). */
function requireIntArray(v: unknown, channel: string): number[] {
  if (!Array.isArray(v)) throw new Error(`${channel}: trackIds must be an array of integers`);
  for (const x of v) {
    if (typeof x !== "number" || !Number.isInteger(x)) {
      throw new Error(`${channel}: trackIds must be an array of integers`);
    }
  }
  return v as number[];
}

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

/**
 * Normalise tri/filtre côté IPC AVANT le repository. `dir` n'est accepté que parmi `asc|desc`
 * (sinon ignoré -> défaut) ; `sort` n'est transmis que s'il s'agit d'une chaîne, et c'est la LISTE
 * BLANCHE du repository qui garantit qu'une valeur inconnue (ou une tentative d'injection) retombe
 * sur le défaut sans jamais atteindre le SQL. `filter` est réduit à des booléens stricts.
 */
export function normalizeSortOpts(args: {
  sort?: unknown;
  dir?: unknown;
  filter?: unknown;
}): SortOpts {
  const sort = typeof args.sort === "string" ? (args.sort as SortField) : undefined;
  const dir: SortDir | undefined =
    args.dir === "asc" || args.dir === "desc" ? args.dir : undefined;
  let filter: LibraryFilter | undefined;
  if (typeof args.filter === "object" && args.filter !== null) {
    const f = args.filter as Record<string, unknown>;
    filter = { favoritesOnly: f["favoritesOnly"] === true, losslessOnly: f["losslessOnly"] === true };
  }
  return { sort, dir, filter };
}

export function queryLibrary(db: Database.Database, args: unknown): LibraryQueryResult {
  if (typeof args !== "object" || args === null) throw new Error("library:query: invalid args");
  const { view, sort, dir, filter, ...rest } = args as Partial<LibraryQueryArgs>;
  if (typeof view !== "string" || !VIEWS.has(view)) throw new Error("library:query: invalid view");
  const page = normalizePage(rest);
  const opts = normalizeSortOpts({ sort, dir, filter });
  switch (view) {
    case "albums":
      return { view, rows: getAlbums(db, page, opts) };
    case "tracks":
      return { view, rows: getAllTracks(db, page, opts) };
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

/** Versions consignees dans l'entree `session` du journal audio (fournies par le Main). */
export interface DiagnosticsVersions {
  appVersion: string;
  electron?: string;
  chrome?: string;
}

/**
 * Canal `diagnostics:append` (journal audio). Expediteur fiable exige (`assertTrusted`), payload
 * valide STRICTEMENT (`validateDiagEntries`), puis ajoute au fichier fixe par le Main — jamais de
 * chemin fourni par le Renderer. Les entrees `session` sont enrichies des versions de l'app.
 * Enregistre a part de `registerIpc` : le journal est independant de la base.
 */
export function registerDiagnosticsIpc(writer: JournalWriter, versions: DiagnosticsVersions): void {
  ipcMain.handle(CHANNELS.DIAGNOSTICS_APPEND, async (event, entries: unknown): Promise<void> => {
    assertTrusted(event);
    const valid = validateDiagEntries(entries);
    const enriched = valid.map((e) =>
      e.kind === "session"
        ? {
            ...e,
            appVersion: versions.appVersion,
            electron: versions.electron ?? null,
            chrome: versions.chrome ?? null,
          }
        : e,
    );
    await writer.append(enriched);
  });
}

/** Crochets optionnels du process Main (ex. : (re)démarrer la veille quand les sources changent). */
export interface IpcHooks {
  /** Appelé après qu'un scan a (potentiellement) ajouté une source persistée. */
  onSourcesChanged?: () => void;
  /** T17 — passage en mode compact (fenêtre). Absent dans les tests. */
  setCompact?: (on: boolean) => void;
  /** T15 — téléchargeur YouTube. Fourni par le Main, absent dans les tests. */
  youtube?: {
    enqueue(url: unknown): unknown;
    jobs(): unknown;
    status(): unknown;
    update(): Promise<unknown>;
  };
}

/** Enregistre les handlers IPC du process Main. audio:* arrive avec sa tache. */
export function registerIpc(db: Database.Database, hooks?: IpcHooks): void {
  // ── T17 — mode compact ───────────────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.WINDOW_SET_COMPACT, (event, on: unknown) => {
    assertTrusted(event);
    // Refus net d'un non-booléen : la fenêtre ne change jamais d'état sur une entrée douteuse.
    if (typeof on !== "boolean") throw new Error("window:set-compact: on must be a boolean");
    hooks?.setCompact?.(on);
    return { compact: on };
  });

  // ── T16 — import d'une playlist Apple ────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.DIALOG_PICK_FILE, async (event): Promise<string | null> => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog({
      title: "Choisir un export de playlist",
      properties: ["openFile"],
      filters: [
        { name: "Exports de playlist", extensions: ["txt", "m3u", "m3u8", "xml", "csv"] },
        { name: "Tous les fichiers", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(CHANNELS.IMPORT_PREVIEW, async (event, filePath: unknown) => {
    assertTrusted(event);
    const path = String(filePath ?? "");
    if (!path) throw new Error("import:preview — chemin manquant");
    const buffer = await readFile(path);
    const parsed = parseImportFile(path, buffer);
    const library = queryLibrary(db, { view: "tracks", limit: 5000 });
    // `rows` porte les colonnes de la vue « titres » : c'est exactement ce que le matcher attend.
    const matched = matchTracks(parsed, library.rows as never);
    return {
      items: matched.map((entry) => ({
        title: entry.imported.title,
        artist: entry.imported.artist,
        matchedTrackId: entry.track ? entry.track.id : null,
        score: entry.score,
      })),
    };
  });

  ipcMain.handle(CHANNELS.IMPORT_COMMIT, (event, payload: unknown) => {
    assertTrusted(event);
    const input = (payload ?? {}) as { name?: unknown; trackIds?: unknown };
    const name = requireName(input.name, "import:commit");
    const ids = requireIntArray(input.trackIds, "import:commit");
    const playlistId = createPlaylist(db, name);
    if (ids.length > 0) addToPlaylist(db, playlistId, ids);
    return { playlistId };
  });
  // ── T15 — YouTube → MP3 ──────────────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.YOUTUBE_ENQUEUE, (event, url: unknown) => {
    assertTrusted(event);
    return hooks?.youtube?.enqueue(url) ?? null;
  });
  ipcMain.handle(CHANNELS.YOUTUBE_JOBS, (event) => {
    assertTrusted(event);
    return hooks?.youtube?.jobs() ?? [];
  });
  ipcMain.handle(CHANNELS.YOUTUBE_STATUS, (event) => {
    assertTrusted(event);
    return hooks?.youtube?.status() ?? { installed: false, version: null };
  });
  ipcMain.handle(CHANNELS.YOUTUBE_UPDATE, async (event) => {
    assertTrusted(event);
    return (await hooks?.youtube?.update()) ?? { installed: false, version: null };
  });
  ipcMain.handle(CHANNELS.PING, (event): "pong" => {
    assertTrusted(event);
    return "pong";
  });

  ipcMain.handle(CHANNELS.LIBRARY_QUERY, (event, args: unknown): LibraryQueryResult => {
    assertTrusted(event);
    return queryLibrary(db, args);
  });

  ipcMain.handle(CHANNELS.LIBRARY_SEARCH, (event, args: unknown): TrackRow[] => {
    assertTrusted(event);
    return searchLibrary(db, args);
  });

  ipcMain.handle(CHANNELS.LIBRARY_TRACKS_BY_IDS, (event, ids: unknown): TrackRow[] => {
    assertTrusted(event);
    return getTracksByIds(db, requireIntArray(ids, "library:tracks-by-ids"));
  });

  ipcMain.handle(CHANNELS.LIBRARY_SCAN, async (event, paths: unknown): Promise<ScanSummary> => {
    assertTrusted(event);
    const roots = validateScanPaths(paths);
    // Les racines scannées deviennent des sources persistées (idempotent) : ce sont
    // exactement les racines que `audio:read-file` accepte de lire ensuite.
    for (const root of roots) addSource(db, root);
    // Une racine a pu s'ajouter : on prévient le gestionnaire de veille pour qu'il (re)démarre
    // la surveillance sur l'ensemble des sources courantes (Task 14B).
    hooks?.onSourcesChanged?.();
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

  ipcMain.handle(CHANNELS.AUDIO_LIST_DEVICES, (event): Promise<AudioDeviceInfo[]> => {
    assertTrusted(event);
    return listOutputDevices();
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
    // Une source a disparu : on (re)démarre la veille sur l'ensemble restant (Task 14B).
    hooks?.onSourcesChanged?.();
  });

  ipcMain.handle(CHANNELS.FAVORITES_TOGGLE, (event, trackId: unknown, on: unknown): void => {
    assertTrusted(event);
    if (typeof trackId !== "number" || !Number.isInteger(trackId)) {
      throw new Error("favorites:toggle: trackId must be an integer");
    }
    setFavorite(db, trackId, on === true);
  });

  ipcMain.handle(CHANNELS.FAVORITES_LIST, (event): number[] => {
    assertTrusted(event);
    return getFavoriteIds(db);
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_LIST, (event): PlaylistRow[] => {
    assertTrusted(event);
    return getPlaylists(db);
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_CREATE, (event, name: unknown): number => {
    assertTrusted(event);
    return createPlaylist(db, requireName(name, "playlists:create"));
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_RENAME, (event, id: unknown, name: unknown): void => {
    assertTrusted(event);
    renamePlaylist(db, requireInt(id, "playlists:rename", "id"), requireName(name, "playlists:rename"));
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_DELETE, (event, id: unknown): void => {
    assertTrusted(event);
    deletePlaylist(db, requireInt(id, "playlists:delete", "id"));
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_TRACKS, (event, id: unknown): TrackRow[] => {
    assertTrusted(event);
    return getPlaylistTracks(db, requireInt(id, "playlists:tracks", "id"));
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_ADD, (event, id: unknown, trackIds: unknown): void => {
    assertTrusted(event);
    addToPlaylist(db, requireInt(id, "playlists:add", "id"), requireIntArray(trackIds, "playlists:add"));
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_REMOVE, (event, id: unknown, position: unknown): void => {
    assertTrusted(event);
    removeFromPlaylist(
      db,
      requireInt(id, "playlists:remove", "id"),
      requireInt(position, "playlists:remove", "position"),
    );
  });

  ipcMain.handle(CHANNELS.PLAYLISTS_REORDER, (event, id: unknown, from: unknown, to: unknown): void => {
    assertTrusted(event);
    reorderPlaylist(
      db,
      requireInt(id, "playlists:reorder", "id"),
      requireInt(from, "playlists:reorder", "from"),
      requireInt(to, "playlists:reorder", "to"),
    );
  });

  ipcMain.handle(
    CHANNELS.PLAYLISTS_INSERT_AT,
    (event, id: unknown, trackId: unknown, position: unknown): void => {
      assertTrusted(event);
      const pos = requireInt(position, "playlists:insert-at", "position");
      if (pos < 0) throw new Error("playlists:insert-at: position must be >= 0");
      insertIntoPlaylist(
        db,
        requireInt(id, "playlists:insert-at", "id"),
        requireInt(trackId, "playlists:insert-at", "trackId"),
        pos,
      );
    },
  );

  ipcMain.handle(CHANNELS.STATE_GET, (event, key: unknown): string | undefined => {
    assertTrusted(event);
    if (typeof key !== "string") throw new Error("state:get: key must be a string");
    return getState(db, key);
  });

  ipcMain.handle(CHANNELS.STATE_SET, (event, key: unknown, value: unknown): void => {
    assertTrusted(event);
    if (typeof key !== "string") throw new Error("state:set: key must be a string");
    if (typeof value !== "string") throw new Error("state:set: value must be a string");
    setState(db, key, value);
  });
}




