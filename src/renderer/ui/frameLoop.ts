/**
 * Boucles d'animation des composants signature : UNE boucle rAF par composant, qui ne tourne que
 * tant qu'il y a quelque chose à animer (le rappel renvoie `false` pour s'arrêter). Aucune mise à
 * jour d'état React par frame : le rappel écrit `transform` / `d` via des refs.
 *
 * Registre des boucles vivantes (`activeFrameLoops`) : sert à la vérification réelle (mouvement
 * Réduit → aucune boucle signature) via le pont dev `__benten.signature.loops()`.
 */

/** Rappel de frame : `dt` en secondes (borné), `now` en ms. Renvoie `true` pour continuer. */
export type FrameFn = (dt: number, now: number) => boolean;

const live = new Map<number, string>();
let nextLoopId = 1;
/** Borne de `dt` (s) : après un onglet masqué, on ne saute pas d'une seconde d'un coup. */
const MAX_DT = 1 / 20;

/**
 * Démarre une boucle ; renvoie sa fonction d'arrêt (idempotente). Sans `requestAnimationFrame`
 * (tests node), ne fait rien.
 */
export function startFrameLoop(name: string, frame: FrameFn): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const id = nextLoopId++;
  let raf = 0;
  let last = -1;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    live.delete(id);
  };
  const tick = (now: number): void => {
    if (stopped) return;
    const dt = last < 0 ? 1 / 60 : Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    let keep = false;
    try {
      keep = frame(dt, now);
    } catch (err) {
      console.error(`[frameLoop:${name}]`, err);
      keep = false;
    }
    if (keep && !stopped) raf = requestAnimationFrame(tick);
    else stop();
  };
  live.set(id, name);
  raf = requestAnimationFrame(tick);
  return stop;
}

/** Noms des boucles signature vivantes (introspection dev). */
export function activeFrameLoops(): string[] {
  return [...live.values()];
}
