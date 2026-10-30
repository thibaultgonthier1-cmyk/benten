/**
 * Règle d'URL YouTube partagée entre le Main (dernière barrière avant `spawn`) et le Renderer
 * (validation en direct du champ). Une seule implémentation : le champ et le Main ne peuvent pas
 * diverger sur ce qui est acceptable.
 */

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const SHORT_HOST = "youtu.be";
const ID = /^[A-Za-z0-9_-]{11}$/;

function canonical(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Accepte **uniquement** un lien YouTube https valide et renvoie sa forme canonique
 * `https://www.youtube.com/watch?v=<id>`. Tout le reste — autre hôte, `http:`, `file:`, identifiant
 * court, espace, point-virgule, présence de `--` — renvoie `null`.
 *
 * Le `--` est refusé volontairement : c'est ainsi qu'on injecterait un argument dans yt-dlp.
 */
export function validateYoutubeUrl(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (/\s/.test(text) || text.includes(";") || text.includes("--")) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  if (host === SHORT_HOST) {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    return ID.test(id) ? canonical(id) : null;
  }
  if (!HOSTS.has(host)) return null;

  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v") ?? "";
    return ID.test(id) ? canonical(id) : null;
  }
  const shorts = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/);
  if (shorts) return canonical(shorts[1]!);
  return null;
}

const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;

export interface YoutubePlaylistLink {
  /** URL canonique de la playlist. */
  url: string;
  listId: string;
  startVideoId: string | null;
}

/**
 * Lien de playlist YouTube ? Accepte `/playlist?list=`, `watch?v=…&list=…` et `music.youtube.com`.
 * Le lien canonique ne garde que la playlist : on veut TOUTE la liste, pas la vidéo courante.
 */
export function parseYoutubePlaylistUrl(raw: string): YoutubePlaylistLink | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const listId = url.searchParams.get("list") ?? "";
  if (!PLAYLIST_ID.test(listId)) return null;
  const video = url.searchParams.get("v");
  return {
    url: `https://www.youtube.com/playlist?list=${listId}`,
    listId,
    startVideoId: video && VIDEO.test(video) ? video : null,
  };
}
