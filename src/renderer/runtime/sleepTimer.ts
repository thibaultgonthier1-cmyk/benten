/**
 * Minuteur de sommeil (T17).
 *
 * Deux modes : une durée (`start(15|30|45|60)`) ou la fin du titre en cours
 * (`startEndOfTrack`). À l'échéance, on ne coupe pas net : on **fond** le volume sur 8 s, on met
 * en pause, puis on **restaure le volume d'origine** — sinon le prochain lancement serait muet et
 * l'utilisateur croirait l'app cassée.
 *
 * Toutes les dépendances sont injectées (`now`, timers, fondu, pause, volume) : la logique est
 * testable à la milliseconde près, et ne connaît ni le moteur audio ni React.
 */

export type SleepMinutes = 15 | 30 | 45 | 60;

/** Durée du fondu de sortie (s). */
export const FADE_SECONDS = 8;

export interface SleepTimerDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  fade(to: number, seconds: number): void;
  pause(): void;
  getVolume(): number;
  setVolume(v: number): void;
  /** S'abonne au changement de piste (fin du titre). Renvoie le désabonnement. */
  onTrackEnd(cb: () => void): () => void;
}

export interface SleepTimer {
  start(minutes: SleepMinutes): void;
  startEndOfTrack(): void;
  cancel(): void;
  /** Secondes restantes, ou `null` si aucun minuteur n'est armé. */
  remainingSec(): number | null;
  /** Mode courant, pour l'affichage du menu. */
  mode(): "off" | "duration" | "end-of-track";
}

export function createSleepTimer(deps: SleepTimerDeps): SleepTimer {
  let deadline: number | null = null;
  let handle: unknown = null;
  let endOfTrackMode = false;
  let unsubscribeTrack: (() => void) | null = null;
  let fired = false;

  const cleanupTimer = (): void => {
    if (handle !== null) {
      deps.clearTimeout(handle);
      handle = null;
    }
  };

  const cleanupTrack = (): void => {
    if (unsubscribeTrack) {
      unsubscribeTrack();
      unsubscribeTrack = null;
    }
  };

  const disarm = (): void => {
    cleanupTimer();
    cleanupTrack();
    deadline = null;
    endOfTrackMode = false;
  };

  /** Fondu, pause, puis restauration du volume d'origine. */
  const sleepNow = (): void => {
    if (fired) return;
    fired = true;
    const original = deps.getVolume();
    disarm();
    deps.fade(0, FADE_SECONDS);
    deps.setTimeout(() => {
      deps.pause();
      // On restaure APRÈS la pause : le prochain lancement retrouve son volume.
      deps.setVolume(original);
      fired = false;
    }, FADE_SECONDS * 1000);
  };

  return {
    start(minutes: SleepMinutes): void {
      disarm();
      const ms = minutes * 60 * 1000;
      deadline = deps.now() + ms;
      handle = deps.setTimeout(() => {
        handle = null;
        sleepNow();
      }, ms);
    },

    startEndOfTrack(): void {
      disarm();
      endOfTrackMode = true;
      unsubscribeTrack = deps.onTrackEnd(() => {
        sleepNow();
      });
    },

    cancel(): void {
      disarm();
    },

    remainingSec(): number | null {
      if (endOfTrackMode) return null;
      if (deadline === null) return null;
      return Math.max(0, Math.ceil((deadline - deps.now()) / 1000));
    },

    mode(): "off" | "duration" | "end-of-track" {
      if (endOfTrackMode) return "end-of-track";
      return deadline === null ? "off" : "duration";
    },
  };
}
