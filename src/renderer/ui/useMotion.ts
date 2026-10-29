import { useMemo } from "react";
import { useReducedMotion } from "framer-motion";
import { motionFor, type ResolvedMotion } from "../theme/ds/motion";
import { settingsStore, useSettings } from "../state/settings";
import { motionLevel, type MotionLevel } from "../lib/motionLevel";

/**
 * Mouvement effectif pour un composant : réglage d'intensité (store de réglages) combiné à
 * `prefers-reduced-motion` du système, résolus par `motionFor`. Réactif aux deux.
 */
export function useMotion(): ResolvedMotion {
  const intensity = useSettings((s) => s.motionIntensity);
  const prefersReduced = useReducedMotion() ?? false;
  return useMemo(() => motionFor(intensity, prefersReduced), [intensity, prefersReduced]);
}

/** Échelles des réactions « ressort » des boutons (survol / appui). */
export const HOVER_SCALE = 1.03;
export const TAP_SCALE = 0.96;

/**
 * Props framer-motion de réaction au survol/clic. Vide si le mouvement est coupé ou le contrôle
 * désactivé : aucun saut d'échelle instantané en mode Réduit.
 */
export function useSpringPress(disabled?: boolean): {
  whileHover?: { scale: number };
  whileTap?: { scale: number };
  transition?: ResolvedMotion["spring"];
} {
  const m = useMotion();
  if (!m.enabled || disabled) return {};
  return { whileHover: { scale: HOVER_SCALE }, whileTap: { scale: TAP_SCALE }, transition: m.spring };
}

/**
 * Niveau de mouvement DA « Biwa & Or » (effets, éclats, vibration, rotation, ambiance) pour un
 * composant signature : réglage d'intensité + `prefers-reduced-motion`, réactif aux deux.
 */
export function useMotionLevel(): MotionLevel {
  const intensity = useSettings((s) => s.motionIntensity);
  const prefersReduced = useReducedMotion() ?? false;
  return motionLevel(intensity, prefersReduced);
}

/** Même résolution hors React (déclencheurs d'effets impératifs : `requestFx`). */
export function currentMotionLevel(): MotionLevel {
  const osReduced =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  return motionLevel(settingsStore.getState().motionIntensity, osReduced);
}
