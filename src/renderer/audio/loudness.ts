/**
 * Égalisation de niveau pour le fondu enchaîné.
 *
 * Un DJ ne se contente pas de croiser deux morceaux : il ajuste le niveau de celui qui arrive pour
 * qu'il sonne aussi fort que celui qui part. Sans ça, un titre masterisé fort écrase un titre calme
 * et l'enchaînement paraît brutal — c'est le défaut le plus audible d'un fondu « naïf ».
 *
 * Apple le fait via « Sound Check » (normalisation de sonie). Ici, on mesure l'énergie efficace
 * (RMS) des deux tampons déjà décodés et on corrige l'entrant d'un gain borné.
 */

/** Niveau efficace d'un signal, dans [0, ~1]. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]!;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Gain à appliquer à la piste ENTRANTE pour égaler le niveau de la sortante.
 *
 * @param outgoing Rms de la piste qui s'arrête.
 * @param incoming Rms de la piste qui arrive.
 * @param maxDb    Correction maximale (6 dB par défaut) : au-delà, on ne corrige plus, on
 *                 laisserait un morceau sonner faux ou mou. Le silence n'est jamais corrigé.
 * @returns un facteur multiplicatif dans [1/limite, limite].
 */
export function loudnessGain(outgoing: number, incoming: number, maxDb = 6): number {
  if (!Number.isFinite(outgoing) || !Number.isFinite(incoming)) return 1;
  if (outgoing <= 0.0001 || incoming <= 0.0001) return 1; // silence ou quasi : rien à égaliser
  const limit = Math.pow(10, maxDb / 20); // 6 dB ≈ 2× ou 0,5×
  const ratio = outgoing / incoming;
  return Math.min(limit, Math.max(1 / limit, ratio));
}

/** Vrai si les deux niveaux diffèrent assez pour justifier une correction. */
export function needsLoudnessMatch(outgoing: number, incoming: number, maxDb = 6): boolean {
  const gain = loudnessGain(outgoing, incoming, maxDb);
  // Moins de 0,5 dB d'écart : inaudible, on ne touche pas à la source.
  return Math.abs(gain - 1) > 0.06;
}

