/**
 * Tokens de motion centralisés (Phase 3) : durées, courbes et ressorts partagés par toute l'UI
 * (framer-motion). Seules `transform`/`opacity` sont animées ; aucune valeur n'est exagérée.
 *
 * `motionFor(intensity, prefersReduced)` résout le réglage utilisateur (Complet / Sobre / Réduit)
 * et la préférence système `prefers-reduced-motion` en un petit objet consommé par les composants :
 * `enabled` (faut-il animer du tout), `d(base)` (durée effective en secondes) et `spring`.
 */

export type MotionIntensity = "full" | "subtle" | "reduced";

/** Ressort framer-motion (littéral `type` pour rester assignable à `Transition`). */
export interface SpringToken {
  type: "spring";
  stiffness: number;
  damping: number;
}

/** Durées de base (secondes). */
export const dur = { fast: 0.15, base: 0.25, slow: 0.45 };

/** Courbes cubic-bezier (format tableau framer-motion). */
export const ease = { out: [0.2, 0.8, 0.2, 1], inOut: [0.65, 0, 0.35, 1] } as const;

/** Ressorts : `snappy` pour les réactions (boutons, sélection), `soft` pour les déplacements. */
export const springs: { snappy: SpringToken; soft: SpringToken } = {
  snappy: { type: "spring", stiffness: 520, damping: 34 },
  soft: { type: "spring", stiffness: 260, damping: 30 },
};

/** Facteur appliqué aux durées en intensité « Sobre ». */
const SUBTLE_FACTOR = 0.6;

export interface ResolvedMotion {
  /** `false` en Réduit ou si le système demande moins de mouvement : ne rien animer. */
  enabled: boolean;
  /** Durée effective (s) pour une durée de base : 0 si désactivé, raccourcie en Sobre. */
  d(base: number): number;
  /** Ressort à utiliser (doux en Sobre). Les consommateurs testent `enabled` avant d'animer. */
  spring: typeof springs.snappy;
}

/**
 * Résout l'intensité de mouvement effective. `prefers-reduced-motion` l'emporte toujours :
 * l'utilisateur système qui demande moins de mouvement n'en a pas, quel que soit le réglage.
 */
export function motionFor(intensity: MotionIntensity, prefersReduced: boolean): ResolvedMotion {
  const enabled = !prefersReduced && intensity !== "reduced";
  const subtle = intensity === "subtle";
  return {
    enabled,
    d(base: number): number {
      if (!enabled) return 0;
      return subtle ? base * SUBTLE_FACTOR : base;
    },
    spring: subtle ? springs.soft : springs.snappy,
  };
}
