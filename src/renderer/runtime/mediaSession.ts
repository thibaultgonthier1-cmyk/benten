import type { PlayerState, PlayerStore } from "../state/player";
import type { PlayerControls } from "../components/controls";
import type { TrackRow } from "../../shared/types";
import { artUrl } from "../lib/library";

/**
 * Touches média + contrôle de lecture Windows (Phase 3, Tâche 4) via `navigator.mediaSession` :
 * touches multimédia du clavier, overlay de volume/lecture de Windows (titre, artiste, pochette).
 *
 * Lecture seule côté audio : la session REFLÈTE le store (métadonnées à chaque changement de piste,
 * `playbackState`, position lors des sauts) et route les commandes système vers `PlayerControls` —
 * l'API de transport existante. Aucun accès direct au moteur.
 */

/** Taille de pochette demandée au protocole `benten-art://` pour l'overlay système. */
export const MEDIA_ART_SIZE = 512;
/** Pas (s) des actions système « avancer / reculer » sans `seekOffset`. */
export const MEDIA_SEEK_STEP_SEC = 10;

const ACTIONS = [
  "play",
  "pause",
  "stop",
  "previoustrack",
  "nexttrack",
  "seekto",
  "seekforward",
  "seekbackward",
] as const satisfies readonly MediaSessionAction[];

/** `navigator.mediaSession` si disponible (absent en tests node et hors navigateur). */
function defaultSession(): MediaSession | undefined {
  return typeof navigator !== "undefined" && "mediaSession" in navigator
    ? (navigator as Navigator).mediaSession
    : undefined;
}

function metadataFor(track: TrackRow): MediaMetadata {
  const src = artUrl(track.artKey, MEDIA_ART_SIZE);
  const init: MediaMetadataInit = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: src ? [{ src, sizes: `${MEDIA_ART_SIZE}x${MEDIA_ART_SIZE}` }] : [],
  };
  // `MediaMetadata` n'existe qu'au navigateur ; ailleurs (session factice) l'objet simple suffit.
  return typeof MediaMetadata === "function" ? new MediaMetadata(init) : (init as MediaMetadata);
}

/** Statut moteur → état système ; `undefined` = inchangé (chargement transitoire, pas de clignement). */
function playbackStateFor(status: PlayerState["status"]): MediaSessionPlaybackState | undefined {
  switch (status) {
    case "playing":
      return "playing";
    case "paused":
    case "ready":
    case "ended":
      return "paused";
    case "loading":
      return undefined;
    default:
      return "none";
  }
}

const durationOf = (s: PlayerState): number => s.durationSec || s.currentTrack?.durationSec || 0;

/**
 * Lie la session média au store de lecture. Renvoie le désabonnement : il retire les gestionnaires,
 * vide les métadonnées et repasse l'état à `none`. Sans session disponible : no-op.
 */
export function bindMediaSession(
  store: PlayerStore,
  controls: PlayerControls,
  ms: MediaSession | undefined = defaultSession(),
): () => void {
  if (!ms) return () => undefined;
  const session = ms;

  const seekTo = (sec: number): void => {
    const dur = durationOf(store.getState());
    if (dur <= 0 || !Number.isFinite(sec)) return;
    controls.seekFraction(sec / dur);
  };
  const seekBy = (delta: number): void => seekTo(store.getState().positionSec + delta);

  const handlers: Record<(typeof ACTIONS)[number], MediaSessionActionHandler> = {
    play: () => {
      if (store.getState().status !== "playing") controls.toggle();
    },
    pause: () => {
      if (store.getState().status === "playing") controls.toggle();
    },
    stop: () => {
      if (store.getState().status === "playing") controls.toggle();
    },
    previoustrack: () => controls.prev(),
    nexttrack: () => controls.next(),
    seekto: (d) => {
      if (typeof d.seekTime === "number") seekTo(d.seekTime);
    },
    seekforward: (d) => seekBy(d.seekOffset ?? MEDIA_SEEK_STEP_SEC),
    seekbackward: (d) => seekBy(-(d.seekOffset ?? MEDIA_SEEK_STEP_SEC)),
  };

  const setHandler = (action: MediaSessionAction, h: MediaSessionActionHandler | null): void => {
    try {
      session.setActionHandler(action, h);
    } catch {
      /* action non prise en charge par la plateforme : les autres restent branchées */
    }
  };
  for (const a of ACTIONS) setHandler(a, handlers[a]);

  const reportPosition = (s: PlayerState): void => {
    if (typeof session.setPositionState !== "function") return;
    const duration = durationOf(s);
    try {
      if (!s.currentTrack || duration <= 0) {
        session.setPositionState();
        return;
      }
      session.setPositionState({
        duration,
        position: Math.max(0, Math.min(s.positionSec, duration)),
        playbackRate: 1,
      });
    } catch {
      /* état refusé (durée transitoire) : l'overlay garde le précédent */
    }
  };

  let lastTrack: TrackRow | null | undefined;
  let lastStatus: PlayerState["status"] | undefined;
  let lastDuration = -1;
  let lastPos = 0;

  const apply = (s: PlayerState): void => {
    let positionDirty = false;
    const trackChanged = s.currentTrack !== lastTrack;
    if (trackChanged) {
      lastTrack = s.currentTrack;
      session.metadata = s.currentTrack ? metadataFor(s.currentTrack) : null;
      positionDirty = true;
    }
    // L'état dépend du statut ET de la présence d'une piste (file vidée en pause → « none »).
    if (s.status !== lastStatus || trackChanged) {
      lastStatus = s.status;
      const ps = s.currentTrack ? playbackStateFor(s.status) : "none";
      if (ps !== undefined) session.playbackState = ps;
      positionDirty = true;
    }
    const dur = durationOf(s);
    if (dur !== lastDuration) {
      lastDuration = dur;
      positionDirty = true;
    }
    // La position avance par petits pas (~66 ms) en lecture ; le système l'extrapole seul. On ne
    // la republie que sur un saut (seek, retour au début) pour garder la frise de l'overlay juste.
    const delta = s.positionSec - lastPos;
    if (delta < -0.5 || delta > 2.5) positionDirty = true;
    lastPos = s.positionSec;
    if (positionDirty) reportPosition(s);
  };

  apply(store.getState());
  const unsubscribe = store.subscribe(apply);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubscribe();
    for (const a of ACTIONS) setHandler(a, null);
    try {
      session.metadata = null;
      session.playbackState = "none";
    } catch {
      /* best-effort */
    }
  };
}
