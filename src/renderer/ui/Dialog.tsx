import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { useFocusTrap } from "../lib/focusTrap";
import { dur, ease } from "../theme/ds/motion";
import { Button } from "./Button";
import { useMotion } from "./useMotion";
import "./dialog.css";

export interface DialogAction {
  label: string;
  onClick(): void;
  /** `primary` : action principale (accent) ; `ghost` (défaut) : secondaire. */
  variant?: "primary" | "ghost";
  icon?: LucideIcon;
  disabled?: boolean;
  /** Bouton de validation : Entrée dans un champ du dialogue le déclenche. */
  submit?: boolean;
  /** Reçoit le focus à l'ouverture (si aucun `initialFocus` n'est donné). */
  autoFocus?: boolean;
}

export interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  /** Boutons du pied, de gauche à droite (l'action principale en dernier, comme macOS / Apple). */
  actions?: readonly DialogAction[];
  /** Sur-titre (mincho, accent). */
  eyebrow?: string;
  /** Texte d'explication sous le titre. */
  description?: ReactNode;
  children?: ReactNode;
  /** Élément focalisé (et sélectionné, pour un champ) à l'ouverture. */
  initialFocus?: RefObject<HTMLElement>;
  /** Ref de la carte (point de départ d'une animation, mesure). */
  cardRef?: RefObject<HTMLDivElement>;
}

/**
 * Dialogue modal du design system (remplace `window.confirm`) : voile flouté, carte « matière »,
 * titre mincho. Accessible : `role="dialog"` + `aria-modal`, titre et description liés, piège de
 * focus (`lib/focusTrap` : Tab confiné, Échap ferme, focus rendu à la fermeture), clic sur le voile
 * pour fermer. Entrée en fondu + léger ressort ; instantanée en mouvement réduit (`useMotion`).
 */
export function Dialog(props: DialogProps): JSX.Element | null {
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>{props.open && <DialogCard key="dialog" {...props} />}</AnimatePresence>,
    document.body,
  );
}

function DialogCard({
  title,
  onClose,
  actions = [],
  eyebrow,
  description,
  children,
  initialFocus,
  cardRef,
}: DialogProps): JSX.Element {
  const m = useMotion();
  const isPresent = useIsPresent();
  const localRef = useRef<HTMLDivElement>(null);
  const ref = cardRef ?? localRef;
  const titleId = useId();
  const descId = useId();
  // Actif tant que le dialogue est présent : à la sortie, le focus revient tout de suite.
  useFocusTrap(ref, { active: isPresent, onEscape: onClose });

  useEffect(() => {
    const target =
      initialFocus?.current ?? ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? null;
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
  }, []);

  const submit = actions.find((a) => a.submit);
  const fade = { duration: m.d(dur.base), ease: ease.out };

  return (
    <motion.div
      className="dlg-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: fade }}
      exit={{ opacity: 0, transition: { duration: m.d(dur.fast), ease: ease.inOut } }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={ref}
        className="dlg-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        initial={m.enabled ? { opacity: 0, scale: 0.96, y: 10 } : { opacity: 1 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: m.enabled ? m.spring : { duration: 0 } }}
        exit={m.enabled ? { opacity: 0, scale: 0.98, transition: { duration: m.d(dur.fast) } } : { opacity: 0 }}
      >
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (submit && !submit.disabled) submit.onClick();
          }}
        >
          <header className="dlg-head">
            {eyebrow && <div className="dlg-eyebrow">{eyebrow}</div>}
            <h2 id={titleId} className="dlg-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="dlg-desc">
                {description}
              </p>
            )}
          </header>
          {children && <div className="dlg-body">{children}</div>}
          {actions.length > 0 && (
            <footer className="dlg-actions">
              {actions.map((a) => (
                <Button
                  key={a.label}
                  type={a.submit ? "submit" : "button"}
                  variant={a.variant ?? "ghost"}
                  icon={a.icon}
                  disabled={a.disabled}
                  data-autofocus={a.autoFocus || undefined}
                  onClick={a.submit ? undefined : a.onClick}
                >
                  {a.label}
                </Button>
              ))}
            </footer>
          )}
        </form>
      </motion.div>
    </motion.div>
  );
}
