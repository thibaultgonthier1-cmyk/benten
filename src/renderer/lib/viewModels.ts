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

/**
 * Date d'ajout réelle d'un album : la plus ancienne date de création (`addedAtMs`) de ses pistes,
 * `null` si aucune n'est connue (repli : `albumAddedKey`, l'ordre d'indexation).
 */
export function albumAddedAt(album: Album): number | null {
  let min: number | null = null;
  for (const t of album.tracks) {
    const at = t.addedAtMs;
    if (at != null && (min === null || at < min)) min = at;
  }
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
 * « Ajouté » du plus récent au plus ancien (date de création des fichiers, `albumAddedAt`, puis
 * ordre d'indexation). Départage stable par titre puis id.
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
  const keyed = shown.map((album) => ({ album, at: albumAddedAt(album), added: albumAddedKey(album) }));
  keyed.sort((x, y) => {
    if (arr.sort === "added" && x.at !== y.at) {
      // Date de création la plus récente d'abord ; un album sans date connue après les autres.
      if (x.at === null) return 1;
      if (y.at === null) return -1;
      return y.at - x.at;
    }
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
 * Trie les titres (pure : l'entrée n'est pas modifiée). `"added"` trie par `addedAtMs` (date de
 * création du fichier : l'ordre d'ajout réel), inconnues en dernier, puis par `id` (ordre
 * d'indexation). Textes comparés en français, insensibles à la casse
 * et aux accents. Égalité → départage stable par `id` croissant, quel que soit le sens.
 */
export function sortTracks(tracks: readonly TrackRow[], key: TrackSortKey, dir: SortDir): TrackRow[] {
  const sign = dir === "desc" ? -1 : 1;
  if (key === "added") {
    // Date de création du fichier (vrai ordre d'ajout), dates inconnues toujours en dernier ;
    // égalité (ou aucune date) → l'id, ordre d'indexation, dans le même sens.
    return tracks.slice().sort((a, b) => {
      const na = a.addedAtMs == null;
      const nb = b.addedAtMs == null;
      if (na !== nb) return na ? 1 : -1;
      return sign * ((a.addedAtMs ?? 0) - (b.addedAtMs ?? 0) || a.id - b.id);
    });
  }
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

/** Écart de durée (s) au-delà duquel deux titres SANS tag sont des morceaux distincts. */
export const SAME_SONG_MAX_DELTA_SEC = 2;

/** Ordre d'ajout : date de création du fichier (inconnues en dernier), puis id. */
const byAddedOrder = (a: TrackRow, b: TrackRow): number => {
  const na = a.addedAtMs == null;
  const nb = b.addedAtMs == null;
  if (na !== nb) return na ? 1 : -1;
  return (a.addedAtMs ?? 0) - (b.addedAtMs ?? 0) || a.id - b.id;
};

/** Durées compatibles d'un même enregistrement (une durée inconnue ne sépare pas). */
const sameLength = (a: TrackRow, b: TrackRow): boolean => {
  const da = safeDuration(a);
  const db = safeDuration(b);
  return da === 0 || db === 0 || Math.abs(da - db) <= SAME_SONG_MAX_DELTA_SEC;
};

/**
 * Regroupe les versions d'un même morceau : clé = `base` normalisée + artiste principal.
 * Deux titres SANS tag de même clé ne sont le même morceau (deux sorties) que si leurs durées
 * diffèrent d'au plus 2 s — deux « Intro » d'un artiste restent deux morceaux ; les versions
 * taguées rejoignent le premier original ajouté. `lead` = l'original ajouté en premier (date de
 * création, puis id), sinon la version ajoutée en premier ; `versions` = les autres, dans l'ordre
 * d'ajout. Les groupes suivent l'ordre d'entrée de leur `lead` (on trie d'abord avec
 * `sortTracks`, puis on regroupe). Rien n'est supprimé : chaque piste est dans un groupe.
 */
export function groupVersions(tracks: readonly TrackRow[]): VersionGroup[] {
  const pos = new Map<number, number>();
  const byKey = new Map<string, { track: TrackRow; tagged: boolean }[]>();
  tracks.forEach((track, i) => {
    pos.set(track.id, i);
    const { base, tag } = versionInfo(track.title);
    const key = `${base}\u0000${primaryArtist(track.artist)}`;
    let members = byKey.get(key);
    if (!members) {
      members = [];
      byKey.set(key, members);
    }
    members.push({ track, tagged: tag !== null });
  });

  const groups: VersionGroup[] = [];
  for (const members of byKey.values()) {
    const originals = members.filter((m) => !m.tagged).map((m) => m.track).sort(byAddedOrder);
    const tagged = members.filter((m) => m.tagged).map((m) => m.track).sort(byAddedOrder);
    // Originaux regroupés par durée compatible avec l'original qui mène chaque grappe.
    const clusters: TrackRow[][] = [];
    for (const t of originals) {
      const c = clusters.find((cl) => sameLength(cl[0]!, t));
      if (c) c.push(t);
      else clusters.push([t]);
    }
    if (clusters.length === 0) clusters.push([tagged.shift()!]);
    clusters[0]!.push(...tagged);
    for (const [lead, ...rest] of clusters) groups.push({ lead: lead!, versions: rest.sort(byAddedOrder) });
  }
  groups.sort((a, b) => pos.get(a.lead.id)! - pos.get(b.lead.id)!);
  return groups;
}

/** La sélection sans `ids` (versions masquées au repli) ; même ensemble si rien ne change. */
export function withoutIds(sel: ReadonlySet<number>, ids: Iterable<number>): ReadonlySet<number> {
  let next: Set<number> | null = null;
  for (const id of ids) {
    if (!sel.has(id)) continue;
    next ??= new Set(sel);
    next.delete(id);
  }
  return next ?? sel;
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

/* ---------------------------------------- Artistes ---------------------------------------- */

/**
 * Clé d'artiste (regroupement, route) : nom replié — casse, accents et espaces ignorés —, comme les
 * crédits : « Beyoncé » et « beyonce » sont le même artiste.
 */
export function artistKey(name: string): string {
  return normalizeText(name);
}

/** Invité : « feat. » / « ft. » / « featuring », collé ou non, éventuellement entre ( ) ou [ ]. */
const FEAT_SPLIT = /\s*[([]?\s*\b(?:featuring|feat|ft)\b\.?\s*/i;
/** Liste : « , » « & », et « x » en minuscule seulement (« DJ X », « Lil Nas X » restent entiers). */
const LIST_SPLIT = /(\s*,\s*|\s*&\s*|\s+x\s+)/;
/** Crochets de bord laissés par le découpage (« Ridsa) » → « Ridsa »). */
const stripBrackets = (s: string): string => s.replace(/^[\s([]+|[\s)\]]+$/g, "").trim();

/** Séparateur canonique entre deux crédits d'une liste (recollage d'une suite de crédits). */
const canonicalSep = (sep: string): string => {
  const t = sep.trim();
  return t === "," ? ", " : t === "&" ? " & " : " x ";
};

/** Une partie « invité » : ses noms (texte d'origine) et les séparateurs qui les relient. */
interface CreditChunk {
  names: string[];
  seps: string[];
}

/** Découpe un champ artiste : parties « feat. », puis listes « , » « & » « x ». */
function creditChunks(artist: string): CreditChunk[] {
  const chunks: CreditChunk[] = [];
  for (const raw of artist.split(FEAT_SPLIT)) {
    const pieces = stripBrackets(raw).split(LIST_SPLIT);
    const names: string[] = [];
    const seps: string[] = [];
    pieces.forEach((p, i) => {
      if (i % 2 === 1) seps.push(p);
      else names.push(stripBrackets(p));
    });
    // Séparateurs autour d'un nom vide (« A, , B ») : retirés avec lui.
    const kept: CreditChunk = { names: [], seps: [] };
    names.forEach((n, i) => {
      if (!n) return;
      if (kept.names.length > 0) kept.seps.push(seps[i - 1] ?? ",");
      kept.names.push(n);
    });
    if (kept.names.length > 0) chunks.push(kept);
  }
  return chunks;
}

/**
 * Index de la bibliothèque pour lever l'ambiguïté des noms à séparateurs : `solo` = noms (repliés)
 * qui apparaissent SEULS comme artiste (d'album ou de titre) quelque part.
 */
export interface ArtistIndex {
  solo: ReadonlySet<string>;
}

export function buildArtistIndex(albums: readonly Album[]): ArtistIndex {
  const solo = new Set<string>();
  const add = (artist: string): void => {
    const chunks = creditChunks(artist);
    if (chunks.length === 1 && chunks[0]!.names.length === 1) solo.add(normalizeText(chunks[0]!.names[0]!));
  };
  for (const a of albums) {
    add(a.artist);
    for (const t of a.tracks) add(t.artist);
  }
  return { solo };
}

/**
 * Crédits d'une partie, texte d'origine. Avec l'index : une paire « A, The B » / « A & The B »
 * (suffixe de groupe « The … ») dont AUCUN des deux n'existe seul dans la bibliothèque est UN nom
 * (« Tyler, The Creator », « Bob Marley & The Wailers ») ; « Doja Cat & The Weeknd » (The Weeknd
 * existe seul) et tout autre duo (« Marshmello & Bastille ») sont des collaborations.
 */
function chunkCredits(chunk: CreditChunk, index?: ArtistIndex): string[] {
  if (
    index &&
    chunk.names.length === 2 &&
    chunk.seps[0]!.trim() !== "x" &&
    /^the\s/i.test(chunk.names[1]!) &&
    !chunk.names.some((n) => index.solo.has(normalizeText(n)))
  ) {
    return [chunk.names[0]! + canonicalSep(chunk.seps[0]!) + chunk.names[1]!];
  }
  return chunk.names;
}

/** Noms crédités (texte d'origine) : principal d'abord, puis invités. */
function creditNames(artist: string, index?: ArtistIndex): string[] {
  return creditChunks(artist).flatMap((c) => chunkCredits(c, index));
}

/**
 * Noms crédités d'un champ artiste, repliés (casse, accents) : « A (feat. B) & C » → a, b, c.
 * `index` (bibliothèque) garde entiers les noms à séparateurs qui ne sont pas des collaborations.
 */
export function creditedArtists(artist: string, index?: ArtistIndex): string[] {
  return [...new Set(creditNames(artist, index).map(normalizeText).filter((n) => n.length > 0))];
}

/** Artiste principal (texte d'origine, sans espaces de bord) : le premier crédité. */
export function primaryCredit(artist: string, index?: ArtistIndex): string {
  return creditNames(artist, index)[0]?.trim() ?? artist.trim();
}

/** Suites d'au moins deux crédits consécutifs recollées (« Above & Beyond »), repliées. */
function creditRuns(artist: string): string[] {
  const runs: string[] = [];
  for (const { names, seps } of creditChunks(artist)) {
    for (let i = 0; i < names.length; i++) {
      let run = names[i]!;
      for (let j = i + 1; j < names.length; j++) {
        run += canonicalSep(seps[j - 1]!) + names[j]!;
        runs.push(normalizeText(run));
      }
    }
  }
  return runs;
}

/** Le champ artiste crédite la clé `key` : nom complet, crédit, ou suite de crédits recollée. */
function credits(artist: string, key: string, index?: ArtistIndex): boolean {
  return (
    normalizeText(artist) === key ||
    creditedArtists(artist, index).includes(key) ||
    creditRuns(artist).includes(key)
  );
}

/**
 * Titres qui créditent l'artiste `name` : principal, invité (« feat. », « & », « x »…) ou nom à
 * séparateurs entier (« Above & Beyond »). Casse et accents ignorés ; ordre d'entrée conservé.
 */
export function artistCredits(tracks: readonly TrackRow[], name: string, index?: ArtistIndex): TrackRow[] {
  const key = artistKey(name);
  if (!key) return [];
  return tracks.filter((t) => credits(t.artist, key, index));
}

export interface ArtistGroup {
  /** Première graphie rencontrée de l'artiste principal. */
  name: string;
  /** Ses albums (dont ses collaborations), dans l'ordre d'entrée. */
  albums: Album[];
  /** Nombre total de titres de ses albums. */
  trackCount: number;
  /** Première pochette disponible (avatar rond), `null` sinon. */
  artKey: string | null;
}

/**
 * Regroupe les albums par artiste PRINCIPAL de l'artiste d'album (`primaryCredit`, clé repliée :
 * casse et accents) : un album « A, B & C » rejoint A (décision de revue : pas de tuile par
 * collaboration). Une compilation (« Various Artists ») est un artiste comme un autre ; les albums
 * sans artiste sont ignorés. Tri alphabétique français. Pure : l'entrée n'est pas modifiée.
 */
export function groupArtists(albums: readonly Album[], index: ArtistIndex = buildArtistIndex(albums)): ArtistGroup[] {
  const byKey = new Map<string, ArtistGroup>();
  for (const album of albums) {
    const primary = primaryCredit(album.artist, index);
    const key = artistKey(primary);
    if (!key) continue;
    let g = byKey.get(key);
    if (!g) {
      g = { name: primary, albums: [], trackCount: 0, artKey: null };
      byKey.set(key, g);
    }
    g.albums.push(album);
    g.trackCount += album.tracks.length;
    g.artKey ??= album.artKey;
  }
  return [...byKey.values()].sort((a, b) => frText(a.name, b.name));
}

export interface ArtistPageModel {
  name: string;
  /** Ses albums (artiste principal, collaborations comprises), du plus récent au plus ancien. */
  albums: Album[];
  /** Albums d'autres artistes où il est crédité (artiste d'album ou titres). */
  appearsOn: Album[];
  /** Tous ses titres (ses albums + ses crédits ailleurs), par date d'ajout croissante. */
  tracks: TrackRow[];
  /** Pochette de l'avatar : celle de `groupArtists` (même tuile ↔ en-tête), sinon une apparition. */
  artKey: string | null;
}

const NO_FAVORITES: ReadonlySet<number> = new Set();
const BY_ADDED: AlbumArrangement = { sort: "added", losslessOnly: false, favoritesOnly: false };

/**
 * Contenu de la page d'un artiste. `name` : nom de la route (casse et accents indifférents) ; un nom
 * de collaboration (« A, B & C », lien d'un album) mène à son artiste principal. Pure.
 */
export function artistPage(
  albums: readonly Album[],
  name: string,
  index: ArtistIndex = buildArtistIndex(albums),
): ArtistPageModel {
  const primary = primaryCredit(name, index);
  const key = artistKey(primary);
  const own: Album[] = [];
  const appears: Album[] = [];
  const credited: TrackRow[] = [];
  for (const album of albums) {
    if (!key) break;
    if (artistKey(primaryCredit(album.artist, index)) === key) {
      own.push(album);
      continue;
    }
    let hits = album.tracks.filter((t) => credits(t.artist, key, index));
    // Crédité sur l'artiste d'album (collaboration) sans l'être sur les titres : tout l'album.
    if (hits.length === 0 && credits(album.artist, key, index)) hits = album.tracks.slice();
    if (hits.length > 0) {
      appears.push(album);
      credited.push(...hits);
    }
  }
  const seen = new Set<number>();
  const all: TrackRow[] = [];
  for (const t of [...own.flatMap((a) => a.tracks), ...credited]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    all.push(t);
  }
  const artKey = own.find((a) => a.artKey)?.artKey ?? appears.find((a) => a.artKey)?.artKey ?? null;
  const ownName = own[0] ? primaryCredit(own[0].artist, index) : "";
  return {
    name: ownName || primary,
    albums: arrangeAlbums(own, BY_ADDED, NO_FAVORITES),
    appearsOn: arrangeAlbums(appears, BY_ADDED, NO_FAVORITES),
    tracks: sortTracks(all, "added", "asc"),
    artKey,
  };
}

/** Alphabet du rail : « # » (chiffres, symboles, autres écritures) puis A–Z. */
export const ALPHABET: readonly string[] = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Lettre d'index d'un nom : sa première lettre sans accent (A–Z), sinon « # ». */
export function artistInitial(name: string): string {
  const c = normalizeText(name).charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

/** Premier index de chaque lettre dans une liste de noms déjà triée. */
export function letterIndex(names: readonly string[]): Map<string, number> {
  const idx = new Map<string, number>();
  names.forEach((name, i) => {
    const l = artistInitial(name);
    if (!idx.has(l)) idx.set(l, i);
  });
  return idx;
}

export interface RailEntry {
  label: string;
  /** Premier artiste de l'entrée ; `null` : aucune (lettre estompée). */
  index: number | null;
}

/**
 * Entrées du rail A–Z pour une liste TRIÉE : « # » là où ces noms se trient vraiment — en tête
 * (chiffres, symboles : avant A) et/ou en fin (autres écritures : après Z) —, puis A–Z.
 */
export function artistRail(names: readonly string[]): RailEntry[] {
  const idx = letterIndex(names);
  const firstLetter = names.findIndex((n) => artistInitial(n) !== "#");
  const leading = names.length > 0 && artistInitial(names[0]!) === "#" ? 0 : null;
  let trailing: number | null = null;
  if (firstLetter >= 0) {
    for (let i = firstLetter; i < names.length; i++) {
      if (artistInitial(names[i]!) === "#") {
        trailing = i;
        break;
      }
    }
  }
  const rail: RailEntry[] = [];
  if (leading !== null) rail.push({ label: "#", index: leading });
  for (const l of ALPHABET.slice(1)) rail.push({ label: l, index: idx.get(l) ?? null });
  if (trailing !== null) rail.push({ label: "#", index: trailing });
  if (leading === null && trailing === null) rail.unshift({ label: "#", index: null });
  return rail;
}

/**
 * File « Lecture » d'un artiste : ses titres dans l'ordre donné ; versions regroupées → un titre
 * par morceau (l'original, pas trois « Slowed » d'affilée).
 */
export function artistQueue(tracks: readonly TrackRow[], grouped: boolean): TrackRow[] {
  return grouped ? groupVersions(tracks).map((g) => g.lead) : tracks.slice();
}

/** Même liste de titres (mêmes ids, même ordre) — la file en cours est-elle celle-ci ? */
export function sameTrackList(a: readonly TrackRow[], b: readonly TrackRow[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}

/**
 * Le bouton lecture d'un artiste affiche « Pause » ssi le lecteur joue SA file — quel que soit
 * l'album du titre courant (une apparition sur l'album d'un autre compte aussi).
 */
export function artistShowsPause(queue: readonly TrackRow[], playing: boolean, list: readonly TrackRow[]): boolean {
  return playing && sameTrackList(queue, list);
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
