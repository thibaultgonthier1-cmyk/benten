/**
 * Analyse rythmique pour le fondu enchaîné — PUR, sans Web Audio.
 *
 * Objectif : dépasser le fondu « durée fixe » d'Apple Music. Un fondu calé sur le tempo
 * enchaîne sur un temps (ou une phrase de 4/8 temps), et sa durée est un multiple de la noire :
 * l'oreille entend une transition, pas une coupure adoucie.
 *
 * Tout est calculé ici, sur des nombres : le moteur ne reçoit que `{ fadeSec, startAt }`.
 */

/** Enveloppe d'énergie : combien d'échantillons par « point » d'enveloppe. */
const ENVELOPE_RATE = 100; // 100 points/s : assez fin pour situer un temps à ±10 ms

/**
 * Enveloppe d'énergie (somme des carrés par fenêtre), normalisée dans [0,1].
 * Sert de base à la détection de tempo : les attaques y dessinent des pics réguliers.
 */
export function energyEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE));
  const length = Math.floor(samples.length / hop);
  const envelope = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    const start = i * hop;
    const end = Math.min(samples.length, start + hop);
    for (let j = start; j < end; j += 1) {
      const value = samples[j]!;
      sum += value * value;
    }
    envelope[i] = Math.sqrt(sum / Math.max(1, end - start));
  }
  let max = 0;
  for (const value of envelope) if (value > max) max = value;
  if (max > 0) for (let i = 0; i < envelope.length; i += 1) envelope[i] = envelope[i]! / max;
  return envelope;
}

/**
 * Détection de tempo par autocorrélation de l'enveloppe (méthode classique, sans dépendance).
 *
 * On se limite à 60–200 BPM — la plage de la musique écoutée ici — et on renvoie `null` plutôt
 * qu'une valeur douteuse : un faux tempo produirait un fondu mal calé, pire que pas de fondu.
 *
 * @returns BPM arrondi au demi, ou `null` si le signal est trop plat/ambigu.
 */
export function estimateBpm(samples: Float32Array, sampleRate: number): number | null {
  const envelope = energyEnvelope(samples, sampleRate);
  if (envelope.length < ENVELOPE_RATE * 4) return null;

  // Différences positives : on isole les ATTAQUES (le rythme) plutôt que le niveau.
  const onset = new Float32Array(envelope.length);
  for (let i = 1; i < envelope.length; i += 1) {
    onset[i] = Math.max(0, envelope[i]! - envelope[i - 1]!);
  }

  const minLag = Math.round((ENVELOPE_RATE * 60) / 200); // 200 BPM
  const maxLag = Math.round((ENVELOPE_RATE * 60) / 60); // 60 BPM
  let bestLag = 0;
  let bestScore = 0;
  let total = 0;

  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag += 1) {
    let score = 0;
    for (let i = 0; i + lag < onset.length; i += 1) score += onset[i]! * onset[i + lag]!;
    score /= onset.length - lag;
    total += score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === 0) return null;
  const mean = total / Math.max(1, maxLag - minLag + 1);
  // Signal plat (bruit, silence, nappe) : aucun pic net → pas de tempo fiable.
  if (mean <= 0 || bestScore < mean * 2.2) return null;

  const bpm = (ENVELOPE_RATE * 60) / bestLag;
  // Ramène dans 70–180 : l'autocorrélation attrape souvent le double ou la moitié.
  let normalized = bpm;
  while (normalized < 70) normalized *= 2;
  while (normalized > 180) normalized /= 2;
  return Math.round(normalized * 2) / 2;
}

/** Durée d'une noire (s) pour un tempo donné. */
export function beatDuration(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0.5;
  return 60 / bpm;
}

/**
 * Quantifie une durée de fondu sur un nombre ENTIER de temps (ou de phrases de 4 temps).
 *
 * @param fadeSec        Durée souhaitée (s).
 * @param bpm            Tempo de la piste sortante ; `null` → durée inchangée.
 * @param beatsPerPhrase 4 pour caler sur une mesure (défaut), 1 pour caler au temps.
 */
export function quantizeFadeToBeats(fadeSec: number, bpm: number | null, beatsPerPhrase = 4): number {
  const requested = Number.isFinite(fadeSec) && fadeSec > 0 ? fadeSec : 0;
  if (requested === 0) return 0;
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return requested;
  const beat = beatDuration(bpm);
  const unit = beat * Math.max(1, Math.round(beatsPerPhrase));
  const count = Math.max(1, Math.round(requested / unit));
  return count * unit;
}

/**
 * Recule le début du fondu pour tomber sur un temps (ou une phrase) de la piste sortante.
 *
 * @param startTime   Instant-contexte du début de la piste courante (position 0).
 * @param endTime     Instant-contexte de sa fin.
 * @param fadeSec     Durée du fondu (après quantification).
 * @param bpm         Tempo ; `null` → aucun recalage.
 * @param beatsPerPhrase Unité de recalage (4 = mesure).
 * @returns Instant de départ de la piste suivante (jamais avant `startTime`).
 */
export function alignFadeStart(
  startTime: number,
  endTime: number,
  fadeSec: number,
  bpm: number | null,
  beatsPerPhrase = 4,
): number {
  const naive = endTime - fadeSec;
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return Math.max(startTime, naive);
  const unit = beatDuration(bpm) * Math.max(1, Math.round(beatsPerPhrase));
  // Nombre de phrases entières écoulées depuis le début de la piste jusqu'au départ naïf.
  const offset = naive - startTime;
  const phrases = Math.round(offset / unit);
  const aligned = startTime + phrases * unit;
  // On garde la durée demandée : si le recalage avance trop, on recule d'une phrase.
  const candidate = aligned > naive ? aligned - unit : aligned;
  return Math.max(startTime + 0.05, Math.min(candidate, endTime));
}

/**
 * Pondération « bass swap » : sur un vrai mix, on coupe le grave de la piste sortante pendant
 * qu'on amène celui de l'entrante — sinon deux basses superposées produisent une bouillie.
 * Retourne les gains d'un filtre passe-bas (sortant) et passe-haut (entrant) sur [0,1].
 */
export function bassSwapWeights(progress: number): { outgoingLowGain: number; incomingLowGain: number } {
  const t = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  // Sortant : coupé au tiers du fondu ; entrant : rétabli sur la seconde moitié.
  const outgoingLowGain = Math.max(0, 1 - t * 3);
  const incomingLowGain = Math.min(1, Math.max(0, (t - 0.5) * 2));
  return { outgoingLowGain, incomingLowGain };
}
/**
 * Accord de tempo pour un enchaînement « à la DJ ».
 *
 * Apple (AutoMix, iOS 26) fait du *time-stretch* : il change la vitesse SANS changer la hauteur.
 * Ici, on n'a que `playbackRate`, qui change les deux. On s'en sert donc seulement pour de PETITS
 * écarts : jusqu'à 6 %, la dérive de hauteur est perçue comme un « pitch ride » de platine, pas comme
 * une fausse note. Au-delà, on préfère ne rien faire — un morceau faux est pire qu'un tempo libre.
 *
 * @param outgoingBpm Tempo de la piste qui s'arrête.
 * @param incomingBpm Tempo de la piste qui arrive.
 * @param maxRatio    Écart maximal accepté (0,06 = 6 %).
 * @returns Le facteur de vitesse à appliquer à l'entrante (1 = aucun ajustement).
 */
export function tempoMatchRatio(
  outgoingBpm: number | null,
  incomingBpm: number | null,
  maxRatio = 0.06,
): number {
  if (
    outgoingBpm === null ||
    incomingBpm === null ||
    !Number.isFinite(outgoingBpm) ||
    !Number.isFinite(incomingBpm) ||
    outgoingBpm <= 0 ||
    incomingBpm <= 0
  ) {
    return 1;
  }
  const ratio = outgoingBpm / incomingBpm;
  const limit = Math.max(0, maxRatio);
  if (Math.abs(ratio - 1) > limit) return 1; // trop loin : on laisse la piste à son tempo
  return Math.round(ratio * 1000) / 1000;
}

/** Vrai si les deux tempos peuvent être accordés sans déformer sensiblement la hauteur. */
export function canTempoMatch(outgoingBpm: number | null, incomingBpm: number | null, maxRatio = 0.06): boolean {
  return tempoMatchRatio(outgoingBpm, incomingBpm, maxRatio) !== 1;
}
