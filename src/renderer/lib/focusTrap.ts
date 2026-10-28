import { useEffect, useRef, type RefObject } from "react";

/**
 * Index suivant dans un cycle de focus : Tab avance (`shiftKey=false`), Shift-Tab recule, avec
 * enroulement aux deux extremites. PUR — aucune dependance au DOM — donc testable directement et
 * reutilise par `useFocusTrap`.
 *
 * `nextFocusIndex(2, 3, false) === 0` (dernier -> premier), `nextFocusIndex(0, 3, true) === 2`
 * (premier -> dernier). `count <= 0` renvoie 0 (pas de cible : evite NaN / index negatif).
 */
export function nextFocusIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return 0;
  const delta = shiftKey ? -1 : 1;
  return (current + delta + count) % count;
}

/** Selecteur des elements naturellement tabbables (hors `tabindex="-1"` et desactives). */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Elements focusables VISIBLES contenus dans `root`, dans l'ordre du document. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getClientRects().length > 0 &&
      el.getAttribute("aria-hidden") !== "true",
  );
}

export interface FocusTrapOptions {
  /** Le piege n'agit que lorsque `active` est vrai ; sinon le hook ne pose rien. */
  active: boolean;
  /** Appele quand Echap est presse pendant que le piege est actif. */
  onEscape?: () => void;
}

/**
 * Piege de focus pour un conteneur modal (role="dialog" + aria-modal poses par l'appelant).
 *
 * Quand `active` : deplace le focus a l'interieur si besoin, confine Tab/Shift-Tab au conteneur
 * via `nextFocusIndex`, declenche `onEscape` sur Echap, et RESTAURE le focus sur l'element
 * precedemment actif au desactivation/demontage. Inactif : ne pose aucun ecouteur, ne touche a
 * rien.
 *
 * L'ecouteur est attache au conteneur (pas a `window`) : un piege imbrique (p.ex. feuille qualite
 * dans la vue lecture) traite l'evenement en premier et appelle `preventDefault()`, ce que le
 * piege parent respecte via `event.defaultPrevented`.
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, { active, onEscape }: FocusTrapOptions): void {
  // onEscape garde en ref : son identite peut changer a chaque rendu sans re-armer le piege
  // (ce qui volerait/restaurerait le focus a contretemps). L'effet ne depend que de `active`.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Amene le focus dans le piege s'il n'y est pas deja.
    if (!root.contains(document.activeElement)) {
      const initial = focusableWithin(root);
      if (initial.length > 0) initial[0].focus();
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return; // un piege imbrique a deja traite la touche.

      if (e.key === "Escape") {
        e.preventDefault();
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;

      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const activeEl = document.activeElement as HTMLElement | null;
      const idx = activeEl ? items.indexOf(activeEl) : -1;
      if (idx === -1) {
        // Focus hors de la liste connue : repart du bord selon le sens.
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
        return;
      }
      items[nextFocusIndex(idx, items.length, e.shiftKey)].focus();
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [active, ref]);
}
