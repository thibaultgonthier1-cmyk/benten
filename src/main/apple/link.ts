/**
 * Reconnaissance des liens Apple Music collés par l'utilisateur.
 *
 * Trois formes réelles, telles que le bouton « Copier le lien » d'Apple Music les produit :
 *
 * - playlist : `https://music.apple.com/fr/playlist/<nom>/pl.<id>`
 * - album    : `https://music.apple.com/fr/album/<nom>/<albumId>`
 * - **titre** : `https://music.apple.com/fr/album/<nom>/<albumId>?i=<trackId>`
 *   (c'est ce que donne « Copier le lien » sur une chanson) et parfois
 *   `https://music.apple.com/fr/song/<nom>/<trackId>`
 *
 * Un lien de titre se résout via son album : on demande l'album puis on ne garde
 * que la piste dont l'identifiant correspond. `trackIdExplicit` distingue le cas
 * `/song/` (l'identifiant est celui du titre) du cas `?i=` (identifiant de piste
 * dans un album).
 */

export type AppleLinkKind = "playlist" | "album" | "song";

export interface AppleLink {
  kind: AppleLinkKind;
  /** URL à donner au résolveur (sans le paramètre `i`). */
  resolveUrl: string;
  /** Identifiant de la piste à isoler, si le lien désigne un titre. */
  trackId: string | null;
  /** `true` quand l'identifiant de piste est porté par le chemin (`/song/<id>`). */
  trackIdIsPath: boolean;
}

const HOST = /(^|\.)music\.apple\.com$/i;
const ID = /^[0-9]+$/;

export function parseAppleLink(raw: string): AppleLink | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!HOST.test(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const kindIndex = parts.findIndex((part) => part === "playlist" || part === "album" || part === "song");
  if (kindIndex === -1) return null;
  const segment = parts[kindIndex]!;
  const id = parts[kindIndex + 2] ?? "";

  if (segment === "playlist") {
    if (!/^pl\.[A-Za-z0-9._-]+$/.test(id)) return null;
    const clean = new URL(url.toString());
    clean.search = "";
    return { kind: "playlist", resolveUrl: clean.toString(), trackId: null, trackIdIsPath: false };
  }

  if (segment === "song") {
    if (!ID.test(id)) return null;
    return { kind: "song", resolveUrl: url.toString(), trackId: id, trackIdIsPath: true };
  }

  // Album, éventuellement pointé sur une piste via `?i=`.
  if (!ID.test(id)) return null;
  const trackId = url.searchParams.get("i");
  const clean = new URL(url.toString());
  clean.search = "";
  if (trackId && ID.test(trackId)) {
    return { kind: "song", resolveUrl: clean.toString(), trackId, trackIdIsPath: false };
  }
  return { kind: "album", resolveUrl: clean.toString(), trackId: null, trackIdIsPath: false };
}
