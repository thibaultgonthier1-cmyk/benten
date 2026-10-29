import type { PlayerState, PlayerStore } from "../state/player";
import type { PlayerControls } from "../components/controls";
import type { TrackRow } from "../../shared/types";
import { artUrl } from "../lib/library";
import { alreadyJournaled, journalCommand, type TransportCmd } from "./transportJournal";

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

/** Chargeur de pochette (blob) et fabrique d'URL d'objet, injectables (tests). */
export interface MediaSessionOptions {
  /**
   * Charge la pochette `benten-art://…` en blob. `null` : pas de repli, l'URL du protocole est
   * donnée telle quelle. Défaut : `fetch` dans une fenêtre, `null` ailleurs (tests node).
   */
  fetchArt?: ((url: string) => Promise<Blob>) | null;
  objectUrls?: { create(blob: Blob): string; revoke(url: string): void };
}

const defaultFetchArt = async (url: string): Promise<Blob> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`art ${res.status}`);
  return res.blob();
};

function defaultOptions(): Required<MediaSessionOptions> {
  const inWindow = typeof window !== "undefined" && typeof fetch === "function";
  return {
    fetchArt: inWindow ? defaultFetchArt : null,
    objectUrls: {
      create: (b) => URL.createObjectURL(b),
      revoke: (u) => URL.revokeObjectURL(u),
    },
  };
}

const ART_SIZES = `${MEDIA_ART_SIZE}x${MEDIA_ART_SIZE}`;

function metadataFor(track: TrackRow, art?: MediaImage): MediaMetadata {
  const src = artUrl(track.artKey, MEDIA_ART_SIZE);
  const init: MediaMetadataInit = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: art ? [art] : src ? [{ src, sizes: ART_SIZES }] : [],
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
 * vide les métadonnées, repasse l'état à `none` et révoque l'URL d'objet de la pochette. Sans
 * session disponible : no-op.
 *
 * Pochette : l'overlay système télécharge l'image côté navigateur ; rien ne garantit qu'il passe
 * par le gestionnaire du protocole personnalisé `benten-art://`. Les métadonnées partent donc tout
 * de suite avec l'URL du protocole, puis la pochette est chargée en blob et republiée en URL
 * d'objet (`blob:`), que Chromium sait toujours lire. Un résultat arrivé pour une piste déjà
 * remplacée (ou après le désabonnement) est ignoré sans créer d'URL ; l'URL précédente est révoquée
 * à chaque changement de piste et au désabonnement.
 */
export function bindMediaSession(
  store: PlayerStore,
  controls: PlayerControls,
  ms: MediaSession | undefined = defaultSession(),
  options: MediaSessionOptions = {},
): () => void {
  if (!ms) return () => undefined;
  const session = ms;
  const defaults = defaultOptions();
  const fetchArt = options.fetchArt === undefined ? defaults.fetchArt : options.fetchArt;
  const objectUrls = options.objectUrls ?? defaults.objectUrls;

  /** Jeton de la piste courante : un chargement ne publie que s'il porte encore le jeton actif. */
  let artToken = 0;
  let artObjectUrl: string | null = null;
  let released = false;
  const revokeArt = (): void => {
    if (artObjectUrl === null) return;
    try {
      objectUrls.revoke(artObjectUrl);
    } catch {
      /* best-effort */
    }
    artObjectUrl = null;
  };
  const loadArt = (track: TrackRow): void => {
    const token = ++artToken;
    const src = artUrl(track.artKey, MEDIA_ART_SIZE);
    if (!fetchArt || !src) return;
    fetchArt(src).then(
      (blob) => {
        if (released || token !== artToken) return; // périmé : aucune URL créée
        let url: string;
        try {
          url = objectUrls.create(blob);
        } catch {
          return;
        }
        artObjectUrl = url;
        const art: MediaImage = blob.type
          ? { src: url, sizes: ART_SIZES, type: blob.type }
          : { src: url, sizes: ART_SIZES };
        try {
          session.metadata = metadataFor(track, art);
        } catch {
          /* best-effort : l'URL du protocole reste */
        }
      },
      () => {
        /* échec : l'URL du protocole reste en place */
      },
    );
  };

  /** Un saut vers `sec` aura-t-il lieu ? (durée inconnue ou cible invalide : non). */
  const canSeekTo = (sec: number): boolean => durationOf(store.getState()) > 0 && Number.isFinite(sec);
  const seekTo = (sec: number): void => {
    if (!canSeekTo(sec)) return;
    controls.seekFraction(sec / durationOf(store.getState()));
  };
  const byTarget = (delta: number): number => store.getState().positionSec + delta;

  // Origine des commandes (diagnostic) : CHAQUE invocation système est consignée — même sans
  // effet (« pause » déjà en pause) — avant d'être routée, inchangée, vers `controls`.
  const journal = (cmd: TransportCmd, action: string, noop: boolean, extra: Record<string, unknown> = {}): void =>
    journalCommand(cmd, "media-session", { action, noop, status: store.getState().status, ...extra });

  const handlers: Record<(typeof ACTIONS)[number], MediaSessionActionHandler> = {
    play: () => {
      const noop = store.getState().status === "playing";
      journal("play", "play", noop);
      if (!noop) alreadyJournaled(() => controls.toggle());
    },
    pause: () => {
      const noop = store.getState().status !== "playing";
      journal("pause", "pause", noop);
      if (!noop) alreadyJournaled(() => controls.toggle());
    },
    stop: () => {
      const noop = store.getState().status !== "playing";
      journal("pause", "stop", noop);
      if (!noop) alreadyJournaled(() => controls.toggle());
    },
    previoustrack: () => {
      journal("prev", "previoustrack", false);
      alreadyJournaled(() => controls.prev());
    },
    nexttrack: () => {
      journal("next", "nexttrack", false);
      alreadyJournaled(() => controls.next());
    },
    // Sauts : `noop` reflète le retour anticipé de `seekTo` (durée inconnue, cible invalide).
    seekto: (d) => {
      const target = typeof d.seekTime === "number" ? d.seekTime : NaN;
      journal("seek", "seekto", !canSeekTo(target), Number.isFinite(target) ? { seekTime: target } : {});
      alreadyJournaled(() => seekTo(target));
    },
    seekforward: (d) => {
      const offset = d.seekOffset ?? MEDIA_SEEK_STEP_SEC;
      journal("seek", "seekforward", !canSeekTo(byTarget(offset)), { offset });
      alreadyJournaled(() => seekTo(byTarget(offset)));
    },
    seekbackward: (d) => {
      const offset = -(d.seekOffset ?? MEDIA_SEEK_STEP_SEC);
      journal("seek", "seekbackward", !canSeekTo(byTarget(offset)), { offset });
      alreadyJournaled(() => seekTo(byTarget(offset)));
    },
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
      revokeArt();
      session.metadata = s.currentTrack ? metadataFor(s.currentTrack) : null;
      if (s.currentTrack) loadArt(s.currentTrack);
      else artToken++;
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

  return () => {
    if (released) return;
    released = true;
    artToken++;
    unsubscribe();
    for (const a of ACTIONS) setHandler(a, null);
    try {
      session.metadata = null;
      session.playbackState = "none";
    } catch {
      /* best-effort */
    }
    revokeArt();
  };
}
