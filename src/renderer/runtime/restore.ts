import type { AudioEngine } from "../audio/engine";
import { playerStore } from "../state/player";
import { restoreState } from "../lib/persist";
import type { TrackRow } from "../../shared/types";
import { PLAYER_STATE_KEY } from "./audioRuntime";

/** Garde « une seule fois » (au niveau du module : survit au double montage de StrictMode). */
let restoreStarted = false;

/**
 * Reprise de l'état de lecture au lancement (Task 14A) — EN PAUSE, sans aucun son automatique.
 * Ne s'exécute qu'une fois. Applique d'abord les préférences scalaires (volume/aléatoire/
 * répétition/qualité/vue), puis re-résout les ids de file en `TrackRow` via la DB et charge la
 * piste courante en pause à la position mémorisée. File vide ou tous les ids disparus : démarrage
 * propre. (Démarrer une veille de dossiers sur les sources est la Task 14B — pas ici.)
 */
export async function restorePlaybackState(engine: AudioEngine): Promise<void> {
  if (restoreStarted) return;
  restoreStarted = true;
  let raw: string | undefined;
  try {
    raw = await window.benten.state.get(PLAYER_STATE_KEY);
  } catch {
    return;
  }
  if (!raw) return; // rien de sauvé : défauts propres.
  const restored = restoreState(raw);
  if (!restored) return; // état corrompu : défauts propres.

  const store = playerStore.getState();
  // Préférences scalaires : appliquées même si la file a disparu. `setShuffle`/`setRepeat`/
  // `setVolume` configurent aussi le moteur ; `qualityMode`/`nowPlayingOpen` ne sont posés que
  // dans le store (pas de recréation de contexte au lancement : on reste muet et sans course).
  store.setVolume(restored.volume);
  store.setShuffle(restored.shuffle);
  store.setRepeat(restored.repeat);
  playerStore.setState({
    qualityMode: restored.qualityMode,
    nowPlayingOpen: restored.nowPlayingOpen,
  });

  if (restored.queueTrackIds.length === 0) return;
  let tracks: TrackRow[] = [];
  try {
    tracks = await window.benten.library.tracksByIds(restored.queueTrackIds);
  } catch {
    return;
  }
  if (tracks.length === 0) return; // tous les ids disparus : file vide, démarrage propre.
  // Index courant re-mappé sur la file filtrée (des ids ont pu disparaître) : par identité si
  // possible, sinon borné à ce qui reste.
  const savedId = restored.queueTrackIds[restored.currentIndex];
  let index = savedId != null ? tracks.findIndex((t) => t.id === savedId) : -1;
  if (index < 0) index = Math.min(Math.max(restored.currentIndex, 0), tracks.length - 1);

  store.setQueue(tracks, index);
  // Reprise EN PAUSE à la position mémorisée : le moteur ne démarre AUCUNE source.
  await engine.restoreQueue(tracks, index, restored.positionSec);
}
