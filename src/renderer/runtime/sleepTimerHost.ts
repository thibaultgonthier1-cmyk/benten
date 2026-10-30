import { createSleepTimer, type SleepMinutes, type SleepTimer } from "./sleepTimer";

/**
 * Hôte du minuteur de sommeil : un seul exemplaire pour l'app, branché sur le moteur audio et le
 * store de lecture. Le composant de menu ne fait que lire/armer cet hôte.
 *
 * Le fondu passe par `engine.rampVolume` (nœud de volume uniquement) ; la pause par le store +
 * le moteur, exactement comme un clic sur pause.
 */

interface HostDeps {
  fade(to: number, seconds: number): void;
  pause(): void;
  getVolume(): number;
  setVolume(v: number): void;
  onTrackEnd(cb: () => void): () => void;
}

let instance: SleepTimer | null = null;

/** Branche l'hôte une fois le moteur prêt (App). Idempotent. */
export function configureSleepTimer(deps: HostDeps): SleepTimer {
  instance = createSleepTimer({
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    ...deps,
  });
  return instance;
}

export function sleepTimer(): SleepTimer | null {
  return instance;
}

export type { SleepMinutes };
