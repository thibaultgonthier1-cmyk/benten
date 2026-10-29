/**
 * Physique de la corde de biwa (barre de lecture et volume), PURE et testable :
 *  - `fractionFromPointer` : pointeur → fraction [0,1] (rect relu à chaque mouvement : exact en
 *    HiDPI et au redimensionnement) ;
 *  - `deflect` : flexion sous le doigt pendant le glisser, bornée en douceur à ±14 px et nulle aux
 *    chevalets (extrémités fixes) ;
 *  - `stepSpring` : ressort amorti (oscillation visible puis repos) au relâchement ;
 *  - `vibrationAmplitude` : frémissement en lecture, piloté par le RMS de l'analyser (lu en
 *    lecture seule par le composant), au plus 2.5 px, nul hors lecture ;
 *  - `createScrubGesture` : geste de glisser ; un changement de piste en cours l'annule SANS
 *    recherche (promotion gapless ou « suivant » pendant que le pointeur est enfoncé).
 */

/** Flexion maximale de la corde sous le pointeur (px). */
export const DEFLECT_MAX_PX = 14;
/** Amplitude maximale du frémissement en lecture (px). */
export const VIBRATION_MAX_PX = 2.5;
/** Distance (px) aux chevalets sur laquelle la flexion s'annule progressivement. */
const BRIDGE_TAPER_PX = 36;

export interface StringShape {
  /** Abscisse locale (px, depuis le bord gauche de la corde) du point de flexion. */
  anchorX: number;
  /** Décalage vertical du point de flexion (px, + vers le bas), borné à ±DEFLECT_MAX_PX. */
  offsetY: number;
}

export interface SpringState {
  offset: number;
  velocity: number;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Fraction [0,1] du pointeur sur la corde ; 0 si la largeur est nulle ou la valeur invalide. */
export function fractionFromPointer(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0) || !Number.isFinite(clientX)) return 0;
  return clamp01((clientX - rect.left) / rect.width);
}

/**
 * Forme de la corde sous le pointeur. `restY` : ordonnée locale de la corde au repos (px depuis
 * `rect.top`). Borne douce (tanh) : la corde « résiste » de plus en plus en s'approchant de ±14 px ;
 * près des chevalets, la flexion s'éteint (une corde ne plie pas sur son point d'attache).
 */
export function deflect(
  pointerX: number,
  pointerY: number,
  rect: { left: number; top: number; width: number; height?: number },
  restY: number,
): StringShape {
  const width = Math.max(0, rect.width);
  const local = Number.isFinite(pointerX) ? pointerX - rect.left : 0;
  const anchorX = Math.min(width, Math.max(0, local));
  const raw = Number.isFinite(pointerY) ? pointerY - (rect.top + restY) : 0;
  const taper = Math.min(1, Math.min(anchorX, width - anchorX) / BRIDGE_TAPER_PX);
  const offsetY = DEFLECT_MAX_PX * Math.tanh(raw / DEFLECT_MAX_PX) * taper;
  return { anchorX, offsetY: offsetY || 0 };
}

/** Pas maximal d'intégration (s) : un grand `dt` (onglet en arrière-plan) est sous-découpé. */
const MAX_SUBSTEP = 1 / 120;

/**
 * Un pas de ressort amorti vers 0 (Euler semi-implicite, stable). k = 380, amortissement 14 :
 * ≈ 3 Hz, ζ ≈ 0.36 — deux ou trois rebonds visibles, repos en moins d'une seconde.
 */
export function stepSpring(state: SpringState, dt: number, k = 380, damping = 14): SpringState {
  let { offset, velocity } = state;
  let remaining = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
  while (remaining > 1e-9) {
    const h = Math.min(remaining, MAX_SUBSTEP);
    velocity += (-k * offset - damping * velocity) * h;
    offset += velocity * h;
    remaining -= h;
  }
  return { offset, velocity };
}

/**
 * Amplitude (px) du frémissement de la corde. Courbe perceptive (racine) : une musique calme
 * frémit déjà, un passage fort sature vers 2.5 px. Linéaire en `level` (Sobre = moitié exacte).
 */
export function vibrationAmplitude(rms: number, playing: boolean, level: number): number {
  if (!playing || !(level > 0) || !(rms > 0)) return 0;
  const energy = Math.min(1, Math.sqrt(rms) * 1.6);
  const base = VIBRATION_MAX_PX * energy;
  return base * Math.min(1, level);
}

/** RMS [0,1] d'un tampon `getByteTimeDomainData` (128 = zéro). */
export function rmsFromTimeDomain(buf: Uint8Array): number {
  const n = buf.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = (buf[i] - 128) / 128;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / n));
}

export interface ScrubGesture {
  begin(trackKey: unknown, fraction: number): void;
  move(fraction: number): void;
  /** Fin du glisser : fraction à rechercher, ou `null` si annulé / pas de glisser en cours. */
  end(): number | null;
  cancel(): void;
  /** Signale la piste courante ; `true` si un glisser en cours vient d'être annulé. */
  trackChanged(trackKey: unknown): boolean;
  dragging(): boolean;
  fraction(): number;
}

export function createScrubGesture(): ScrubGesture {
  let active = false;
  let key: unknown = undefined;
  let frac = 0;
  return {
    begin(trackKey, fraction) {
      active = true;
      key = trackKey;
      frac = clamp01(fraction);
    },
    move(fraction) {
      if (active) frac = clamp01(fraction);
    },
    end() {
      if (!active) return null;
      active = false;
      return frac;
    },
    cancel() {
      active = false;
    },
    trackChanged(trackKey) {
      if (!active || Object.is(trackKey, key)) return false;
      active = false;
      return true;
    },
    dragging: () => active,
    fraction: () => frac,
  };
}

/**
 * Ordonnée d'une Bézier quadratique (x monotone) à l'abscisse `x`, par bissection sur t.
 * Sert à poser la poignée exactement sur la corde fléchie.
 */
export function quadYAtX(
  x: number,
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    const u = 1 - t;
    const xt = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    if (xt < x) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  const u = 1 - t;
  return u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
}
