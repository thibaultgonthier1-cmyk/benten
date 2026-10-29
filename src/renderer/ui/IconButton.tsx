import { forwardRef } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { useSpringPress } from "./useMotion";
import "./ui.css";

/** Épaisseur de trait commune à toutes les icônes lucide de l'app (jeu cohérent). */
export const ICON_STROKE = 1.75;

export interface IconButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  /** Libellé accessible (aria-label + infobulle). */
  label: string;
  icon: LucideIcon;
  /** `plain` : transparent ; `solid` : surface neutre bordée. */
  variant?: "plain" | "solid";
  /** État actif (bascule) : icône à l'accent. */
  active?: boolean;
  /** Taille du bouton (px) ; l'icône suit. */
  size?: number;
}

/** Bouton icône rond du design system, même ressort que `Button`. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, variant = "plain", active = false, size = 34, className, type = "button", disabled, style, ...rest },
  ref,
) {
  const press = useSpringPress(disabled ?? undefined);
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={`ui-icon-btn ui-icon-btn--${variant}${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, ...style }}
      {...press}
      {...rest}
    >
      <Icon size={Math.round(size * 0.53)} strokeWidth={ICON_STROKE} aria-hidden />
    </motion.button>
  );
});
