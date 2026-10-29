/**
 * Modèles de vue (Phase 3, Tâche 6) — fonctions PURES consommées par les écrans Albums / Album :
 * résumé d'album, groupes par disque, durée totale lisible, tri/filtre de la grille et calcul de
 * colonnes. Aucune dépendance React ni DOM : tout est testé en node.
 */

import type { TrackRow } from "../../shared/types";
import type { PlaybackStatus } from "../audio/engine";
import { describeQuality, type Album } from "./library";

/* ------------------------------------- Résumé d'album ------------------------------------- */

export interface AlbumSummary {
  trackCount: number;
  totalSec: number;
  /** Libellé `describeQuality` de la piste de plus haute qualité ; `""` pour un album vide. */
  quality: string;
}

/**
 * Rang de qualité d'une piste : sans perte d'abord, puis profondeur de bits, puis fréquence.
 * Comparaison lexicographique de ce triplet.
 */
function qualityRank(t: Pick<TrackRow, "bitDepth" | "sampleRate">): [number, number, number] {
  const bits = t.bitDepth != null && t.bitDepth > 0 ? t.bitDepth : 0;
  return [bits > 0 ? 1 : 0, bits, t.sampleRate ?? 0];
}

function betterQuality(a: TrackRow, b: TrackRow): boolean {
  const ra = qualityRank(a);
  const rb = qualityRank(b);
  for (let i = 0; i < 3; i++) {
    if (ra[i]! !== rb[i]!) return ra[i]! > rb[i]!;
  }
  return false;
}

const safeDuration = (t: TrackRow): number =>
  Number.isFinite(t.durationSec) && t.durationSec > 0 ? t.durationSec : 0;

/** Nombre de titres, durée totale (s) et qualité la plus haute de l'album. */
export function albumSummary(album: Album): AlbumSummary {
  let best: TrackRow | null = null;
  let totalSec = 0;
  for (const t of album.tracks) {
    totalSec += safeDuration(t);
    if (!best || betterQuality(t, best)) best = t;
  }
  return {
    trackCount: album.tracks.length,
    totalSec,
    quality: best ? describeQuality(best).label : "",
  };
}

/** Ligne d'en-tête : « 12 titres · 42 min · FLAC · 24-bit/44.1 kHz ». */
export function summaryLine(album: Album): string {
  const s = albumSummary(album);
  const parts = [`${s.trackCount} ${s.trackCount > 1 ? "titres" : "titre"}`, formatTotal(s.totalSec)];
  if (s.quality) parts.push(s.quality);
  return parts.join(" · ");
}

/* -------------------------------------- Durée totale -------------------------------------- */

/** Durée totale lisible : « 42 min » sous l'heure, « 1 h 05 » au-delà (minutes arrondies). */
export function formatTotal(sec: number): string {
  const minutes = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${String(minutes % 60).padStart(2, "0")}`;
}

/* ------------------------------------ Groupes par disque ------------------------------------ */

export interface DiscGroup {
  /** Numéro de disque, `null` pour les pistes sans tag de disque. */
  disc: number | null;
  tracks: TrackRow[];
}

/**
 * Regroupe les pistes par numéro de disque. L'ordre est préservé : les groupes apparaissent dans
 * l'ordre de leur première piste, les pistes gardent leur ordre d'entrée. Sans aucun `discNo`,
 * un seul groupe `disc: null`.
 */
export function discGroups(tracks: readonly TrackRow[]): DiscGroup[] {
  const groups: DiscGroup[] = [];
  const byDisc = new Map<number | null, DiscGroup>();
  for (const t of tracks) {
    const disc = t.discNo ?? null;
    let g = byDisc.get(disc);
    if (!g) {
      g = { disc, tracks: [] };
      byDisc.set(disc, g);
      groups.push(g);
    }
    g.tracks.push(t);
  }
  return groups;
}

/* ---------------------------------- Tri / filtres de grille ---------------------------------- */

export type AlbumSort = "title" | "artist" | "added";

export const ALBUM_SORTS: ReadonlyArray<{ value: AlbumSort; label: string }> = [
  { value: "added", label: "Ajouté" },
  { value: "title", label: "Titre" },
  { value: "artist", label: "Artiste" },
];

export interface AlbumArrangement {
  sort: AlbumSort;
  losslessOnly: boolean;
  favoritesOnly: boolean;
}

/**
 * Clé du tri « Ajouté » : le plus petit id de piste de l'album. Les ids sont attribués à
 * l'insertion (AUTOINCREMENT de la table `tracks`) : le plus petit id est donc l'ordre dans lequel
 * l'album est entré dans la bibliothèque. Album vide : +∞ (en dernier).
 */
export function albumAddedKey(album: Album): number {
  let min = Number.POSITIVE_INFINITY;
  for (const t of album.tracks) if (t.id < min) min = t.id;
  return min;
}

/** Un album est favori dès qu'une de ses pistes l'est (même règle que le menu contextuel). */
export function albumIsFavorite(album: Album, favoriteIds: ReadonlySet<number>): boolean {
  return album.tracks.some((t) => favoriteIds.has(t.id));
}

/** Album « sans perte » : au moins une piste avec une profondeur de bits connue. */
export function albumIsLossless(album: Album): boolean {
  return album.tracks.some((t) => t.bitDepth != null && t.bitDepth > 0);
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * Filtre puis trie les albums (pure : l'entrée n'est pas modifiée). Titre / Artiste croissants,
 * « Ajouté » du plus récent au plus ancien. Départage stable par titre puis id.
 */
export function arrangeAlbums(
  albums: readonly Album[],
  arr: AlbumArrangement,
  favoriteIds: ReadonlySet<number>,
): Album[] {
  const shown = albums.filter(
    (a) =>
      (!arr.losslessOnly || albumIsLossless(a)) && (!arr.favoritesOnly || albumIsFavorite(a, favoriteIds)),
  );
  const keyed = shown.map((album) => ({ album, added: albumAddedKey(album) }));
  keyed.sort((x, y) => {
    if (arr.sort === "added" && x.added !== y.added) {
      // Plus récent (plus grand id) d'abord ; un album vide (+∞) toujours en dernier.
      if (x.added === Infinity) return 1;
      if (y.added === Infinity) return -1;
      return y.added - x.added;
    }
    if (arr.sort === "artist") {
      const base = byText(x.album.artist, y.album.artist);
      if (base !== 0) return base;
    }
    return byText(x.album.title, y.album.title) || x.album.id - y.album.id;
  });
  return keyed.map((k) => k.album);
}

/* ------------------------------------- Lecture / pause ------------------------------------- */

/**
 * Le bouton lecture d'un album (ou d'un titre) DÉJÀ courant bascule lecture/pause seulement si la
 * piste peut reprendre en l'état. Après une erreur, en fin de file ou sans piste chargée, la
 * bascule ne ferait rien : on relance alors l'album (nouveau chargement).
 */
export function canResume(status: PlaybackStatus): boolean {
  return status === "playing" || status === "paused" || status === "ready" || status === "loading";
}

/* ----------------------------------------- Grille ----------------------------------------- */

/**
 * Plafond de colonnes : au-delà, ce sont les tuiles qui grandissent (grand écran / 4K). Garde le
 * DOM de la grille virtualisée sous ~120 tuiles et la pochette lisible.
 */
export const GRID_MAX_COLS = 8;

/**
 * Colonnes et largeur de tuile pour une largeur de conteneur (reproduit `auto-fill minmax(min,1fr)`
 * avec une gouttière `gap`, plafonné à `maxCols`). Largeur nulle (pas encore mesurée) : une
 * colonne de `min` px.
 */
export function gridLayout(
  width: number,
  min: number,
  gap: number,
  maxCols: number = GRID_MAX_COLS,
): { cols: number; cardW: number } {
  if (!(width > 0)) return { cols: 1, cardW: min };
  const cols = Math.max(1, Math.min(maxCols, Math.floor((width + gap) / (min + gap))));
  return { cols, cardW: Math.floor((width - gap * (cols - 1)) / cols) };
}
