import { useContext, useMemo, type ReactNode } from "react";
import { PresenceContext } from "framer-motion";

const noop = (): void => {};
const unregisterNoop = (): (() => void) => noop;

/**
 * Détache des éléments `layout` / `layoutId` de la présence de la page qui les contient.
 *
 * framer-motion 11.18 : `usePresence` (utilisé par la mesure de layout) s'enregistre auprès de
 * l'`AnimatePresence` parent mais ne se désenregistre JAMAIS au démontage (l'effet ignore le
 * nettoyage renvoyé par `register`). Dans une liste virtualisée, chaque tuile sortie de l'écran
 * laisse donc une entrée « en attente » : la sortie de la page ne se termine plus et la navigation
 * reste bloquée sur une page invisible.
 *
 * Ici, les descendants voient toujours `isPresent` de la page (la pochette prend son instantané à
 * la sortie : élément partagé tuile → en-tête), mais ne retiennent plus sa sortie : seule
 * l'animation de sortie de la page décide de son démontage.
 */
export function DetachedPresence({ children }: { children: ReactNode }): JSX.Element {
  const parent = useContext(PresenceContext);
  const value = useMemo(
    () => (parent ? { ...parent, register: unregisterNoop, onExitComplete: noop } : null),
    [parent],
  );
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
