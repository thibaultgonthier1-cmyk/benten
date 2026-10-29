/**
 * Modèles de vue (Phase 3, Tâches 6–7) — fonctions PURES consommées par les écrans Albums / Album
 * / Titres : résumé d'album, groupes par disque, durée totale lisible, tri/filtre de la grille,
 * calcul de colonnes, tri des titres, multi-sélection et regroupement des versions d'un morceau.
 * Aucune dépendance React ni DOM : tout est testé en node.
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

/* --------------------------------------- Vue Titres --------------------------------------- */

export type TrackSortKey = "added" | "title" | "artist" | "album" | "duration";
export type SortDir = "asc" | "desc";

const frText = (a: string, b: string): number => a.localeCompare(b, "fr", { sensitivity: "base" });

/** Ordre d'un titre dans son album (disque puis n° de piste ; absents en dernier). */
const inAlbumOrder = (a: TrackRow, b: TrackRow): number =>
  (a.discNo ?? Infinity) - (b.discNo ?? Infinity) || (a.trackNo ?? Infinity) - (b.trackNo ?? Infinity) || 0;

/**
 * Comparateur de la clé (sens croissant) ; 0 en cas d'égalité. Comme Apple Music, l'artiste se
 * départage par album puis ordre de l'album, et l'album par l'ordre de ses pistes.
 */
function primaryCompare(key: TrackSortKey, a: TrackRow, b: TrackRow): number {
  switch (key) {
    case "added":
      return a.id - b.id;
    case "title":
      return frText(a.title, b.title);
    case "artist":
      return frText(a.artist, b.artist) || frText(a.album, b.album) || inAlbumOrder(a, b);
    case "album":
      return frText(a.album, b.album) || inAlbumOrder(a, b);
    case "duration":
      return safeDuration(a) - safeDuration(b);
  }
}

/**
 * Trie les titres (pure : l'entrée n'est pas modifiée). `"added"` trie par `id` (les ids sont
 * attribués à l'indexation : ordre d'ajout). Textes comparés en français, insensibles à la casse
 * et aux accents. Égalité → départage stable par `id` croissant, quel que soit le sens.
 */
export function sortTracks(tracks: readonly TrackRow[], key: TrackSortKey, dir: SortDir): TrackRow[] {
  const sign = dir === "desc" ? -1 : 1;
  return tracks.slice().sort((a, b) => sign * primaryCompare(key, a, b) || a.id - b.id);
}

/**
 * Sélection après un clic sur la ligne `index` : clic simple = sélection unique ; Ctrl = bascule
 * de la ligne ; Maj = plage depuis l'ancre (remplace la sélection ; Ctrl+Maj l'ajoute). L'ancre
 * suit le clic, sauf en Maj (elle reste le point de départ de la plage). Pure.
 */
export function selectionAfterClick(
  sel: ReadonlySet<number>,
  index: number,
  mods: { shift: boolean; ctrl: boolean },
  anchor: number | null,
): { sel: Set<number>; anchor: number } {
  if (mods.shift) {
    const from = anchor ?? index;
    const next = mods.ctrl ? new Set(sel) : new Set<number>();
    const [lo, hi] = from <= index ? [from, index] : [index, from];
    for (let i = lo; i <= hi; i++) next.add(i);
    return { sel: next, anchor: from };
  }
  if (mods.ctrl) {
    const next = new Set(sel);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return { sel: next, anchor: index };
  }
  return { sel: new Set([index]), anchor: index };
}

/* --------------------------------- Versions d'un même morceau --------------------------------- */

/** Minuscules, sans accents ni espaces superflus (comparaison seulement, jamais affiché). */
function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’′]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mots-clés de version, en mots entiers sur le texte normalisé. « slowed » couvre super / ultra /
 * over / mega / extreme(ly) slowed et « slowed to perfection » ; « edit » couvre « radio edit » ;
 * « version » couvre « Tiktok Version », « Vocal Version »…
 */
const VERSION_RE =
  /\b(?:slowed|sped up|speed up|nightcore|reverb(?:ed)?|remix(?:ed)?|vip mix|edit|extended|instrumental|acoustic|live|version|remaster(?:ed)?)\b/;

const isVersionLabel = (label: string): boolean => VERSION_RE.test(normalizeText(label));

const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[" };
/** Séparateurs d'un suffixe « Titre - Version » (tiret, demi-cadratin, cadratin). */
const DASH_RE = /\s[-–—]\s/g;

/**
 * Découpe un titre en nom (texte d'origine, sans les suffixes de version) et suffixes de version
 * (`tags`, dans l'ordre du titre). Les suffixes sans mot-clé restent dans le nom, à leur place.
 */
function splitVersion(title: string): { name: string; tags: string[] } {
  let rest = title.trim();
  const kept: string[] = [];
  const tags: string[] = [];
  for (;;) {
    const last = rest.at(-1);
    const opener = last ? CLOSERS[last] : undefined;
    if (opener) {
      // Parenthèse ouvrante correspondante (imbrication tolérée).
      let depth = 0;
      let open = -1;
      for (let i = rest.length - 1; i >= 0; i--) {
        const c = rest[i]!;
        if (c === last) depth++;
        else if (c === opener && --depth === 0) {
          open = i;
          break;
        }
      }
      if (open <= 0) break; // non appariée, ou le titre entier est entre parenthèses
      const inner = rest.slice(open + 1, -1).trim();
      const segment = rest.slice(open);
      rest = rest.slice(0, open).trimEnd();
      if (inner && isVersionLabel(inner)) tags.unshift(inner);
      else kept.unshift(segment);
      continue;
    }
    // Suffixe « Titre - Version » : le dernier séparateur seulement.
    let cut = -1;
    let sepLen = 0;
    for (const m of rest.matchAll(DASH_RE)) {
      cut = m.index ?? -1;
      sepLen = m[0].length;
    }
    if (cut > 0) {
      const segment = rest.slice(cut + sepLen).trim();
      if (segment && isVersionLabel(segment)) {
        tags.unshift(segment);
        rest = rest.slice(0, cut).trimEnd();
        continue;
      }
    }
    break;
  }
  const name = [rest, ...kept].join(" ").trim();
  // Un titre entièrement « version » (« (Slowed) ») n'a pas de nom : ce n'est pas une version.
  return name ? { name, tags } : { name: title.trim(), tags: [] };
}

/**
 * Détache les suffixes de version d'un titre : groupes `( )` / `[ ]` en fin de titre ou segment
 * après « - », s'ils contiennent un mot-clé de version. Plusieurs suffixes cumulés sont tous
 * détachés (`tag` = leur concaténation « A · B ») ; un suffixe sans mot-clé (« (feat. X) »,
 * « (Deluxe) », « - Pt. 2 ») n'est pas une version et reste dans `base`. `base` est normalisée
 * (casse, accents, espaces) pour la comparaison ; le titre affiché reste l'original.
 */
export function versionInfo(title: string): { base: string; tag: string | null } {
  const { name, tags } = splitVersion(title);
  return { base: normalizeText(name), tag: tags.length > 0 ? tags.join(" · ") : null };
}

/**
 * Nom d'un titre sans ses suffixes de version, casse et accents d'origine (« LUZ ROJA (Slowed) »
 * → « LUZ ROJA ») : libellé d'une sous-ligne de version, à côté de sa pastille.
 */
export function versionName(title: string): string {
  return splitVersion(title).name;
}

/** Artiste principal : premier nom avant « , » « & » « feat » « ft. » « x », normalisé. */
export function primaryArtist(artist: string): string {
  const first = artist.split(/\s*,\s*|\s*&\s*|\s+(?:feat\.?|ft\.|featuring)\s+|\s+x\s+/i)[0] ?? "";
  return normalizeText(first);
}

export interface VersionGroup {
  lead: TrackRow;
  versions: TrackRow[];
}

/**
 * Regroupe les versions d'un même morceau : clé = `base` normalisée + artiste principal.
 * `lead` = la piste sans tag (plusieurs : plus petit `id`), sinon le plus petit `id` ; `versions`
 * = les autres, par `id`. Les groupes suivent l'ordre d'entrée de leur `lead` (on trie d'abord
 * avec `sortTracks`, puis on regroupe). Rien n'est supprimé : chaque piste est dans un groupe.
 */
export function groupVersions(tracks: readonly TrackRow[]): VersionGroup[] {
  interface Acc {
    members: { track: TrackRow; pos: number; tagged: boolean }[];
  }
  const byKey = new Map<string, Acc>();
  tracks.forEach((track, pos) => {
    const { base, tag } = versionInfo(track.title);
    const key = `${base}\u0000${primaryArtist(track.artist)}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = { members: [] };
      byKey.set(key, acc);
    }
    acc.members.push({ track, pos, tagged: tag !== null });
  });

  const groups: { group: VersionGroup; pos: number }[] = [];
  for (const { members } of byKey.values()) {
    let lead = members[0]!;
    for (const m of members) {
      const better = lead.tagged !== m.tagged ? !m.tagged : m.track.id < lead.track.id;
      if (better) lead = m;
    }
    const versions = members
      .filter((m) => m !== lead)
      .map((m) => m.track)
      .sort((a, b) => a.id - b.id);
    groups.push({ group: { lead: lead.track, versions }, pos: lead.pos });
  }
  groups.sort((a, b) => a.pos - b.pos);
  return groups.map((g) => g.group);
}

/** Ligne affichée de la vue Titres regroupée (lead ou version dépliée). */
export interface VersionRow {
  track: TrackRow;
  /** 0 : lead (ou titre seul) ; 1 : version dépliée, indentée sous son lead. */
  depth: 0 | 1;
  /** Id du lead du groupe (clé de l'état déplié). */
  groupId: number;
  /** Nombre de versions du groupe (sur la ligne du lead ; 0 pour une version). */
  versionCount: number;
  /** Ligne de lead dont les versions sont dépliées. */
  expanded: boolean;
  /** Pastille de version (lignes de version). */
  tag: string | null;
}

/**
 * Aplatit les groupes en lignes affichées (virtualisation) : chaque lead, suivi de ses versions
 * si son groupe est déplié (`expanded` contient l'id du lead).
 */
export function versionRows(groups: readonly VersionGroup[], expanded: ReadonlySet<number>): VersionRow[] {
  const rows: VersionRow[] = [];
  for (const g of groups) {
    const open = g.versions.length > 0 && expanded.has(g.lead.id);
    rows.push({
      track: g.lead,
      depth: 0,
      groupId: g.lead.id,
      versionCount: g.versions.length,
      expanded: open,
      tag: null,
    });
    if (!open) continue;
    for (const v of g.versions) {
      rows.push({
        track: v,
        depth: 1,
        groupId: g.lead.id,
        versionCount: 0,
        expanded: false,
        tag: versionInfo(v.title).tag,
      });
    }
  }
  return rows;
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
