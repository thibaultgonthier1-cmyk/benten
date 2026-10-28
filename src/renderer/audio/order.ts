/**
 * Ordre de lecture (shuffle) & navigation (repeat) — PUR, sans aucune dependance Web Audio.
 *
 * `order` est une permutation d'indices dans la file (`queue`). `pos` est une position DANS
 * `order` (pas un indice de file) : le moteur mappe `order[pos]` -> indice de file. Toute la
 * logique est deterministe (PRNG seede) et testable hors contexte audio, exactement comme
 * `schedule.ts` pour le gapless.
 */

export type RepeatMode = "off" | "all" | "one";

/**
 * PRNG mulberry32 : rapide, deterministe, sans dependance. Une graine entiere -> une suite
 * reproductible de flottants dans [0, 1). Suffisant pour un melange Fisher-Yates equilibre.
 */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalise une graine (defaut 0) en entier 32 bits non signe stable. */
function normalizeSeed(seed: number | undefined): number {
  return Number.isFinite(seed) ? (seed as number) | 0 : 0;
}

/**
 * Construit l'ordre de lecture pour `count` pistes.
 *
 * - `shuffle:false` -> ordre identite `[0..count-1]`.
 * - `shuffle:true`  -> permutation Fisher-Yates SEEDEE (deterministe pour une graine donnee), avec
 *   la piste `current` placee en TETE (position 0) et le reste melange apres elle. Cela garantit que
 *   la piste en cours reste la piste courante quand on active le shuffle en pleine lecture.
 *
 * @returns un tableau d'indices de file (permutation de `[0..count-1]`).
 */
export function buildOrder(
  count: number,
  opts: { shuffle: boolean; seed?: number; current?: number },
): number[] {
  const n = Math.max(0, Math.floor(count));
  const identity = Array.from({ length: n }, (_, i) => i);
  if (!opts.shuffle || n <= 1) return identity;

  const current =
    opts.current != null && opts.current >= 0 && opts.current < n ? Math.floor(opts.current) : -1;
  // Le reste a melanger = tous les indices sauf la courante (qui ira en tete).
  const rest = current >= 0 ? identity.filter((i) => i !== current) : identity.slice();

  const rng = mulberry32(normalizeSeed(opts.seed));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = rest[i]!;
    rest[i] = rest[j]!;
    rest[j] = tmp;
  }
  return current >= 0 ? [current, ...rest] : rest;
}

/**
 * Position SUIVANTE dans `order` depuis `pos`, en respectant `repeat` :
 *  - `one` -> la MEME position (loop d'une seule piste) ;
 *  - `all` -> boucle (derniere -> premiere) ;
 *  - `off` -> `null` a la borne de fin.
 *
 * Renvoie une POSITION dans `order` (le moteur fera `order[pos]` -> indice de file), ou `null`.
 */
export function nextInOrder(
  order: readonly number[],
  pos: number,
  repeat: RepeatMode,
): number | null {
  const n = order.length;
  if (n === 0) return null;
  if (repeat === "one") return pos;
  const next = pos + 1;
  if (next < n) return next;
  return repeat === "all" ? 0 : null;
}

/**
 * Position PRECEDENTE dans `order` depuis `pos`, symetrique de `nextInOrder` :
 *  - `one` -> la MEME position ;
 *  - `all` -> boucle (premiere -> derniere) ;
 *  - `off` -> `null` a la borne de debut.
 */
export function prevInOrder(
  order: readonly number[],
  pos: number,
  repeat: RepeatMode,
): number | null {
  const n = order.length;
  if (n === 0) return null;
  if (repeat === "one") return pos;
  const prev = pos - 1;
  if (prev >= 0) return prev;
  return repeat === "all" ? n - 1 : null;
}
