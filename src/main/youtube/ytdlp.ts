import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { validateYoutubeUrl } from "../../shared/youtube";

export { validateYoutubeUrl };

/**
 * Cœur du téléchargeur YouTube → MP3 : tout ce qui décide sans effet de bord réseau.
 *
 * Trois fonctions pures (`validateYoutubeUrl`, `buildYtDlpArgs`, `parseProgress`) portent les
 * règles de sécurité et le format d'appel ; `ensureYtDlp` télécharge le binaire et **vérifie son
 * empreinte SHA-256** avant de l'écrire — une empreinte qui ne correspond pas supprime le fichier
 * et rejette.
 */

export type JobState = "queued" | "downloading" | "converting" | "done" | "error";

const RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const BINARY = "yt-dlp.exe";
const SUMS = "SHA2-256SUMS";

export function buildYtDlpArgs(url: string, outDir: string, ffmpegPath: string): string[] {
  return [
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--embed-thumbnail",
    "--add-metadata",
    "--no-playlist",
    "--newline",
    "--ffmpeg-location",
    ffmpegPath,
    "-o",
    join(outDir, "%(artist,uploader)s - %(title)s.%(ext)s"),
    url,
  ];
}

/** Ligne de sortie yt-dlp → avancement, ou `null` si la ligne n'en porte pas. */
export function parseProgress(line: string): { percent: number; stage: "download" | "convert" } | null {
  const text = String(line ?? "");
  if (text.includes("[ExtractAudio]")) return { percent: 100, stage: "convert" };
  const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (match) return { percent: Number(match[1]), stage: "download" };
  return null;
}

/** Empreinte du binaire listée dans `SHA2-256SUMS`, ou `null`. */
export function checksumFor(sums: string, fileName: string = BINARY): string | null {
  for (const line of String(sums ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2]!.trim() === fileName) return match[1]!.toLowerCase();
  }
  return null;
}

/**
 * Chemin local de `yt-dlp.exe`, téléchargé au besoin depuis la dernière release GitHub.
 * Réutilise un binaire déjà présent. Sur empreinte absente ou différente : fichier supprimé et
 * rejet — jamais de binaire non vérifié exécuté.
 */
export async function ensureYtDlp(
  binDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const target = join(binDir, BINARY);
  if (existsSync(target)) return target;

  await mkdir(binDir, { recursive: true });

  const sumsResponse = await fetchImpl(`${RELEASE}/${SUMS}`);
  if (!sumsResponse.ok) throw new Error(`somme de contrôle indisponible (${sumsResponse.status})`);
  const expected = checksumFor(await sumsResponse.text(), BINARY);
  if (!expected) throw new Error("empreinte de yt-dlp.exe absente de la release");

  const binaryResponse = await fetchImpl(`${RELEASE}/${BINARY}`);
  if (!binaryResponse.ok) throw new Error(`téléchargement de yt-dlp impossible (${binaryResponse.status})`);
  const bytes = Buffer.from(await binaryResponse.arrayBuffer());

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    // Rien n'est écrit : on supprime même une éventuelle écriture partielle.
    await rm(target, { force: true }).catch(() => undefined);
    throw new Error("l'empreinte de yt-dlp.exe ne correspond pas — téléchargement refusé");
  }

  const temporary = `${target}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return target;
}

/** Version installée, lue en lançant le binaire (`--version`), ou `null`. */
export async function readYtDlpVersion(
  binaryPath: string,
  spawnImpl: typeof execFile = execFile,
): Promise<string | null> {
  if (!existsSync(binaryPath)) return null;
  return new Promise((resolve) => {
    spawnImpl(binaryPath, ["--version"], { timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const version = String(stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
      resolve(version || null);
    });
  });
}

/** Lit un fichier de sommes déjà téléchargé (utile aux tests hors ligne). */
export async function readSumsFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}




