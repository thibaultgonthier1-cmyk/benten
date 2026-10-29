import { forwardRef, type ReactNode } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { useSpringPress } from "./useMotion";
import { ICON_STROKE } from "./IconButton";
import "./ui.css";

export type ButtonVariant = "primary" | "ghost" | "subtle";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  /** `primary` : dégradé magenta + reflet + ombre ; `ghost` : surface neutre ; `subtle` : texte. */
  variant?: ButtonVariant;
  /** Icône lucide optionnelle, placée avant le libellé. */
  icon?: LucideIcon;
  size?: "m" | "s";
  children?: ReactNode;
}

/**
 * Bouton du design system : matière douce (jamais de 3D), ressort au survol/clic
 * (`whileHover` 1.03, `whileTap` 0.96), coupé en mouvement réduit.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", icon: Icon, size = "m", className, children, type = "button", disabled, ...rest },
  ref,
) {
  const press = useSpringPress(disabled ?? undefined);
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      className={`ui-btn ui-btn--${variant} ui-btn--${size}${className ? ` ${className}` : ""}`}
      {...press}
      {...rest}
    >
      {Icon && <Icon className="ui-btn__icon" size={size === "s" ? 15 : 17} strokeWidth={ICON_STROKE} aria-hidden />}
      {children != null && <span className="ui-btn__label">{children}</span>}
    </motion.button>
  );
});
