/**
 * Porte de cadencement pure, pilotee par un timestamp monotone (`performance.now()` en prod).
 *
 * `makeThrottle(intervalMs)` renvoie une fonction `(now) => boolean` qui vaut `true` au tout
 * premier appel puis uniquement quand au moins `intervalMs` se sont ecoules depuis le dernier
 * `true`. Elle ne contient AUCUN effet de bord externe (pas de timer, pas d'horloge interne) : le
 * temps est injecte, ce qui la rend deterministe et testable hors DOM.
 *
 * Usage : la boucle rAF d'`App.tsx` continue de tourner a la frequence ecran, mais `tick()` et
 * `setPosition` ne s'executent que lorsque la porte laisse passer — ~15 Hz avec `makeThrottle(66)`.
 */
export function makeThrottle(intervalMs: number): (now: number) => boolean {
  let last = -Infinity;
  return (now: number): boolean => {
    if (now - last >= intervalMs) {
      last = now;
      return true;
    }
    return false;
  };
}
