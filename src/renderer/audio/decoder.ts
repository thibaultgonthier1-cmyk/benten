/**
 * Decodage audio pour le moteur de lecture.
 *
 * Le moteur ne connait du decodage que cette interface : il lui passe les octets bruts du
 * fichier et recoit un `AudioBuffer` PCM pret a etre joue. Cela isole la strategie de decodage
 * (Web Audio natif en Phase 1 ; un repli WASM reste possible plus tard sans toucher au moteur)
 * et rend le moteur testable avec un decodeur simule.
 */
export interface Decoder {
  /** Vrai si ce decodeur sait (a priori, d'apres l'extension) decoder ce fichier. */
  canDecode(path: string): boolean;
  /** Decode les octets en PCM. Rejette si le format est illisible / protege (DRM). */
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
}

/** Extensions que `decodeAudioData` de Chromium sait decoder (hors conteneurs proteges). */
const SUPPORTED = new Set(["flac", "mp3", "wav", "wave", "m4a", "aac", "mp4", "ogg", "oga", "opus", "weba", "webm"]);
/** Conteneurs proteges / explicitement non pris en charge : refuses avant toute tentative. */
const UNSUPPORTED = new Set(["m4p", "m4b", "wma", "aa", "aax"]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Decodeur par defaut : `AudioContext.decodeAudioData`, le decodeur natif de Chromium.
 *
 * Reutilise l'`AudioContext` du moteur (pas de contexte jetable) pour que la frequence de
 * sortie soit celle du graphe de lecture. `decodeAudioData` detache l'`ArrayBuffer` qu'on lui
 * passe ; on lui donne donc une copie pour ne jamais invalider le tampon de l'appelant.
 */
export class NativeDecoder implements Decoder {
  constructor(private readonly context: AudioContext) {}

  canDecode(path: string): boolean {
    const ext = extOf(path);
    if (UNSUPPORTED.has(ext)) return false;
    return SUPPORTED.has(ext);
  }

  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    // Copie : decodeAudioData consomme (detache) le tampon fourni.
    return this.context.decodeAudioData(bytes.slice(0));
  }
}
