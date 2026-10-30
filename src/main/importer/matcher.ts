import type { TrackRow } from "../../shared/types";
import type { ImportedTrack } from "./applePlaylist";

/**
 * Rapprochement entre un export et la bibliothèque locale.
 *
 * Deux étages, dans cet ordre :
 * 1. **exact** sur `clé(titre) + clé(artiste)` — c'est le cas courant, et il ne doit jamais être
 *    perdu par un score de similarité ;
 * 2. **similarité** (Dice sur bigrammes) : titre ≥ 0,82 et artiste ≥ 0,6, l'écart de durée
 *    départageant les ex æquo.
 *
 * L'ordre d'entrée est conservé : la playlist se reconstruit comme dans Apple Music.
 */

/** Minuscules, sans accents, sans ponctuation, sans « feat. », sans (Slowed) / [Remastered]. */
export function normalizeKey(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\((?:[^()]*)\)/g, " ")
    .replace(/\[(?:[^[\]]*)\]/g, " ")
    .replace(/\b(?:feat|ft|featuring)\b\.?\s+.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Coefficient de Dice sur les bigrammes (0 → 1). Deux chaînes vides valent 1. */
export function diceSimilarity(a: string, b: string): number {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (!left && !right) return 1;
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      hits += 1;
      bigrams.set(gram, count - 1);
    }
  }
  return (2 * hits) / (left.length - 1 + (right.length - 1));
}

const TITLE_MIN = 0.82;
const ARTIST_MIN = 0.6;

export interface MatchResult {
  imported: ImportedTrack;
  track: TrackRow | null;
  score: number;
}

/** Durée de la piste locale, en secondes (champ `durationSec`, sinon 0). */
function durationOf(track: TrackRow): number {
  return typeof track.durationSec === "number" && track.durationSec > 0 ? track.durationSec : 0;
}

export function matchTracks(
  imported: readonly ImportedTrack[],
  library: readonly TrackRow[],
): MatchResult[] {
  const exact = new Map<string, TrackRow>();
  const byTitle = new Map<string, TrackRow[]>();

  for (const track of library) {
    const key = `${normalizeKey(track.title)}|${normalizeKey(track.artist)}`;
    if (!exact.has(key)) exact.set(key, track);
    const titleKey = normalizeKey(track.title);
    const list = byTitle.get(titleKey);
    if (list) list.push(track);
    else byTitle.set(titleKey, [track]);
  }

  return imported.map((item) => {
    const key = `${normalizeKey(item.title)}|${normalizeKey(item.artist)}`;
    const hit = exact.get(key);
    if (hit) return { imported: item, track: hit, score: 1 };

    const itemTitle = normalizeKey(item.title);
    const itemArtist = normalizeKey(item.artist);
    // Candidats : même titre normalisé d'abord, sinon tous les titres proches.
    const pool = byTitle.get(itemTitle) ?? library;
    let best: { track: TrackRow; score: number } | null = null;

    for (const candidate of pool) {
      const titleScore = diceSimilarity(itemTitle, normalizeKey(candidate.title));
      if (titleScore < TITLE_MIN) continue;
      const artistScore = itemArtist ? diceSimilarity(itemArtist, normalizeKey(candidate.artist)) : 1;
      if (itemArtist && artistScore < ARTIST_MIN) continue;
      const score = titleScore * 0.7 + artistScore * 0.3;
      if (!best || score > best.score) best = { track: candidate, score };
    }

    if (best) return { imported: item, track: best.track, score: best.score };

    // Dernier recours : titre identique, artiste différent — départagé par la durée.
    const sameTitle = byTitle.get(itemTitle);
    if (sameTitle && sameTitle.length > 0) {
      const withDuration = sameTitle
        .map((track) => ({
          track,
          delta: item.durationSec ? Math.abs(durationOf(track) - item.durationSec) : 0,
        }))
        .sort((a, b) => a.delta - b.delta);
      return { imported: item, track: withDuration[0]!.track, score: 0.7 };
    }

    return { imported: item, track: null, score: 0 };
  });
}
