// Journal audio (diagnostic des micro-coupures) — types partages Main <-> Preload <-> Renderer.
// Aucune dependance Node/Electron ici.

/** Genres d'entrees que le RENDERER a le droit d'envoyer (`diagnostics:append`). */
export const RENDERER_DIAG_KINDS = [
  "glitch",
  "stall",
  "engine",
  "ctx",
  "device",
  "window",
  "session",
] as const;

/** Genres d'entrees ecrits par le Main lui-meme (jamais acceptes depuis le Renderer). */
export const MAIN_DIAG_KINDS = ["process", "power"] as const;

export type RendererDiagKind = (typeof RENDERER_DIAG_KINDS)[number];
export type MainDiagKind = (typeof MAIN_DIAG_KINDS)[number];
export type DiagKind = RendererDiagKind | MainDiagKind;

/**
 * Une ligne du journal : horodatage ISO, genre, et details libres (serialisables JSON). Ecrite
 * telle quelle, une ligne JSON par entree, dans `userData/logs/audio-journal.log`.
 */
export interface DiagEntry {
  t: string;
  kind: DiagKind;
  [detail: string]: unknown;
}

/** Plafond d'entrees par envoi IPC (le Renderer decoupe ses lots en consequence). */
export const DIAG_MAX_BATCH = 200;
/** Plafond de taille d'une entree serialisee (octets UTF-8). */
export const DIAG_MAX_ENTRY_BYTES = 2048;
