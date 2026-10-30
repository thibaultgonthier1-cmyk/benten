/**
 * Analyseurs d'exports de playlist : `.txt` (export Apple Music, UTF-16LE, en-têtes FR ou EN),
 * `.m3u8`, et `.xml` (plist Apple).
 *
 * Rien n'est deviné au hasard : le séparateur et l'encodage sont détectés, les colonnes sont
 * reconnues **par nom d'en-tête** (jamais par position), et l'ordre du fichier est conservé —
 * c'est ce qui permet de retrouver « la playlist comme dans Apple Music ».
 */

export interface ImportedTrack {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  /** Horodatage (ms) de l'ajout à la playlist, si le fichier le porte. */
  dateAdded?: number;
}

/** Décode un tampon selon sa marque d'ordre : UTF-16LE, UTF-16BE ou UTF-8. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  // Sans marque : beaucoup d'exports Apple sont de l'UTF-16LE pur (octets nuls alternés).
  if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00) return buf.toString("utf16le");
  return buf.toString("utf8");
}

const HEADERS = {
  title: ["name", "nom", "title", "titre"],
  artist: ["artist", "artiste", "artists"],
  album: ["album"],
  duration: ["time", "durée", "duree", "duration", "length"],
  dateAdded: ["date added", "date d'ajout", "date d’ajout", "added"],
} as const;

function columnIndex(headers: readonly string[], candidates: readonly string[]): number {
  return headers.findIndex((header) => candidates.includes(header));
}

/** Découpe une ligne tabulée ou CSV (guillemets doublés gérés). */
function splitRow(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t");
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

/** `4:32` ou `272` → secondes ; `—` et vides → `undefined`. */
export function parseDuration(raw: string): number | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] ? Number(clock[3]) : null];
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const plain = Number(text.replace(",", "."));
  return Number.isFinite(plain) && plain >= 0 ? plain : undefined;
}

/** Accepte les formats d'export Apple (`29/10/2026 21:04`) et l'ISO ; renvoie des ms ou `undefined`. */
export function parseDate(raw: string): number | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const fr = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (fr) {
    const [, d, m, y, hh, mm] = fr;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0));
    return Number.isNaN(date.getTime()) ? undefined : date.getTime();
  }
  const iso = Date.parse(text);
  return Number.isNaN(iso) ? undefined : iso;
}

/**
 * Export `.txt` d'Apple Music : une ligne d'en-tête, puis une ligne par titre.
 * Encodage et séparateur détectés ; colonnes repérées par nom (FR ou EN).
 */
export function parseAppleTxt(buf: Buffer): ImportedTrack[] {
  const text = decodeText(buf).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const first = lines[0]!;
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  const headers = splitRow(first, delimiter).map((header) => header.trim().toLowerCase());
  const iTitle = columnIndex(headers, HEADERS.title);
  const iArtist = columnIndex(headers, HEADERS.artist);
  const iAlbum = columnIndex(headers, HEADERS.album);
  const iDuration = columnIndex(headers, HEADERS.duration);
  const iDate = columnIndex(headers, HEADERS.dateAdded);
  if (iTitle === -1) return [];

  const rows: ImportedTrack[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line, delimiter);
    const title = (cells[iTitle] ?? "").trim();
    if (!title) continue;
    const artist = (iArtist >= 0 ? (cells[iArtist] ?? "") : "").trim();
    const album = iAlbum >= 0 ? (cells[iAlbum] ?? "").trim() : "";
    const durationSec = iDuration >= 0 ? parseDuration(cells[iDuration] ?? "") : undefined;
    const dateAdded = iDate >= 0 ? parseDate(cells[iDate] ?? "") : undefined;
    rows.push({
      title,
      artist,
      ...(album ? { album } : null),
      ...(durationSec !== undefined ? { durationSec } : null),
      ...(dateAdded !== undefined ? { dateAdded } : null),
    });
  }
  return rows;
}

/** Playlist `.m3u` / `.m3u8` : `#EXTINF:<secondes>,<Artiste> - <Titre>`. */
export function parseM3u(text: string): ImportedTrack[] {
  const rows: ImportedTrack[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*,\s*(.+)$/i);
    if (!match) continue;
    const seconds = Number(match[1]);
    const rest = match[2]!.trim();
    const split = rest.match(/^(.+?)\s+-\s+(.+)$/);
    const artist = split ? split[1]!.trim() : "";
    const title = (split ? split[2]! : rest).trim();
    if (!title) continue;
    rows.push({
      title,
      artist,
      ...(Number.isFinite(seconds) && seconds > 0 ? { durationSec: seconds } : null),
    });
  }
  return rows;
}

/**
 * Plist Apple (`.xml`) : on lit l'ordre de `Playlist Items`, chaque élément étant un `<dict>`
 * avec `Name`, `Artist`, `Album`, `Total Time` (ms) et éventuellement `Date Added`.
 *
 * Petit analyseur volontairement limité (dict/key/string/integer/array) : pas de dépendance, et
 * un fichier inattendu renvoie simplement une liste vide.
 */
export function parseApplePlist(xml: string): ImportedTrack[] {
  const text = String(xml ?? "");
  const itemsStart = text.indexOf("<key>Playlist Items</key>");
  const scope = itemsStart >= 0 ? text.slice(itemsStart) : text;
  const dicts = scope.match(/<dict>[\s\S]*?<\/dict>/g) ?? [];
  const rows: ImportedTrack[] = [];

  for (const dict of dicts) {
    const fields = new Map<string, string>();
    const pair = /<key>([^<]+)<\/key>\s*<(string|integer|real|date)>([\s\S]*?)<\/\2>/g;
    for (const match of dict.matchAll(pair)) fields.set(match[1]!.trim(), match[3]!.trim());

    const title = (fields.get("Name") ?? fields.get("Title") ?? "").trim();
    if (!title) continue;
    const artist = (fields.get("Artist") ?? "").trim();
    const album = (fields.get("Album") ?? "").trim();
    const totalTime = Number(fields.get("Total Time") ?? "");
    const dateAdded = parseDate(fields.get("Date Added") ?? "");

    rows.push({
      title,
      artist,
      ...(album ? { album } : null),
      ...(Number.isFinite(totalTime) && totalTime > 0 ? { durationSec: Math.round(totalTime / 1000) } : null),
      ...(dateAdded !== undefined ? { dateAdded } : null),
    });
  }
  return rows;
}

/** Choisit l'analyseur d'après l'extension du fichier choisi. */
export function parseImportFile(name: string, buf: Buffer): ImportedTrack[] {
  const lower = String(name ?? "").toLowerCase();
  if (lower.endsWith(".m3u") || lower.endsWith(".m3u8")) return parseM3u(decodeText(buf));
  if (lower.endsWith(".xml") || lower.endsWith(".plist")) return parseApplePlist(decodeText(buf));
  return parseAppleTxt(buf);
}
