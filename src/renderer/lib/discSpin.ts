/**
 * Rotation du disque laqué : 33⅓ tr/min (200°/s). La vitesse suit une rampe « smoothstep » entre
 * la vitesse courante et la cible — démarrage en douceur (ease-in), et à la pause une
 * décélération jusqu'à l'arrêt (ease-out), comme un plateau qui ralentit : jamais d'arrêt brutal.
 * Pur et piloté par `step(dt)` : le composant l'avance depuis sa boucle rAF.
 */

export const RPM_33_DEG_PER_SEC = (100 / 3) * 6; // 33⅓ tr/min × 360° / 60 s
/** Durée de la montée en régime (s). */
export const SPIN_UP_SEC = 0.9;
/** Durée de la décélération jusqu'à l'arrêt (s). */
export const SPIN_DOWN_SEC = 1.6;

export interface DiscSpin {
  setPlaying(playing: boolean): void;
  step(dt: number): void;
  /** Angle courant (degrés, [0, 360)). */
  angle(): number;
  /** Vitesse angulaire courante (°/s). */
  velocity(): number;
  /** `true` : immobile et sans rampe en cours — la boucle d'animation peut s'arrêter. */
  idle(): boolean;
  /** Arrêt immédiat (mouvement réduit) : vitesse nulle, angle conservé. */
  stop(): void;
}

const smoothstep = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

export function createDiscSpin(): DiscSpin {
  let angle = 0;
  let velocity = 0;
  let from = 0;
  let to = 0;
  let duration = 0;
  let elapsed = 0;
  let ramping = false;

  return {
    setPlaying(playing) {
      const target = playing ? RPM_33_DEG_PER_SEC : 0;
      if (target === to && (ramping || velocity === target)) return;
      from = velocity;
      to = target;
      // La rampe part de la vitesse courante : durée au prorata de l'écart restant.
      const full = playing ? SPIN_UP_SEC : SPIN_DOWN_SEC;
      duration = full * (Math.abs(to - from) / RPM_33_DEG_PER_SEC);
      elapsed = 0;
      ramping = duration > 0;
      if (!ramping) velocity = to;
    },
    step(dt) {
      if (!(dt > 0)) return;
      const before = velocity;
      if (ramping) {
        elapsed += dt;
        const p = smoothstep(elapsed / duration);
        velocity = from + (to - from) * p;
        if (elapsed >= duration) {
          velocity = to;
          ramping = false;
        }
      }
      // Intégration trapézoïdale : angle continu même pendant la rampe.
      angle = (angle + ((before + velocity) / 2) * dt) % 360;
      if (angle < 0) angle += 360;
    },
    angle: () => angle,
    velocity: () => velocity,
    idle: () => !ramping && velocity === 0,
    stop() {
      velocity = 0;
      from = 0;
      to = 0;
      ramping = false;
    },
  };
}
