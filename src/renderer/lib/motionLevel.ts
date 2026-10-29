import type { MotionIntensity } from "../theme/ds/motion";

/**
 * Niveaux de mouvement de la DA « Biwa & Or » (spec §7 bis), consommés par les composants
 * signature (médaillon, corde, disque, effets) :
 *  - Complet : tout ;
 *  - Sobre : effets vidéo atténués, pas d'éclats d'or, vibration ×0.5, le disque tourne, pas
 *    d'ambiance (Ken Burns, lignes d'eau) ;
 *  - Réduit (ou `prefers-reduced-motion` du système, qui l'emporte toujours) : aucun effet, ni
 *    vibration ni rotation ; changements d'état instantanés.
 */
export interface MotionLevel {
  fx: "full" | "dim" | "none";
  flakes: boolean;
  /** Facteur d'amplitude de vibration de la corde : 1 | 0.5 | 0. */
  vibration: number;
  rotate: boolean;
  ambient: boolean;
}

const FULL: Readonly<MotionLevel> = Object.freeze({ fx: "full", flakes: true, vibration: 1, rotate: true, ambient: true });
const SUBTLE: Readonly<MotionLevel> = Object.freeze({
  fx: "dim",
  flakes: false,
  vibration: 0.5,
  rotate: true,
  ambient: false,
});
const NONE: Readonly<MotionLevel> = Object.freeze({ fx: "none", flakes: false, vibration: 0, rotate: false, ambient: false });

/** Résout le niveau effectif. Renvoie des objets partagés (références stables). */
export function motionLevel(intensity: MotionIntensity, osReduced: boolean): MotionLevel {
  if (osReduced || intensity === "reduced") return NONE;
  return intensity === "subtle" ? SUBTLE : FULL;
}
