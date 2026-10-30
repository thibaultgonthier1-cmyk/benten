import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Source des cookies YouTube.
 *
 * Un fichier exporté devient périmé en quelques minutes : YouTube fait tourner ses jetons de
 * session, et l'export fige une valeur déjà remplacée côté navigateur. Le mode « navigateur »
 * (`--cookies-from-browser`) lit la session à chaque appel — c'est le seul mode durable.
 */

export type CookieMode = "none" | "file" | "browser";
export type BrowserName = "chrome" | "edge" | "firefox" | "brave" | "chromium";

export interface CookieSource {
  mode: CookieMode;
  browser: BrowserName;
}

const FILE = "youtube-cookies.json";
const BROWSERS: readonly BrowserName[] = ["chrome", "edge", "firefox", "brave", "chromium"];

export const DEFAULT_COOKIE_SOURCE: CookieSource = Object.freeze({ mode: "none", browser: "chrome" });

export function isBrowserName(value: unknown): value is BrowserName {
  return typeof value === "string" && (BROWSERS as readonly string[]).includes(value);
}

export function normalizeCookieSource(raw: unknown): CookieSource {
  const value = (raw ?? {}) as Partial<Record<keyof CookieSource, unknown>>;
  const mode: CookieMode =
    value.mode === "file" || value.mode === "browser" || value.mode === "none"
      ? value.mode
      : DEFAULT_COOKIE_SOURCE.mode;
  const browser = isBrowserName(value.browser) ? value.browser : DEFAULT_COOKIE_SOURCE.browser;
  return { mode, browser };
}

export async function readCookieSource(userDataDir: string): Promise<CookieSource> {
  const path = join(userDataDir, FILE);
  if (!existsSync(path)) return { ...DEFAULT_COOKIE_SOURCE };
  try {
    return normalizeCookieSource(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { ...DEFAULT_COOKIE_SOURCE };
  }
}

export async function writeCookieSource(userDataDir: string, source: unknown): Promise<CookieSource> {
  const next = normalizeCookieSource(source);
  const path = join(userDataDir, FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next), "utf8");
  return next;
}

/**
 * Arguments yt-dlp correspondant à la source. `cookiesPath` n'est utilisé qu'en mode fichier.
 * Aucune option n'est ajoutée quand rien n'est configuré — yt-dlp reste anonyme.
 */
export function cookieArgs(source: CookieSource, cookiesPath: string | null): string[] {
  if (source.mode === "browser") return ["--cookies-from-browser", source.browser];
  if (source.mode === "file" && cookiesPath && existsSync(cookiesPath)) return ["--cookies", cookiesPath];
  return [];
}
