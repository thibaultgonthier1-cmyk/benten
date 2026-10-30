import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useStore } from "zustand";
import { ChevronRight } from "lucide-react";
import { closeMenu, menuStore, nextMenuIndex, placeMenu, type MenuItem, type MenuPlacement } from "./menuStore";
import { uiStore } from "../state/ui";
import { ease } from "../theme/ds/motion";
import { ICON_STROKE } from "./IconButton";
import { useMotion } from "./useMotion";
import type { ResolvedMotion } from "../theme/ds/motion";
import "./interaction.css";

export { closeMenu, menuStore, openMenu, type MenuItem } from "./menuStore";

/** Marge minimale (px) entre un menu et les bords de la fenêtre. */
const EDGE = 8;
/** Durées (s) d'entrée / sortie d'un menu, avant `motionFor`. */
const MENU_IN_SEC = 0.16;
const MENU_OUT_SEC = 0.1;
/**
 * Intention de survol (ms) : quitter l'élément d'un sous-menu ouvert vers un voisin ne le ferme (ou
 * ne bascule vers un autre) qu'après ce délai — le temps de rejoindre le sous-menu en diagonale.
 */
export const SUBMENU_INTENT_MS = 150;

type Positioner = (w: number, h: number) => MenuPlacement;

/**
 * Hôte du menu contextuel : monté une fois par le Shell, rendu dans `document.body` (au-dessus de
 * l'écran de lecture et des feuilles). Le menu « pousse » depuis le point de clic (`transform-origin`
 * = curseur), reste dans la fenêtre, se pilote au clavier (↑/↓/Début/Fin, Entrée/Espace, → ← pour
 * les sous-menus, Échap/Tab pour fermer) et se ferme au clic extérieur, au défilement, au
 * redimensionnement, à la perte de focus de la fenêtre et au changement de page.
 */
export function ContextMenuHost(): JSX.Element | null {
  const open = useStore(menuStore, (s) => s.open);
  const x = useStore(menuStore, (s) => s.x);
  const y = useStore(menuStore, (s) => s.y);
  const items = useStore(menuStore, (s) => s.items);
  const seq = useStore(menuStore, (s) => s.seq);
  const focusFirst = useStore(menuStore, (s) => s.focusFirst);

  // Fermeture sur interaction extérieure (tant qu'un menu est ouvert).
  useEffect(() => {
    if (!open) return;
    const inMenu = (t: EventTarget | null): boolean =>
      t instanceof Element && t.closest(".cm-panel") !== null;
    const onPointerDown = (e: PointerEvent): void => {
      if (!inMenu(e.target)) closeMenu();
    };
    const onScroll = (e: Event): void => {
      if (!inMenu(e.target)) closeMenu({ restoreFocus: false });
    };
    const onDismiss = (): void => closeMenu({ restoreFocus: false });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    const offRoute = uiStore.subscribe((next, prev) => {
      if (next.route !== prev.route) closeMenu({ restoreFocus: false });
    });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
      offRoute();
    };
  }, [open]);

  const position = useCallback<Positioner>(
    (w, h) => placeMenu(x, y, w, h, window.innerWidth, window.innerHeight, EDGE),
    [x, y],
  );

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <MenuList
          key={seq}
          items={items}
          position={position}
          focusFirst={focusFirst}
          label="Menu contextuel"
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface MenuListProps {
  items: MenuItem[];
  position: Positioner;
  /** Focalise le 1er élément au montage (clavier / sous-menu) ; sinon le panneau lui-même. */
  focusFirst: boolean;
  label: string;
  /** Sous-menu : ferme ce niveau et rend le focus à l'élément parent. */
  onBack?: () => void;
  /** Sous-menu : le pointeur y entre (annule une fermeture différée du parent). */
  onPointerEnterPanel?: () => void;
}

interface OpenSub {
  index: number;
  rect: DOMRect;
  focusFirst: boolean;
}

function MenuList({ items, position, focusFirst, label, onBack, onPointerEnterPanel }: MenuListProps): JSX.Element {
  const m = useMotion();
  const isPresent = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const [sub, setSub] = useState<OpenSub | null>(null);

  // Changement de sous-menu différé (intention de survol). `pendingSub` : cible planifiée
  // (index, ou `null` = fermer) — un mouvement vers la même cible ne relance pas le délai.
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSub = useRef<number | null | undefined>(undefined);
  const cancelSubChange = (): void => {
    if (subTimer.current !== null) clearTimeout(subTimer.current);
    subTimer.current = null;
    pendingSub.current = undefined;
  };
  const scheduleSubChange = (target: number | null): void => {
    if (pendingSub.current === target) return;
    cancelSubChange();
    pendingSub.current = target;
    subTimer.current = setTimeout(() => {
      subTimer.current = null;
      pendingSub.current = undefined;
      if (target === null) setSub(null);
      else openSub(target, false);
    }, SUBMENU_INTENT_MS);
  };
  useEffect(() => cancelSubChange, []);

  // Mesure avant peinture : la position finale est posée avant la 1re image (pas de saut). Une
  // seule fois par panneau : chaque ouverture (ou sous-menu) est un nouveau montage (clé dédiée).
  const positionRef = useRef(position);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPlace(positionRef.current(el.offsetWidth, el.offsetHeight));
  }, []);

  const buttons = (): HTMLButtonElement[] =>
    Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>(":scope > .cm-item") ?? []);
  const focusIndex = (i: number): void => {
    buttons()
      .find((b) => Number(b.dataset.index) === i)
      ?.focus({ preventScroll: true });
  };
  const focusedIndex = (): number => {
    const a = document.activeElement as HTMLElement | null;
    return a && panelRef.current?.contains(a) && a.dataset.index ? Number(a.dataset.index) : -1;
  };

  // Le focus entre dans le menu à l'ouverture — une fois la position posée : avant, le panneau est
  // en `visibility:hidden` et un élément caché ne peut pas recevoir le focus.
  const placed = place !== null;
  useEffect(() => {
    if (!placed) return;
    if (focusFirst) {
      const first = nextMenuIndex(items, -1, 1);
      if (first >= 0) {
        focusIndex(first);
        return;
      }
    }
    panelRef.current?.focus({ preventScroll: true });
    // Une seule fois par panneau (`placed` ne repasse jamais à faux) : pas de vol de focus ensuite.
  }, [placed]);

  const openSub = (index: number, viaKeyboard: boolean): void => {
    cancelSubChange();
    const btn = buttons().find((b) => Number(b.dataset.index) === index);
    if (!btn) return;
    setSub({ index, rect: btn.getBoundingClientRect(), focusFirst: viaKeyboard });
  };

  const activate = (index: number, viaKeyboard: boolean): void => {
    const item = items[index];
    if (!item || item === "separator" || item.disabled) return;
    if (item.submenu && item.submenu.length > 0) {
      openSub(index, viaKeyboard);
      return;
    }
    // Ferme (et rend le focus) AVANT l'action : une feuille ouverte par l'action garde le bon focus.
    closeMenu();
    item.onSelect?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const cur = focusedIndex();
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const i = nextMenuIndex(items, cur, e.key === "ArrowDown" ? 1 : -1);
        if (i >= 0) focusIndex(i);
        break;
      }
      case "Home":
        focusIndex(nextMenuIndex(items, -1, 1));
        break;
      case "End":
        focusIndex(nextMenuIndex(items, -1, -1));
        break;
      case "ArrowRight": {
        const item = cur >= 0 ? items[cur] : undefined;
        if (item && item !== "separator" && item.submenu?.length) openSub(cur, true);
        break;
      }
      case "ArrowLeft":
        if (onBack) onBack();
        else return;
        break;
      case "Escape":
        if (onBack) onBack();
        else closeMenu();
        break;
      case "Tab":
        closeMenu();
        break;
      default:
        return; // Entrée / Espace : activation native du bouton focalisé.
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const t = menuMotion(m, place);
  const subItem = sub ? items[sub.index] : undefined;
  const subItems = subItem && subItem !== "separator" ? subItem.submenu : undefined;

  return (
    <>
      <motion.div
        ref={panelRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className={"cm-panel" + (isPresent ? "" : " is-leaving")}
        style={{
          left: place?.left ?? 0,
          top: place?.top ?? 0,
          visibility: place ? "visible" : "hidden",
          transformOrigin: place ? `${place.originX}px ${place.originY}px` : "0 0",
        }}
        initial={t.initial}
        animate={t.animate}
        exit={t.exit}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={onPointerEnterPanel}
        onPointerLeave={() => {
          // Le pointeur quitte le menu : plus d'élément surligné (sauf sous-menu ouvert).
          if (!sub && isPresent) panelRef.current?.focus({ preventScroll: true });
        }}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={`sep-${i}`} role="separator" className="cm-sep" />
          ) : (
            <button
              key={`${i}-${item.label}`}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-index={i}
              disabled={item.disabled}
              aria-haspopup={item.submenu?.length ? "menu" : undefined}
              aria-expanded={item.submenu?.length ? sub?.index === i : undefined}
              className={
                "cm-item" +
                (item.danger ? " is-danger" : "") +
                (sub?.index === i ? " is-open" : "")
              }
              onPointerMove={(e) => {
                if (!isPresent || item.disabled) return;
                if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
                if (item.submenu?.length) {
                  if (sub?.index === i) cancelSubChange();
                  else if (sub) scheduleSubChange(i);
                  else openSub(i, false);
                } else if (sub) scheduleSubChange(null);
              }}
              onClick={(e) => activate(i, e.detail === 0)}
            >
              <span className="cm-icon" aria-hidden="true">
                {item.icon ? <item.icon size={16} strokeWidth={ICON_STROKE} /> : null}
              </span>
              <span className="cm-label">{item.label}</span>
              {item.submenu?.length ? (
                <ChevronRight className="cm-chevron" size={14} strokeWidth={ICON_STROKE} aria-hidden />
              ) : null}
            </button>
          ),
        )}
      </motion.div>

      <AnimatePresence>
        {sub && subItems && subItems.length > 0 && (
          <MenuList
            key={`sub-${sub.index}`}
            items={subItems}
            focusFirst={sub.focusFirst}
            label={(subItem as Exclude<MenuItem, "separator">).label}
            position={(w, h) => placeSubmenu(sub.rect, w, h)}
            onPointerEnterPanel={cancelSubChange}
            onBack={() => {
              cancelSubChange();
              const index = sub.index;
              setSub(null);
              focusIndex(index);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/** Sous-menu : à droite de l'élément parent (bascule à gauche s'il déborde), aligné sur sa ligne. */
function placeSubmenu(rect: DOMRect, w: number, h: number): MenuPlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PAD = 6; // rembourrage du panneau : la 1re ligne s'aligne sur l'élément parent
  let left = rect.right - 2;
  let originX = 0;
  if (left + w > vw - EDGE) {
    left = rect.left - w + 2;
    originX = w;
  }
  left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
  const top = Math.max(EDGE, Math.min(rect.top - PAD, vh - EDGE - h));
  return { left, top, originX, originY: rect.top + rect.height / 2 - top };
}

/** Entrée « depuis le curseur » (fondu + léger zoom), sortie brève ; rien en mouvement réduit. */
function menuMotion(m: ResolvedMotion, place: MenuPlacement | null) {
  if (!m.enabled) {
    return {
      initial: { opacity: 1, scale: 1 },
      animate: { opacity: 1, scale: 1, transition: { duration: 0 } },
      exit: { opacity: 0, transition: { duration: 0 } },
    };
  }
  return {
    initial: { opacity: 0, scale: 0.94 },
    // Tant que la position n'est pas mesurée, on attend (pas d'animation depuis le coin 0,0).
    animate: place
      ? { opacity: 1, scale: 1, transition: { duration: m.d(MENU_IN_SEC), ease: ease.out } }
      : { opacity: 0, scale: 0.94 },
    exit: { opacity: 0, scale: 0.98, transition: { duration: m.d(MENU_OUT_SEC), ease: ease.inOut } },
  };
}
