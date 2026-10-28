import { promises as nodeFs } from "node:fs";
import { extname, join } from "node:path";

/** Extensions audio reconnues (en minuscules, point inclus). */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".flac",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".aiff",
]);

export interface ScanEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Surface minimale du systeme de fichiers, injectable pour les tests. */
export interface ScanFs {
  readdir(dir: string): Promise<ScanEntry[]>;
}

const defaultFs: ScanFs = {
  readdir: (dir) => nodeFs.readdir(dir, { withFileTypes: true }),
};

/**
 * Parcourt `root` recursivement et produit les chemins des fichiers audio connus.
 * Ignore les dossiers/fichiers caches (prefixe `.`). Un dossier illisible est saute :
 * le parcours ne s'interrompt jamais. Ordre deterministe (tri par nom).
 * `extensions` permet d'elargir l'ensemble reconnu (defaut : `AUDIO_EXTENSIONS`).
 */
export async function* scanAudioFiles(
  root: string,
  fs: ScanFs = defaultFs,
  extensions: ReadonlySet<string> = AUDIO_EXTENSIONS,
): AsyncIterable<string> {
  let entries: ScanEntry[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* scanAudioFiles(full, fs, extensions);
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}
