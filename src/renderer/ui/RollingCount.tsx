import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { dur, ease } from "../theme/ds/motion";
import { useMotion } from "./useMotion";

/**
 * Nombre qui « roule » quand il change : l'ancien sort vers le haut, le nouveau monte d'en dessous
 * (sens inverse quand il baisse). Transform/opacity seulement ; valeur posée sans animation en
 * mouvement réduit.
 */
export function RollingCount({ value, className }: { value: number; className?: string }): JSX.Element {
  const m = useMotion();
  const prev = useRef(value);
  const dir = value >= prev.current ? 1 : -1;
  useEffect(() => {
    prev.current = value;
  }, [value]);

  if (!m.enabled) return <span className={className}>{value}</span>;
  const t = { duration: m.d(dur.base + 0.07), ease: ease.out };
  return (
    <span className={`roll${className ? ` ${className}` : ""}`}>
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        <motion.span
          key={value}
          className="roll__v"
          custom={dir}
          variants={{
            enter: (d: number) => ({ y: d > 0 ? "90%" : "-90%", opacity: 0 }),
            show: { y: "0%", opacity: 1, transition: t },
            leave: (d: number) => ({ y: d > 0 ? "-90%" : "90%", opacity: 0, transition: t }),
          }}
          initial="enter"
          animate="show"
          exit="leave"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
