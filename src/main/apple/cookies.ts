import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Cookies Apple Music (format Netscape `cookies.txt`), stockés dans le dossier de données de l'app.
 *
 * Ils ne quittent jamais la machine : ils servent uniquement à `gamdl`, lancé en local sur des
 * liens fournis par l'utilisateur. On refuse un contenu qui ne ressemble pas à un export Netscape,
 * pour éviter d'écrire n'importe quoi puis d'échouer avec un message obscur.
 */

export interface CookiesStatus {
  present: boolean;
  updatedAt: number | null;
  /** Nombre de lignes de cookies reconnues (indice de validité, sans révéler les valeurs). */
  entries: number;
}

/** Un export Netscape valide : des lignes `domaine\tflag\tchemin\t…\tname\tvalue`. */
export function looksLikeNetscapeCookies(text: string): boolean {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) return false;
  return lines.some((line) => line.split("\t").length >= 7 && /apple\.com/i.test(line));
}

export function countCookieEntries(text: string): number {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.split("\t").length >= 7;
    }).length;
}

/** Chemin du `cookies.txt` de l'app. */
export function cookiesPath(userDataDir: string): string {
  return join(userDataDir, "cookies.txt");
}

/** Écrit les cookies après validation. Lève avec un message clair si le contenu ne convient pas. */
export async function saveCookies(userDataDir: string, text: string): Promise<CookiesStatus> {
  const content = String(text ?? "").replace(/\r\n/g, "\n");
  if (/^https?:\/\//im.test(content) && !content.includes("\t")) {
    throw new Error(
      "Ce texte ressemble à un lien, pas à un export de cookies. Exporte le fichier cookies.txt depuis l'extension.",
    );
  }
  if (!looksLikeNetscapeCookies(content)) {
    throw new Error(
      "Format non reconnu : un export Netscape contient des lignes séparées par des tabulations, avec apple.com dedans.",
    );
  }
  const target = cookiesPath(userDataDir);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return statusFor(userDataDir);
}

/** État courant, sans jamais exposer les valeurs. */
export async function cookiesStatus(userDataDir: string): Promise<CookiesStatus> {
  const target = cookiesPath(userDataDir);
  if (!existsSync(target)) return { present: false, updatedAt: null, entries: 0 };
  try {
    const text = await readFile(target, "utf8");
    const { stat } = await import("node:fs/promises");
    const info = await stat(target);
    return { present: true, updatedAt: info.mtimeMs, entries: countCookieEntries(text) };
  } catch {
    return { present: existsSync(target), updatedAt: null, entries: 0 };
  }
}

async function statusFor(userDataDir: string): Promise<CookiesStatus> {
  return cookiesStatus(userDataDir);
}

/** Chemin utilisable par `gamdl`, ou `null`. */
export function existingCookiesPath(userDataDir: string): string | null {
  const target = cookiesPath(userDataDir);
  return existsSync(target) ? target : null;
}
