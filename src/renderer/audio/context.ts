/**
 * Fabrique UNIQUE des `AudioContext` de l'app (creation initiale ET reconstruction de qualite).
 *
 * `latencyHint: "playback"` : tampon de sortie plus large (base ~20 ms au lieu de ~10 ms en
 * "interactive"). Benten est un lecteur de musique : la latence d'entree n'a aucun interet, alors
 * qu'une marge de tampon plus grande rend la sortie plus robuste aux a-coups du systeme (lancement
 * d'autres applications). Aucun impact sur le gapless : l'enchainement est programme sur l'horloge
 * du contexte (`start(when)`), independante de la taille du tampon de sortie.
 */
export const AUDIO_LATENCY_HINT = "playback" as const;

export type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/**
 * Cree un `AudioContext` avec `latencyHint: "playback"` (+ `sampleRate` s'il est fourni). Si la
 * plateforme refuse la frequence demandee, repli sur la frequence par defaut — toujours en
 * "playback". `Ctor` est injectable (tests) ; par defaut, l'`AudioContext` global, resolu a l'appel.
 */
export function createAudioContext(sampleRate?: number, Ctor?: AudioContextCtor): AudioContext {
  const C: AudioContextCtor = Ctor ?? (globalThis as { AudioContext: AudioContextCtor }).AudioContext;
  const options: AudioContextOptions = { latencyHint: AUDIO_LATENCY_HINT };
  if (sampleRate !== undefined) options.sampleRate = sampleRate;
  try {
    return new C(options);
  } catch (err) {
    if (sampleRate === undefined) throw err;
    return new C({ latencyHint: AUDIO_LATENCY_HINT }); // frequence refusee : repli au defaut
  }
}
