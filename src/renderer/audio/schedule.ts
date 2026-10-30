/**
 * Math de planification du gapless — PURE, sans aucune dependance Web Audio.
 *
 * Toute la logique "a l'echantillon pres" vit ici pour etre testee sans contexte audio.
 * Le moteur l'applique sur l'horloge partagee `AudioContext.currentTime` : comme toute la
 * bibliotheque est en 44.1 kHz (et que `decodeAudioData` reechantillonne de toute facon tout
 * le monde au taux du contexte), la jointure ne demande aucune gymnastique de reechantillonnage —
 * juste une addition sur l'horloge commune.
 */

/**
 * Instant-contexte (s) ou la piste suivante doit demarrer pour s'enchainer sans le moindre trou :
 * exactement la fin de la piste courante.
 *
 * @param prevStartTime   Instant-contexte ou la position 0 de la piste courante serait tombee
 *                        (= `startedAtCtxTime - startOffsetSec`). Pour un demarrage a l'offset 0,
 *                        c'est simplement l'instant du `start()`.
 * @param prevDurationSec Duree totale de la piste courante (depuis son `AudioBuffer`).
 * @returns `prevStartTime + prevDurationSec` ; repli sur `prevStartTime` fini si une entree ne
 *          l'est pas (on ne renvoie jamais `NaN`, qui empoisonnerait `source.start(when)`).
 */
export function nextStartTime(prevStartTime: number, prevDurationSec: number): number {
  const base = Number.isFinite(prevStartTime) ? prevStartTime : 0;
  const dur = Number.isFinite(prevDurationSec) ? prevDurationSec : 0;
  return base + dur;
}

/**
 * Faut-il deja precharger (decoder) la piste suivante ? Vrai des que le temps restant sur la
 * piste courante passe sous `leadSec` — assez tot pour que le decodage soit termine avant la fin.
 *
 * @param positionSec  Position de lecture courante (s).
 * @param durationSec  Duree totale de la piste courante (s).
 * @param leadSec      Marge d'avance souhaitee (s).
 * @returns `true` si `durationSec - positionSec < leadSec`. Entrees non finies -> `false`
 *          (on ne declenche pas de prechargement sur une mesure douteuse).
 */
export function shouldPreload(positionSec: number, durationSec: number, leadSec: number): boolean {
  if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec) || !Number.isFinite(leadSec)) {
    return false;
  }
  return durationSec - positionSec < leadSec;
}

/**
 * Fondu enchaîné — même horloge que le gapless, un paramètre de plus.
 *
 * Le principe tient en une phrase : là où le gapless démarre la piste suivante à la FIN de la
 * courante, le fondu la démarre `fadeSec` PLUS TÔT, et pendant ce recouvrement les deux pistes
 * ont chacune leur gain qui bouge en sens inverse.
 *
 * Toute la décision est ici, pure : le moteur ne fait qu'appliquer des nombres.
 */

/** Fondu désactivé en dessous de cette durée (en dessous, l'oreille n'entend qu'un trou). */
export const MIN_CROSSFADE_SEC = 0.5;
/** Au-delà, le recouvrement mangerait la moitié des morceaux courts. */
export const MAX_CROSSFADE_SEC = 12;

/** Durée de fondu réellement utilisable (0 = pas de fondu). */
export function normalizeCrossfade(value: number | null | undefined): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_CROSSFADE_SEC, Math.max(MIN_CROSSFADE_SEC, seconds));
}

/**
 * Instant-contexte où démarrer la piste suivante.
 *
 * @param endTime  Fin exacte de la piste courante (gapless : c'est aussi son départ).
 * @param fadeSec  Durée du fondu ; 0 → comportement gapless inchangé.
 * @param startTime Instant où la piste courante a démarré (position 0) : sert de borne basse pour
 *                  ne jamais programmer un départ dans le passé sur un morceau plus court que le
 *                  fondu.
 */
export function crossfadeStartTime(endTime: number, fadeSec: number, startTime = 0): number {
  const end = Number.isFinite(endTime) ? endTime : 0;
  const fade = normalizeCrossfade(fadeSec);
  if (fade === 0) return end;
  const earliest = (Number.isFinite(startTime) ? startTime : 0) + 0.05;
  return Math.max(earliest, end - fade);
}

/**
 * Gains des deux pistes pendant le fondu, à une fraction `progress` (0 = début, 1 = fin).
 * Courbe en cosinus (fondu « égal puissance ») : la somme des carrés vaut 1, donc le volume
 * perçu reste constant — c'est ce qui distingue un vrai fondu d'une simple baisse de volume.
 */
export function crossfadeGains(progress: number): { current: number; next: number } {
  const t = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return {
    current: Math.cos((t * Math.PI) / 2),
    next: Math.sin((t * Math.PI) / 2),
  };
}

/** Faut-il armer le fondu maintenant (il reste `fadeSec` ou moins sur la piste courante) ? */
export function shouldArmCrossfade(
  positionSec: number,
  durationSec: number,
  fadeSec: number,
  leadSec = 0.3,
): boolean {
  const fade = normalizeCrossfade(fadeSec);
  if (fade === 0) return false;
  if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec)) return false;
  if (durationSec <= 0) return false;
  const remaining = durationSec - positionSec;
  // On arme un peu avant le début du fondu : la rampe est PROGRAMMÉE sur l'horloge audio, donc
  // être en avance ne change rien au résultat — être en retard, si.
  return remaining <= fade + leadSec;
}
