import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "zustand";
import { X } from "lucide-react";
import { toastStore, type ToastItem } from "./toastStore";
import { ease, type ResolvedMotion } from "../theme/ds/motion";
import { ICON_STROKE } from "./IconButton";
import { useMotion } from "./useMotion";
import "./interaction.css";

export {
  toast,
  toastStore,
  TOAST_DEFAULT_MS,
  TOAST_MAX,
  type ToastOptions,
} from "./toastStore";

/** Décalage (px) d'arrivée : le toast glisse depuis le coin bas-droit. */
const TOAST_ENTER_PX = 18;

/**
 * Hôte des toasts : pile en bas à droite, au-dessus de la barre de lecteur, rendue dans
 * `document.body`. Le plus récent est le plus proche du coin ; 3 au plus (le plus ancien sort).
 * Chaque toast arrive sur un ressort depuis le coin, les autres se recalent (layout, transform
 * seul) ; le survol ou le focus suspend l'expiration. Région `aria-live="polite"` toujours montée,
 * pour que les lecteurs d'écran annoncent chaque ajout.
 */
export function ToastHost(): JSX.Element | null {
  const toasts = useStore(toastStore, (s) => s.toasts);
  const m = useMotion();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="toast-region" aria-live="polite" aria-relevant="additions text" aria-label="Notifications">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} m={m} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function ToastCard({ item, m }: { item: ToastItem; m: ResolvedMotion }): JSX.Element {
  const { pause, resume, dismiss } = toastStore.getState();
  const Icon = item.icon;
  const enabled = m.enabled;
  return (
    <motion.div
      layout={enabled ? "position" : false}
      className="toast"
      initial={enabled ? { opacity: 0, x: TOAST_ENTER_PX, y: TOAST_ENTER_PX, scale: 0.96 } : { opacity: 1 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, transition: enabled ? m.spring : { duration: 0 } }}
      exit={
        enabled
          ? { opacity: 0, x: TOAST_ENTER_PX, scale: 0.97, transition: { duration: m.d(0.18), ease: ease.inOut } }
          : { opacity: 0, transition: { duration: 0 } }
      }
      transition={enabled ? m.spring : { duration: 0 }}
      onPointerEnter={() => pause(item.id)}
      onPointerLeave={() => resume(item.id)}
      onFocus={() => pause(item.id)}
      onBlur={() => resume(item.id)}
    >
      {Icon ? (
        <span className="toast-icon" aria-hidden="true">
          <Icon size={16} strokeWidth={ICON_STROKE} />
        </span>
      ) : null}
      <span className="toast-msg">{item.message}</span>
      {item.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            dismiss(item.id);
            item.action?.onClick();
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="Fermer la notification" onClick={() => dismiss(item.id)}>
        <X size={14} strokeWidth={ICON_STROKE} aria-hidden />
      </button>
    </motion.div>
  );
}
