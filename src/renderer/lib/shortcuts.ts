import { useEffect, useRef } from "react";

/**
 * Raccourcis clavier globaux (Phase 3, Tâche 4).
 *
 * Les combinaisons sont exprimées en `KeyboardEvent.code` (position physique de la touche, stable
 * quelle que soit la disposition) préfixées des modificateurs dans l'ordre canonique
 * `Ctrl+Alt+Shift+Meta+`. La correspondance est EXACTE : un modificateur en trop ne déclenche rien.
 *
 * Règles de sécurité de saisie (Review Focus) :
 *  - dans un champ (`INPUT`, `TEXTAREA`, `SELECT`, contentEditable) seule `close` (Échap) agit —
 *    un Espace tapé dans la recherche ne lance/coupe JAMAIS la lecture ;
 *  - un Espace sur un bouton / élément interactif focalisé est laissé à l'élément (il s'active
 *    lui-même) : la bascule globale ne s'y ajoute pas (pas de double déclenchement).
 *
 * Extension additive au brief : `back` / `forward` (Alt+←/→) pilotent l'historique du routeur.
 */

export type Action =
  | "toggle"
  | "next"
  | "prev"
  | "seekFwd"
  | "seekBack"
  | "search"
  | "favorite"
  | "close"
  | "help"
  | "settings"
  | "back"
  | "forward";

export const KEYMAP: Record<Action, string> = {
  toggle: "Space",
  next: "Ctrl+ArrowRight",
  prev: "Ctrl+ArrowLeft",
  seekFwd: "Shift+ArrowRight",
  seekBack: "Shift+ArrowLeft",
  search: "Ctrl+KeyF",
  favorite: "Ctrl+KeyL",
  close: "Escape",
  help: "Shift+Slash",
  settings: "Ctrl+Comma",
  back: "Alt+ArrowLeft",
  forward: "Alt+ArrowRight",
};

/** Cible d'un événement clavier, réduite à ce que la correspondance lit (testable sans DOM). */
export interface ShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
}

export interface ShortcutEventLike {
  code: string;
  /** Caractère produit (optionnel) : sert au repli « ? » des dispositions non-QWERTY. */
  key?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: ShortcutTarget | null;
}

/** Index inverse combinaison → action. */
const BY_COMBO: ReadonlyMap<string, Action> = new Map(
  (Object.entries(KEYMAP) as [Action, string][]).map(([action, combo]) => [combo, action]),
);

/** Combinaison canonique d'un événement (`Ctrl+Alt+Shift+Meta+code`). */
export function comboOf(e: Omit<ShortcutEventLike, "target" | "key">): string {
  return (
    (e.ctrlKey ? "Ctrl+" : "") +
    (e.altKey ? "Alt+" : "") +
    (e.shiftKey ? "Shift+" : "") +
    (e.metaKey ? "Meta+" : "") +
    e.code
  );
}

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** Éléments qui s'activent eux-mêmes à l'Espace. */
const SPACE_ACTIVATED_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const SPACE_ACTIVATED_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "option",
]);

function isTextEntry(t: ShortcutTarget | null): boolean {
  if (!t) return false;
  if (t.isContentEditable === true) return true;
  return TEXT_ENTRY_TAGS.has((t.tagName ?? "").toUpperCase());
}

function activatesOnSpace(t: ShortcutTarget | null): boolean {
  if (!t) return false;
  if (SPACE_ACTIVATED_TAGS.has((t.tagName ?? "").toUpperCase())) return true;
  const role = typeof t.getAttribute === "function" ? t.getAttribute("role") : null;
  return role !== null && SPACE_ACTIVATED_ROLES.has(role.toLowerCase());
}

/**
 * Action correspondant à un événement clavier, ou `null`. Renvoie `null` si la cible est un champ
 * de saisie (sauf pour `close`) et pour un Espace sur un élément qui s'active lui-même.
 */
export function matchShortcut(e: ShortcutEventLike): Action | null {
  let action: Action | null = BY_COMBO.get(comboOf(e)) ?? null;
  // « ? » produit par une autre disposition (AZERTY : Maj+KeyM) : l'aide reste accessible.
  if (action === null && e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey) action = "help";
  if (action === null) return null;
  if (action !== "close" && isTextEntry(e.target)) return null;
  if (action === "toggle" && activatesOnSpace(e.target)) return null;
  return action;
}

/** Actions pour lesquelles la répétition automatique (touche maintenue) a un sens. */
const REPEATABLE: ReadonlySet<Action> = new Set<Action>(["seekFwd", "seekBack"]);

export type ShortcutHandlers = Partial<Record<Action, () => void>>;

export interface ShortcutKeyboardEvent extends ShortcutEventLike {
  repeat: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
  preventDefault(): void;
}

/**
 * Traite un `keydown` : ignore les événements déjà traités (un piège de focus ou un composant a
 * appelé `preventDefault`), la composition IME et la répétition (sauf avance/recul) ; sinon appelle
 * le gestionnaire de l'action et empêche l'action par défaut (pas de défilement sur Espace, pas de
 * recherche native sur Ctrl+F). Sans gestionnaire, l'événement est laissé intact.
 */
export function handleShortcutEvent(e: ShortcutKeyboardEvent, handlers: ShortcutHandlers): Action | null {
  if (e.defaultPrevented || e.isComposing === true) return null;
  const action = matchShortcut(e);
  if (action === null) return null;
  const handler = handlers[action];
  if (!handler) return null;
  if (e.repeat && !REPEATABLE.has(action)) {
    e.preventDefault(); // pas de rafale, mais pas non plus de défilement de page
    return null;
  }
  e.preventDefault();
  handler();
  return action;
}

/**
 * Branche les raccourcis globaux sur `window` (phase de bouillonnement : les pièges de focus et les
 * composants traitent la touche d'abord). Les gestionnaires sont lus via une ref : leur identité
 * peut changer à chaque rendu sans ré-attacher l'écouteur.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      handleShortcutEvent(
        {
          code: e.code,
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
          defaultPrevented: e.defaultPrevented,
          isComposing: e.isComposing,
          target: e.target instanceof Element ? (e.target as HTMLElement) : null,
          preventDefault: () => e.preventDefault(),
        },
        ref.current,
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

// --- Aide des raccourcis -------------------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Maj",
  Meta: "Win",
  Space: "Espace",
  Escape: "Échap",
  ArrowRight: "→",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Comma: ",",
  Slash: "/",
};

/** Touches d'une action, libellées en français pour l'aide (`["Ctrl", "→"]`). */
export function shortcutKeys(action: Action): string[] {
  // « ? » se lit mieux que « Maj + / » (et vaut pour toutes les dispositions, cf. matchShortcut).
  if (action === "help") return ["?"];
  return KEYMAP[action].split("+").map((part) => {
    if (KEY_LABELS[part]) return KEY_LABELS[part]!;
    if (part.startsWith("Key")) return part.slice(3);
    if (part.startsWith("Digit")) return part.slice(5);
    return part;
  });
}

export interface ShortcutGroup {
  title: string;
  items: { action: Action; label: string }[];
}

/** Contenu de l'aide (« ? ») : chaque action une fois, décrite en français. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Lecture",
    items: [
      { action: "toggle", label: "Lecture / pause" },
      { action: "next", label: "Titre suivant" },
      { action: "prev", label: "Titre précédent" },
      { action: "seekFwd", label: "Avancer de 10 secondes" },
      { action: "seekBack", label: "Reculer de 10 secondes" },
      { action: "favorite", label: "Titre en cours : favori oui / non" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { action: "search", label: "Rechercher" },
      { action: "back", label: "Page précédente" },
      { action: "forward", label: "Page suivante" },
      { action: "settings", label: "Ouvrir les réglages" },
    ],
  },
  {
    title: "Général",
    items: [
      { action: "close", label: "Fermer le menu, l'aide ou le panneau" },
      { action: "help", label: "Afficher / masquer cette aide" },
    ],
  },
];
