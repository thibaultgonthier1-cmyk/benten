import type { AudioEngine } from "../audio/engine";
import type { TrackRow } from "../../shared/types";

/**
 * Préchargement à l'intention.
 *
 * Le cache de buffers décodés rend instantanée une piste déjà jouée. Restait le cas gênant : la
 * PREMIÈRE lecture d'une piste, qui doit encore lire le fichier et le décoder — plusieurs
 * centaines de millisecondes entre l'appui et le son.
 *
 * Ici, on décode **avant** le clic : dès que la souris s'arrête un instant sur une pochette ou une
 * ligne, ou dès l'appui. Le clic suivant trouve alors le buffer en cache et part immédiatement.
 *
 * Le survol est retardé (`HOVER_DELAY_MS`) : balayer la grille ne doit pas lancer douze décodages.
 */

/** Délai avant de décoder sur simple survol : assez pour distinguer une intention d'un balayage. */
export const HOVER_DELAY_MS = 160;

let engineRef: AudioEngine | null = null;
let hoverTimer = 0;
let hoveredId: number | null = null;

/** Branche le moteur (App). Idempotent. */
export function bindPrefetcher(engine: AudioEngine): void {
  engineRef = engine;
}

/** Décode tout de suite (appui, focus clavier). Sans effet si le moteur n'est pas prêt. */
export function prefetchNow(track: TrackRow | null | undefined): void {
  if (!track || !engineRef) return;
  window.clearTimeout(hoverTimer);
  hoverTimer = 0;
  hoveredId = track.id;
  void engineRef.prefetch(track).catch(() => undefined);
}

/** Décode après un court survol (intention probable). */
export function prefetchOnHover(track: TrackRow | null | undefined): void {
  if (!track || !engineRef) return;
  if (hoveredId === track.id) return; // déjà demandé : on ne relance pas
  window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    hoveredId = track.id;
    void engineRef?.prefetch(track).catch(() => undefined);
  }, HOVER_DELAY_MS);
}

/** Annule un survol en cours (la souris est repartie). */
export function cancelPrefetch(): void {
  window.clearTimeout(hoverTimer);
  hoverTimer = 0;
  hoveredId = null;
}
