/**
 * Persistance de l'etat de lecture — PUR (aucune dependance React / Web Audio / window), donc
 * testable hors composant. `serializeState` reduit un instantane du store a un objet serialisable
 * (`PersistedState`) ; `restoreState` reconstruit cet objet depuis la chaine JSON lue en base en
 * VALIDANT chaque champ (type + bornes). Toute entree malformee ou aberrante donne `null` (jamais
 * d'exception) ; les valeurs numeriques hors bornes sont ASSAINIES plutot que crues (clamp), et les
 * entrees non entieres de `queueTrackIds` sont filtrees. On ne fait jamais confiance au disque.
 */

import type { RepeatMode } from "../audio/order";
import type { QualityMode } from "../../shared/types";

/** Etat de lecture persiste (une ligne `app_state`, cle `"player"`). */
export interface PersistedState {
  /** Ids des pistes de la file, dans l'ordre (re-resolus en `TrackRow` au demarrage). */
  queueTrackIds: number[];
  /** Index de la piste courante dans la file (−1 si aucune). */
  currentIndex: number;
  /** Position de lecture memorisee (s, >= 0). */
  positionSec: number;
  /** Lecture aleatoire. */
  shuffle: boolean;
  /** Mode de repetition. */
  repeat: RepeatMode;
  /** Volume utilisateur [0,1]. */
  volume: number;
  /** Mode de qualite. */
  qualityMode: QualityMode;
  /** Vue « lecture plein ecran » ouverte. */
  nowPlayingOpen: boolean;
}

/**
 * Instantane minimal du store passe a `serializeState` (les champs, pas le store lui-meme : pas
 * d'import React). `queue` n'a besoin que de l'`id` de chaque piste.
 */
export interface StateSnapshot {
  queue: readonly { id: number }[];
  currentIndex: number;
  positionSec: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  qualityMode: QualityMode;
  nowPlayingOpen: boolean;
}

const REPEAT_MODES: readonly RepeatMode[] = ["off", "all", "one"];
const QUALITY_MODES: readonly QualityMode[] = ["max", "balanced", "economy"];

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Construit l'objet persistable depuis un instantane du store (file -> liste d'ids). */
export function serializeState(snap: StateSnapshot): PersistedState {
  return {
    queueTrackIds: snap.queue.map((t) => t.id),
    currentIndex: snap.currentIndex,
    positionSec: snap.positionSec,
    shuffle: snap.shuffle,
    repeat: snap.repeat,
    volume: snap.volume,
    qualityMode: snap.qualityMode,
    nowPlayingOpen: snap.nowPlayingOpen,
  };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Reconstruit (et VALIDE) un `PersistedState` depuis la chaine JSON brute. Renvoie `null` pour tout
 * ce qui est inexploitable : JSON invalide, racine non-objet, champ de mauvais type, ou valeur
 * d'enumeration inconnue. Les champs numeriques hors bornes sont assainis (clamp), jamais rejetes
 * pour ce seul motif ; `queueTrackIds` est filtre pour ne garder que des entiers finis. Ne LEVE
 * JAMAIS.
 */
export function restoreState(raw: string): PersistedState | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  // queueTrackIds : tableau ; on FILTRE les entrees non entieres finies (assainissement).
  if (!Array.isArray(o["queueTrackIds"])) return null;
  const queueTrackIds = (o["queueTrackIds"] as unknown[]).filter(
    (x): x is number => typeof x === "number" && Number.isInteger(x),
  );

  // currentIndex : entier ; borne a [-1, len-1] (−1 = aucune piste).
  if (typeof o["currentIndex"] !== "number" || !Number.isInteger(o["currentIndex"])) return null;
  const len = queueTrackIds.length;
  const currentIndex = len === 0 ? -1 : clamp(o["currentIndex"], -1, len - 1);

  // positionSec : nombre fini >= 0 (clamp du negatif a 0).
  if (!isFiniteNumber(o["positionSec"])) return null;
  const positionSec = Math.max(0, o["positionSec"]);

  if (typeof o["shuffle"] !== "boolean") return null;
  const shuffle = o["shuffle"];

  if (typeof o["repeat"] !== "string" || !REPEAT_MODES.includes(o["repeat"] as RepeatMode)) {
    return null;
  }
  const repeat = o["repeat"] as RepeatMode;

  // volume : nombre fini, assaini dans [0,1].
  if (!isFiniteNumber(o["volume"])) return null;
  const volume = clamp(o["volume"], 0, 1);

  if (
    typeof o["qualityMode"] !== "string" ||
    !QUALITY_MODES.includes(o["qualityMode"] as QualityMode)
  ) {
    return null;
  }
  const qualityMode = o["qualityMode"] as QualityMode;

  if (typeof o["nowPlayingOpen"] !== "boolean") return null;
  const nowPlayingOpen = o["nowPlayingOpen"];

  return { queueTrackIds, currentIndex, positionSec, shuffle, repeat, volume, qualityMode, nowPlayingOpen };
}
