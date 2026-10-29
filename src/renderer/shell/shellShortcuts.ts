import { Heart, HeartOff } from "lucide-react";
import { uiStore, type UiStore } from "../state/ui";
import { playerStore, type PlayerStore } from "../state/player";
import type { PlayerControls } from "../components/controls";
import type { ShortcutHandlers } from "../lib/shortcuts";
import { closeMenu, menuStore } from "../ui/menuStore";
import { quoted, toast } from "../ui/toastStore";

/** Pas (s) des raccourcis avancer / reculer (Maj+→ / Maj+←). */
export const SHORTCUT_SEEK_SEC = 10;

export interface ShellShortcutDeps {
  /** Commandes de transport ; absentes : seuls les raccourcis d'interface agissent. */
  controls?: PlayerControls;
  /** Focalise (et sélectionne) le champ de recherche de la barre du haut. */
  focusSearch(): void;
  player?: PlayerStore;
  ui?: UiStore;
  /**
   * Vrai si un dialogue modal (piège de focus) est ouvert. Défaut : `isAnyModalOpen` (aide, écran de
   * lecture, file, ou tout `[aria-modal="true"]` visible — feuilles playlist / qualité).
   */
  isModalOpen?: () => boolean;
}

/**
 * Un dialogue modal est-il ouvert ? États connus du store (aide, écran de lecture, file) + tout
 * `[aria-modal="true"]` du DOM qui n'est pas dans un sous-arbre `aria-hidden="true"` (les feuilles
 * fermées restent montées sous un enveloppe `aria-hidden`).
 */
export function isAnyModalOpen(ui: UiStore = uiStore, player: PlayerStore = playerStore): boolean {
  if (ui.getState().shortcutsHelpOpen) return true;
  const p = player.getState();
  if (p.nowPlayingOpen || p.queueOpen) return true;
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
    (el) => el.closest('[aria-hidden="true"]') === null,
  );
}

/**
 * Ferme le calque le plus haut : menu contextuel, puis aide des raccourcis, puis écran de lecture,
 * puis file d'attente. Renvoie vrai si quelque chose a été fermé.
 */
export function closeTopmostLayer(ui: UiStore = uiStore, player: PlayerStore = playerStore): boolean {
  if (menuStore.getState().open) {
    closeMenu();
    return true;
  }
  if (ui.getState().shortcutsHelpOpen) {
    ui.getState().setShortcutsHelpOpen(false);
    return true;
  }
  const p = player.getState();
  if (p.nowPlayingOpen) {
    p.setNowPlayingOpen(false);
    return true;
  }
  if (p.queueOpen) {
    p.setQueueOpen(false);
    return true;
  }
  return false;
}

/**
 * Gestionnaires des raccourcis globaux du Shell, câblés sur l'API existante : `controls` (transport,
 * avance/recul via `seekFraction`), le store lecteur (favori, calques), le routeur (réglages,
 * historique) et les hôtes de menu / d'aide.
 */
export function createShellShortcuts(deps: ShellShortcutDeps): ShortcutHandlers {
  const { controls, focusSearch } = deps;
  const player = deps.player ?? playerStore;
  const ui = deps.ui ?? uiStore;
  const isModalOpen = deps.isModalOpen ?? ((): boolean => isAnyModalOpen(ui, player));
  /**
   * Actions qui déplacent le focus ou la page : neutralisées sous un dialogue modal, pour que le
   * focus ne sorte jamais du piège. Fermer, l'aide et le transport restent disponibles.
   */
  const outsideModal =
    (fn: () => void) =>
    (): void => {
      if (!isModalOpen()) fn();
    };

  const hasTrack = (): boolean => player.getState().currentTrack !== null;
  const seekBy = (delta: number): void => {
    const { positionSec, durationSec, currentTrack } = player.getState();
    const dur = durationSec || currentTrack?.durationSec || 0;
    if (!controls || !currentTrack || dur <= 0) return;
    controls.seekFraction((positionSec + delta) / dur);
  };

  return {
    toggle: () => {
      if (controls && hasTrack()) controls.toggle();
    },
    next: () => {
      if (controls && hasTrack()) controls.next();
    },
    prev: () => {
      if (controls && hasTrack()) controls.prev();
    },
    seekFwd: () => seekBy(SHORTCUT_SEEK_SEC),
    seekBack: () => seekBy(-SHORTCUT_SEEK_SEC),
    search: outsideModal(() => {
      closeMenu({ restoreFocus: false });
      focusSearch();
    }),
    favorite: () => {
      const p = player.getState();
      const t = p.currentTrack;
      if (!t) return;
      const wasFav = p.favoriteIds.has(t.id);
      p.toggleFavorite(t.id);
      toast(`${quoted(t.title)} ${wasFav ? "retiré des favoris" : "ajouté aux favoris"}`, {
        icon: wasFav ? HeartOff : Heart,
      });
    },
    close: () => {
      closeTopmostLayer(ui, player);
    },
    help: () => {
      closeMenu({ restoreFocus: false });
      const s = ui.getState();
      s.setShortcutsHelpOpen(!s.shortcutsHelpOpen);
    },
    settings: outsideModal(() => ui.getState().navigate({ name: "settings" })),
    back: outsideModal(() => ui.getState().back()),
    forward: outsideModal(() => ui.getState().forward()),
  };
}
