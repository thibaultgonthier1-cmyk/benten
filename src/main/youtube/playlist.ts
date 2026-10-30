import { spawn } from "node:child_process";
import { parseYoutubePlaylistUrl, type YoutubePlaylistLink } from "../../shared/youtube";

export { parseYoutubePlaylistUrl };

/**
 * Playlists YouTube : reconnaissance du lien et résolution en liste de titres.
 *
 * On interroge `yt-dlp -J --flat-playlist` (aucun téléchargement, juste les métadonnées) puis on
 * rend des pistes au même format que la résolution Apple — c'est ce qui permet de réutiliser le
 * même rapprochement avec la bibliothèque.
 *
 * Sécurité : le lien est validé ici (https, hôte YouTube, identifiant de playlist), et `spawn` est
 * toujours appelé avec `shell: false`.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;


export interface YoutubePlaylistTrack {
  title: string;
  artist: string;
  duration: number;
  /** URL de la vidéo, prête pour yt-dlp. */
  url: string;
}

/** Métadonnées `yt-dlp -J` → pistes exploitables. Les entrées sans titre sont ignorées. */
export function entriesFromFlatJson(json: unknown): YoutubePlaylistTrack[] {
  const root = json as { entries?: unknown[] } | null;
  const entries = Array.isArray(root?.entries) ? root!.entries : [];
  const tracks: YoutubePlaylistTrack[] = [];
  for (const raw of entries) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry) continue;
    const title = String(entry["title"] ?? "").trim();
    const id = String(entry["id"] ?? "").trim();
    if (!title || !VIDEO_ID.test(id)) continue;
    const duration = Number(entry["duration"] ?? 0);
    const artist =
      String(entry["artist"] ?? "").trim() ||
      String(entry["uploader"] ?? "").trim() ||
      String(entry["channel"] ?? "").trim() ||
      "";
    tracks.push({
      title,
      artist,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  }
  return tracks;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Résout une playlist en liste de titres. Lève si yt-dlp échoue (message lisible).
 * `spawnImpl` est injectable pour les tests.
 */
export function resolveYoutubePlaylist(
  binaryPath: string,
  listUrl: string,
  options: { spawnImpl?: typeof spawn; maxEntries?: number; cookieArgs?: readonly string[] } = {},
): Promise<YoutubePlaylistTrack[]> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const args = ["--flat-playlist", "-J", "--no-warnings", "--no-call-home"];
  // Cookies : indispensable pour une playlist PRIVÉE (les siennes) ; inutile pour une publique.
  // Les arguments viennent de `cookieSource` : fichier exporté ou lecture directe du navigateur.
  if (options.cookieArgs?.length) args.push(...options.cookieArgs);
  args.push(listUrl);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const child = spawnImpl(binaryPath, args, { shell: false, windowsHide: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_BUFFER) {
        child.kill();
        reject(new Error("Playlist trop volumineuse pour être analysée."));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = err.trim().split(/\r?\n/).pop() || `yt-dlp a quitté avec le code ${code}`;
        // Message actionnable : « playlist does not exist » veut presque toujours dire « privée ».
        // Cookies du navigateur illisibles (verrou de base, chiffrement app-bound) : message dédié.
        if (/Could not copy|Failed to decrypt|DPAPI|cookies database/i.test(detail)) {
          reject(
            new Error(
              "Ce navigateur protège ses cookies et yt-dlp ne peut pas les lire. Exporte plutôt le fichier cookies.txt et colle-le ici, juste avant d'analyser.",
            ),
          );
          return;
        }
        if (/playlist does not exist|does not exist/i.test(detail)) {
          reject(
            new Error(
              "Playlist introuvable : elle est probablement privée. Rends-la « non répertoriée » sur YouTube, ou ajoute tes cookies YouTube dans cette app.",
            ),
          );
          return;
        }
        reject(new Error(detail));
        return;
      }
      try {
        const parsed = entriesFromFlatJson(JSON.parse(out));
        const limited = options.maxEntries ? parsed.slice(0, options.maxEntries) : parsed;
        resolve(limited);
      } catch {
        reject(new Error("Réponse yt-dlp illisible pour cette playlist."));
      }
    });
  });
}





