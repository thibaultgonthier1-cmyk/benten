import type { SortDir, TrackRow } from "../../shared/types";

/** Album agrege cote Renderer : metadonnees + pistes ordonnees (pour `setQueue`). */
export interface Album {
  id: number;
  title: string;
  artist: string;
  /** Cle de pochette (premiere piste qui en a une), `null` sinon. */
  artKey: string | null;
  tracks: readonly TrackRow[];
}

/** Champs de tri proposés sur la vue albums (sous-ensemble client de la liste blanche backend). */
export type AlbumSortField = "title" | "artist" | "duration";

/** État de tri + filtres piloté par la `SortFilterBar`. */
export interface AlbumSortFilter {
  sort: AlbumSortField;
  dir: SortDir;
  favoritesOnly: boolean;
  losslessOnly: boolean;
}

/** État par défaut : tri par titre croissant, aucun filtre. */
export const DEFAULT_SORT_FILTER: AlbumSortFilter = {
  sort: "title",
  dir: "asc",
  favoritesOnly: false,
  losslessOnly: false,
};

/** Durée totale d'un album = somme des durées de ses pistes. */
function albumDuration(a: Album): number {
  return a.tracks.reduce((sum, t) => sum + (Number.isFinite(t.durationSec) ? t.durationSec : 0), 0);
}

/** Album « sans perte » : au moins une piste avec profondeur de bits connue (`bitDepth != null`). */
function albumIsLossless(a: Album): boolean {
  return a.tracks.some((t) => t.bitDepth != null);
}

/**
 * Album « favori » : au moins une de ses pistes figure dans `favoriteIds` (l'ensemble des ids
 * favoris tenu par le store, source de vérité UI). On ne pose PAS de drapeau `favorite` sur la
 * piste : l'appartenance se lit depuis le set (miroir côté vue de la jointure `favorites` du
 * repository, câblée via `getAlbums(filter.favoritesOnly)` pour le chemin backend).
 */
function albumIsFavorite(a: Album, favoriteIds: ReadonlySet<number>): boolean {
  return a.tracks.some((t) => favoriteIds.has(t.id));
}

/**
 * Applique tri + filtres à une liste d'albums déjà regroupée (pure, stable, n'altère pas l'entrée).
 * Reflète côté vue la même liste blanche que `getAlbums` du repository : tri `title|artist|duration`,
 * sens `asc|desc`, filtres `favoritesOnly`/`losslessOnly`. Le filtre favoris s'appuie sur
 * `favoriteIds` (ids favoris du store ; défaut : ensemble vide). Départage stable par titre puis id.
 */
export function sortFilterAlbums(
  albums: readonly Album[],
  sf: AlbumSortFilter,
  favoriteIds: ReadonlySet<number> = new Set<number>(),
): Album[] {
  const filtered = albums.filter((a) => {
    if (sf.losslessOnly && !albumIsLossless(a)) return false;
    if (sf.favoritesOnly && !albumIsFavorite(a, favoriteIds)) return false;
    return true;
  });
  const dirMul = sf.dir === "desc" ? -1 : 1;
  const compare = (a: Album, b: Album): number => {
    let base: number;
    switch (sf.sort) {
      case "artist":
        base = a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" });
        break;
      case "duration":
        base = albumDuration(a) - albumDuration(b);
        break;
      default:
        base = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    }
    if (base !== 0) return base * dirMul;
    const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    return byTitle !== 0 ? byTitle : a.id - b.id;
  };
  return [...filtered].sort(compare);
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
      artist: first.artist,
      artKey: withArt?.artKey ?? null,
      tracks: group,
    });
  }
  albums.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  return albums;
}

/** Ordre intra-album : n° de piste (les null a la fin), puis titre, puis id. */
function trackOrder(a: TrackRow, b: TrackRow): number {
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
