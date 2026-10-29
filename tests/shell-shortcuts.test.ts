import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHORTCUT_SEEK_SEC,
  closeTopmostLayer,
  createShellShortcuts,
} from "../src/renderer/shell/shellShortcuts";
import { createPlayerStore } from "../src/renderer/state/player";
import { createUiStore } from "../src/renderer/state/ui";
import { closeMenu, menuStore, openMenu } from "../src/renderer/ui/menuStore";
import { toastStore } from "../src/renderer/ui/toastStore";
import type { PlayerControls } from "../src/renderer/components/controls";
import type { TrackRow } from "../src/shared/types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  closeMenu();
  toastStore.getState().clear();
  vi.useRealTimers();
});

const tr = (id: number): TrackRow =>
  ({ id, title: `Titre ${id}`, artist: "A", album: "B", albumId: 1, durationSec: 200 }) as TrackRow;

function setup(withTrack = true) {
  const player = createPlayerStore();
  const ui = createUiStore();
  const controls = {
    playAlbum: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seekFraction: vi.fn(),
  } satisfies PlayerControls;
  const focusSearch = vi.fn();
  if (withTrack) player.getState().setQueue([tr(1), tr(2)], 0);
  const h = createShellShortcuts({ controls, focusSearch, player, ui });
  return { player, ui, controls, focusSearch, h };
}

describe("raccourcis du Shell", () => {
  it("toggle / next / prev → controls (rien sans piste chargée)", () => {
    const a = setup();
    a.h.toggle!();
    a.h.next!();
    a.h.prev!();
    expect(a.controls.toggle).toHaveBeenCalledTimes(1);
    expect(a.controls.next).toHaveBeenCalledTimes(1);
    expect(a.controls.prev).toHaveBeenCalledTimes(1);

    const b = setup(false);
    b.h.toggle!();
    b.h.next!();
    expect(b.controls.toggle).not.toHaveBeenCalled();
    expect(b.controls.next).not.toHaveBeenCalled();
  });

  it("seekFwd / seekBack : ±10 s via controls.seekFraction (borné par controls)", () => {
    const { player, controls, h } = setup();
    expect(SHORTCUT_SEEK_SEC).toBe(10);
    player.getState().setPosition(50, 200);
    h.seekFwd!();
    expect(controls.seekFraction).toHaveBeenLastCalledWith(60 / 200);
    h.seekBack!();
    expect(controls.seekFraction).toHaveBeenLastCalledWith(40 / 200);
  });

  it("search focalise le champ ; settings navigue ; back/forward suivent l'historique", () => {
    const { ui, focusSearch, h } = setup();
    h.search!();
    expect(focusSearch).toHaveBeenCalledTimes(1);
    h.settings!();
    expect(ui.getState().route).toEqual({ name: "settings" });
    h.back!();
    expect(ui.getState().route).toEqual({ name: "home" });
    h.forward!();
    expect(ui.getState().route).toEqual({ name: "settings" });
  });

  it("favorite bascule la piste en cours et confirme par un toast", () => {
    const { player, h } = setup();
    h.favorite!();
    expect(player.getState().favoriteIds.has(1)).toBe(true);
    expect(toastStore.getState().toasts.at(-1)?.message).toBe("« Titre 1 » ajouté aux favoris");
    h.favorite!();
    expect(player.getState().favoriteIds.has(1)).toBe(false);
    expect(toastStore.getState().toasts.at(-1)?.message).toBe("« Titre 1 » retiré des favoris");
  });

  it("help ouvre puis referme l'aide", () => {
    const { ui, h } = setup();
    h.help!();
    expect(ui.getState().shortcutsHelpOpen).toBe(true);
    h.help!();
    expect(ui.getState().shortcutsHelpOpen).toBe(false);
  });

  it("close ferme le calque le plus haut : menu > aide > écran de lecture > file", () => {
    const { player, ui, h } = setup();
    player.getState().setQueueOpen(true);
    player.getState().setNowPlayingOpen(true);
    ui.getState().setShortcutsHelpOpen(true);
    openMenu(0, 0, [{ label: "x", onSelect: () => undefined }]);

    h.close!();
    expect(menuStore.getState().open).toBe(false);
    expect(ui.getState().shortcutsHelpOpen).toBe(true);
    h.close!();
    expect(ui.getState().shortcutsHelpOpen).toBe(false);
    expect(player.getState().nowPlayingOpen).toBe(true);
    h.close!();
    expect(player.getState().nowPlayingOpen).toBe(false);
    expect(player.getState().queueOpen).toBe(true);
    h.close!();
    expect(player.getState().queueOpen).toBe(false);
    expect(closeTopmostLayer(ui, player)).toBe(false);
  });
});
