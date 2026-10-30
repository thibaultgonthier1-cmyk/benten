import { memo, useCallback, useState, type CSSProperties, type MouseEvent } from "react";
import { motion } from "framer-motion";
import { assetUrl } from "../assets/manifest";
import { fxHostMounted, requestFx } from "./FxOverlay";
import { useMotionLevel } from "./useMotion";
import "./signature.css";

/**
 * Médaillon d'or — bouton lecture/pause signature de la DA « Biwa & Or ».
 *
 * Disque d'or « matière » (dégradé radial discret, reflet interne en haut, ombre interne en bas,
 * fin guilloché) sans relief 3D, glyphe sombre (`--on-accent`). Lecture ⇄ pause se transforment
 * l'une en l'autre (morph de tracés : deux moitiés de triangle deviennent deux barres). Survol :
 * un reflet de lumière traverse le disque. Appui : ressort. Clic : onde de pincement dorée via
 * `FxOverlay` (ou un anneau CSS local si aucun hôte d'effets n'est monté). Point de branchement :
 * texture `tex.goldLeaf`. Réduit : aucun mouvement, changements instantanés.
 */

export type MedallionSize = "sm" | "md" | "lg";

export interface GoldMedallionProps {
  playing: boolean;
  size?: MedallionSize;
  onToggle(): void;
  /** Libellé accessible ; par défaut « Pause » en lecture, « Lecture » sinon. */
  label?: string;
  disabled?: boolean;
  className?: string;
  /** Focus clavier initial, infobulle… */
  title?: string;
}

const DIAMETER: Readonly<Record<MedallionSize, number>> = { sm: 32, md: 44, lg: 64 };

// Morph : la pause (deux barres) et la lecture (triangle coupé en deux moitiés) ont la même
// structure de commandes — la transition CSS de `d` interpole point à point (signature.css).
const PLAY_A = "M7.5 4.8 L13 8.2 L13 15.8 L7.5 19.2 Z";
const PLAY_B = "M13 8.2 L18.6 12 L18.6 12 L13 15.8 Z";
const PAUSE_A = "M6.6 5.2 L10.2 5.2 L10.2 18.8 L6.6 18.8 Z";
const PAUSE_B = "M13.8 5.2 L17.4 5.2 L17.4 18.8 L13.8 18.8 Z";

function GoldMedallionImpl({
  playing,
  size = "md",
  onToggle,
  label,
  disabled,
  className,
  title,
}: GoldMedallionProps): JSX.Element {
  const level = useMotionLevel();
  const still = level.fx === "none";
  const [ring, setRing] = useState(0);
  const tex = assetUrl("tex.goldLeaf");
  const d = DIAMETER[size];

  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>): void => {
      onToggle();
      if (still) return;
      const r = e.currentTarget.getBoundingClientRect();
      const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (fxHostMounted()) requestFx("pluck", at, { size: r.width * 4.2, level });
      else setRing((n) => n + 1);
    },
    [onToggle, still, level],
  );

  const style = { "--gm-d": `${d}px`, ...(tex ? { "--gm-tex": `url("${tex}")` } : null) } as CSSProperties;
  const name = label ?? (playing ? "Pause" : "Lecture");

  return (
    <motion.button
      type="button"
      className={`gm gm--${size}${still ? " is-still" : ""}${tex ? " has-tex" : ""}${className ? ` ${className}` : ""}`}
      data-playing={playing ? "true" : "false"}
      aria-label={name}
      aria-pressed={playing}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      whileHover={still || disabled ? undefined : { scale: 1.04 }}
      whileTap={still || disabled ? undefined : { scale: 0.9 }}
      transition={{ type: "spring", stiffness: 640, damping: 17, mass: 0.7 }}
    >
      <span className="gm__disc" aria-hidden="true">
        <span className="gm__engrave" />
        <span className="gm__sweep" />
      </span>
      <svg className="gm__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path className="gm__half gm__half--a" d={playing ? PAUSE_A : PLAY_A} />
        <path className="gm__half gm__half--b" d={playing ? PAUSE_B : PLAY_B} />
      </svg>
      {ring > 0 && <span key={ring} className="gm__ring" aria-hidden="true" />}
    </motion.button>
  );
}

export const GoldMedallion = memo(GoldMedallionImpl);
