import type { TrackRow } from "../../shared/types";

/** Album agrege cote Renderer : metadonnees + pistes ordonnees (pour `setQueue`). */
export interface Album {
  id: number;
  title: string;
  artist: string;
  /** Cle de pochette (premiere piste qui en a une), `null` sinon. */
  artKey: string | null;
  tracks: readonly TrackRow[];
}

/**
 * Regroupe une liste de pistes (vue « tracks ») en albums, par `albumId`. Les pistes d'un album
 * gardent l'ordre de la requete (deja trie par n° de piste cote repository via `tracksByAlbum`,
 * mais la vue « tracks » trie par titre ; on re-trie donc par n° de piste puis titre). Les albums
 * sont ordonnes par titre (insensible a la casse) pour un rendu stable facon bibliotheque.
 */
export function groupTracksToAlbums(tracks: readonly TrackRow[]): Album[] {
  const byId = new Map<number, TrackRow[]>();
  for (const t of tracks) {
    let arr = byId.get(t.albumId);
    if (!arr) {
      arr = [];
      byId.set(t.albumId, arr);
    }
    arr.push(t);
  }
  const albums: Album[] = [];
  for (const [id, group] of byId) {
    group.sort(trackOrder);
    const first = group[0]!;
    const withArt = group.find((t) => t.artKey);
    albums.push({
      id,
      title: first.album,
      // Artiste d'album (tag `albumartist`, ex. « Various Artists ») — c'est lui qui regroupe
      // l'album côté base ; à défaut, l'artiste de la piste.
      artist: first.albumArtist?.trim() || first.artist,
      artKey: withArt?.artKey ?? null,
      tracks: group,
    });
  }
  albums.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  return albums;
}

/**
 * Ordre intra-album : n° de disque, puis n° de piste (les null a la fin), puis titre, puis id.
 * Le disque passe en premier : sans lui, les pistes 1 des disques 1 et 2 s'entrelaceraient (file
 * de lecture et page album multi-disques dans le mauvais ordre).
 */
function trackOrder(a: TrackRow, b: TrackRow): number {
  const ad = a.discNo ?? Number.POSITIVE_INFINITY;
  const bd = b.discNo ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  const an = a.trackNo ?? Number.POSITIVE_INFINITY;
  const bn = b.trackNo ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  return byTitle !== 0 ? byTitle : a.id - b.id;
}

/** URL de pochette via le protocole prive `benten-art://` (a utiliser en `<img src>`). */
export function artUrl(artKey: string | null | undefined, size = 256): string | null {
  if (!artKey) return null;
  return `benten-art://${encodeURIComponent(artKey)}?size=${size}`;
}

/** `mm:ss` depuis des secondes (borne a >= 0). */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export interface Quality {
  /** Format source en majuscules, p.ex. `FLAC`. */
  format: string;
  /** Libelle qualite source : `24-bit/44.1 kHz` (sans perte) ou `44.1 kHz` (avec perte). */
  detail: string;
  /** Vrai si on dispose d'une profondeur de bits (piste sans perte). */
  lossless: boolean;
  /** Libelle complet `FLAC · 24-bit/44.1 kHz`. */
  label: string;
}

/** kHz lisible : 44100 -> `44.1`, 48000 -> `48`, 96000 -> `96`. */
function kHz(sampleRate: number): string {
  const v = sampleRate / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Qualite de la SOURCE (jamais la frequence du graphe audio) a partir de la ligne de piste :
 * format + sampleRate/bitDepth. Une piste sans `bitDepth` (format avec perte) montre la frequence
 * seule. Robuste aux valeurs manquantes.
 */
export function describeQuality(
  track: Pick<TrackRow, "format" | "sampleRate" | "bitDepth">,
): Quality {
  const format = (track.format || "").toUpperCase();
  const lossless = track.bitDepth != null && track.bitDepth > 0;
  let detail: string;
  if (lossless && track.sampleRate) {
    detail = `${track.bitDepth}-bit/${kHz(track.sampleRate)} kHz`;
  } else if (track.sampleRate) {
    detail = `${kHz(track.sampleRate)} kHz`;
  } else {
    detail = "";
  }
  const label = detail ? `${format} · ${detail}` : format;
  return { format, detail, lossless, label };
}
