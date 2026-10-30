import type React from "react";
import { useContext, useMemo, type ReactNode } from "react";
import { PresenceContext } from "framer-motion";

type PresenceValue = NonNullable<React.ContextType<typeof PresenceContext>>;

const noop = (): void => {};
const unregisterNoop = (): (() => void) => noop;

/**
 * Valeur de présence « détachée » (pure, testée) : même `isPresent` / `custom` / `initial` que la
 * page, mais `register` et `onExitComplete` neutres — les descendants ne retiennent plus la sortie.
 * Hors `AnimatePresence` (`null`) : inchangé.
 */
export function detachedPresenceValue(parent: PresenceValue | null): PresenceValue | null {
  return parent ? { ...parent, register: unregisterNoop, onExitComplete: noop } : null;
}

/**
 * Détache le CONTENU d'une page de la présence de la page elle-même.
 *
 * framer-motion 11.18 : `usePresence` (utilisé par la mesure de layout des éléments `layout` /
 * `layoutId`) s'enregistre auprès de l'`AnimatePresence` parent mais ne se désenregistre JAMAIS
 * au démontage (l'effet ignore le nettoyage renvoyé par `register`). Tout élément de layout démonté
 * pendant que sa page est présente — tuile virtualisée sortie de l'écran, pochette d'en-tête d'un
 * album retiré de la bibliothèque (« Album introuvable ») — laisse une entrée « en attente » : la
 * sortie de la page ne se termine plus et une page invisible reste montée par-dessus.
 *
 * Ici, les descendants voient toujours `isPresent` de la page (la pochette prend son instantané à
 * la sortie : élément partagé tuile ↔ en-tête), mais seule l'animation de sortie de la page
 * (le `motion.div` de route, hors de ce fournisseur) décide de son démontage.
 */
export function DetachedPresence({ children }: { children: ReactNode }): JSX.Element {
  const parent = useContext(PresenceContext);
  const value = useMemo(() => detachedPresenceValue(parent), [parent]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
