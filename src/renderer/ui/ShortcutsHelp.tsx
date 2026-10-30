import { Fragment, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { X } from "lucide-react";
import { uiStore, useUi } from "../state/ui";
import { SHORTCUT_GROUPS, shortcutKeys } from "../lib/shortcuts";
import { useFocusTrap } from "../lib/focusTrap";
import { dur, ease } from "../theme/ds/motion";
import { IconButton } from "./IconButton";
import { useMotion } from "./useMotion";
import "./interaction.css";

const close = (): void => uiStore.getState().setShortcutsHelpOpen(false);

/**
 * Aide des raccourcis (« ? ») : dialogue modal listant chaque raccourci en français, groupé
 * (Lecture / Navigation / Général). Piège de focus (Échap ferme, le focus revient où il était),
 * fermeture au clic sur le voile. Entrée en fondu + léger zoom ; instantanée en mouvement réduit.
 */
export function ShortcutsHelp(): JSX.Element | null {
  const open = useUi((s) => s.shortcutsHelpOpen);
  if (typeof document === "undefined") return null;
  return createPortal(<AnimatePresence>{open && <HelpDialog key="help" />}</AnimatePresence>, document.body);
}

function HelpDialog(): JSX.Element {
  const m = useMotion();
  const isPresent = useIsPresent();
  const cardRef = useRef<HTMLDivElement>(null);
  // Actif tant que le dialogue est présent : à la sortie, le focus revient tout de suite.
  useFocusTrap(cardRef, { active: isPresent, onEscape: close });

  const fade = { duration: m.d(dur.base), ease: ease.out };
  return (
    <motion.div
      className="help-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: fade }}
      exit={{ opacity: 0, transition: { duration: m.d(dur.fast), ease: ease.inOut } }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.div
        ref={cardRef}
        className="help-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        initial={m.enabled ? { opacity: 0, scale: 0.97, y: 8 } : { opacity: 1 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: m.enabled ? m.spring : { duration: 0 } }}
        exit={m.enabled ? { opacity: 0, scale: 0.98, transition: { duration: m.d(dur.fast) } } : { opacity: 0 }}
      >
        <header className="help-head">
          <div>
            <div className="help-eyebrow">鍵盤 · clavier</div>
            <h2 id="help-title" className="help-title">
              Raccourcis clavier
            </h2>
          </div>
          <IconButton label="Fermer l'aide" icon={X} size={32} onClick={close} />
        </header>

        <div className="help-groups">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className="help-group" aria-label={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map((it) => (
                  <div key={it.action} className="help-row">
                    <dt>{it.label}</dt>
                    <dd>
                      {shortcutKeys(it.action).map((k, i) => (
                        <Fragment key={k + i}>
                          {i > 0 && <span className="help-plus" aria-hidden="true">+</span>}
                          <kbd>{k}</kbd>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="help-foot">
          Les raccourcis restent muets pendant la saisie ; seule <kbd>Échap</kbd> y est active.
        </p>
      </motion.div>
    </motion.div>
  );
}
