import { createStore, type StoreApi } from "zustand/vanilla";
import type { LucideIcon } from "lucide-react";

/**
 * Store du menu contextuel (Phase 3, Tâche 4) — pur, sans React. Un seul menu à la fois : en
 * ouvrir un remplace le précédent. L'hôte `<ContextMenuHost>` (ContextMenu.tsx) le rend.
 *
 * Focus : l'élément actif au moment de l'ouverture est mémorisé ; `closeMenu()` le refocalise
 * (SYNCHRONEMENT, avant que l'action choisie ne s'exécute : une feuille ouverte par l'action
 * capture ainsi le bon « précédent focus » pour son propre piège).
 */

export type MenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      onSelect?: () => void;
      danger?: boolean;
      submenu?: MenuItem[];
      disabled?: boolean;
    }
  | "separator";

export interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  /** Identifiant d'ouverture (clé d'animation : chaque ouverture rejoue l'entrée). */
  seq: number;
  /** Ouverture au clavier (Maj+F10 / touche Menu) : le 1er élément reçoit le focus. */
  focusFirst: boolean;
}

export type MenuStore = StoreApi<MenuState>;

export const menuStore: MenuStore = createStore<MenuState>(() => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  seq: 0,
  focusFirst: false,
}));

/** Élément à refocaliser à la fermeture (hors état rendu). */
let returnFocus: { focus?: () => void } | null = null;

const isActionable = (item: MenuItem | undefined): boolean =>
  item !== undefined && item !== "separator" && item.disabled !== true;

/** Ouvre le menu au point (x, y) — coordonnées client de la fenêtre. */
export function openMenu(
  x: number,
  y: number,
  items: MenuItem[],
  opts: { focusFirst?: boolean } = {},
): void {
  if (!items.some((i) => i !== "separator")) return;
  if (!menuStore.getState().open) {
    const active = typeof document !== "undefined" ? (document.activeElement as { focus?: () => void } | null) : null;
    returnFocus = active ?? null;
  }
  menuStore.setState((s) => ({
    open: true,
    x,
    y,
    items,
    seq: s.seq + 1,
    focusFirst: opts.focusFirst === true,
  }));
}

/** Ferme le menu ; refocalise par défaut l'élément actif à l'ouverture. */
export function closeMenu(opts: { restoreFocus?: boolean } = {}): void {
  if (!menuStore.getState().open) return;
  menuStore.setState({ open: false });
  const target = returnFocus;
  returnFocus = null;
  if (opts.restoreFocus !== false && target && typeof target.focus === "function") {
    try {
      target.focus();
    } catch {
      /* élément détaché : rien à refocaliser */
    }
  }
}

/** Position d'un menu de taille (w, h) ouvert au point (x, y), gardé dans la fenêtre. */
export interface MenuPlacement {
  left: number;
  top: number;
  /** Point de clic relatif au menu : origine de l'animation d'ouverture (`transform-origin`). */
  originX: number;
  originY: number;
}

/**
 * Place le menu à droite/en dessous du curseur ; s'il déborde, il bascule à gauche/au-dessus du
 * curseur (comme un menu natif), puis il est borné à `margin` des bords. L'origine suit le point de
 * clic, pour que le menu « pousse » depuis le curseur.
 */
export function placeMenu(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = 8,
): MenuPlacement {
  let left = x;
  let top = y;
  if (left + w > vw - margin) left = x - w;
  if (top + h > vh - margin) top = y - h;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  top = Math.max(margin, Math.min(top, vh - margin - h));
  // Plus grand que la fenêtre : la marge de départ l'emporte.
  if (left < margin) left = margin;
  if (top < margin) top = margin;
  return { left, top, originX: x - left, originY: y - top };
}

/**
 * Index du prochain élément activable dans la direction `dir` (+1 / −1), en boucle, en sautant
 * séparateurs et éléments désactivés. `from = -1` part du bord. `-1` si aucun élément n'est actif.
 */
export function nextMenuIndex(items: readonly MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  if (i < 0 || i >= n) i = dir === 1 ? -1 : n;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (isActionable(items[i])) return i;
  }
  return -1;
}
