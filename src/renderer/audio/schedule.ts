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
