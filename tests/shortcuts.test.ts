import { describe, expect, it, vi } from "vitest";
import {
  KEYMAP,
  SHORTCUT_GROUPS,
  handleShortcutEvent,
  matchShortcut,
  shortcutKeys,
  type Action,
  type ShortcutTarget,
} from "../src/renderer/lib/shortcuts";

/**
 * Raccourcis clavier (Phase 3, Tâche 4). Review Focus : un Espace tapé dans un champ (recherche)
 * ne doit JAMAIS lancer/couper la lecture ; seule Échap reste active dans un champ. Un Espace sur
 * un bouton focalisé ne doit pas déclencher deux actions (clic du bouton + bascule globale).
 */

const BODY: ShortcutTarget = { tagName: "BODY", isContentEditable: false };

function ev(
  code: string,
  mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {},
  target: ShortcutTarget | null = BODY,
  key?: string,
) {
  return {
    code,
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
    target,
  };
}

/** Élément factice exposant un attribut `role`. */
const withRole = (tagName: string, role: string): ShortcutTarget => ({
  tagName,
  isContentEditable: false,
  getAttribute: (n: string) => (n === "role" ? role : null),
});

describe("KEYMAP", () => {
  it("reprend exactement les combinaisons du brief + précédent/suivant (Alt+flèches)", () => {
    expect(KEYMAP).toEqual({
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
    });
  });
});

describe("matchShortcut", () => {
  it("Espace hors champ → toggle", () => {
    expect(matchShortcut(ev("Space"))).toBe("toggle");
    expect(matchShortcut(ev("Space", {}, null))).toBe("toggle");
  });

  it("Espace dans un INPUT → null (Review Focus : la recherche ne coupe jamais la lecture)", () => {
    expect(matchShortcut(ev("Space", {}, { tagName: "INPUT" }))).toBeNull();
  });

  it("aucun raccourci dans TEXTAREA / SELECT / contentEditable, sauf Échap", () => {
    for (const target of [
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(matchShortcut(ev("Space", {}, target))).toBeNull();
      expect(matchShortcut(ev("KeyF", { ctrlKey: true }, target))).toBeNull();
      expect(matchShortcut(ev("ArrowRight", { ctrlKey: true }, target))).toBeNull();
      expect(matchShortcut(ev("Escape", {}, target))).toBe("close");
    }
  });

  it("Échap dans un INPUT → close", () => {
    expect(matchShortcut(ev("Escape", {}, { tagName: "INPUT" }))).toBe("close");
  });

  it("Ctrl+KeyF → search ; Shift+Slash → help ; Ctrl+KeyL → favorite ; Ctrl+Comma → settings", () => {
    expect(matchShortcut(ev("KeyF", { ctrlKey: true }))).toBe("search");
    expect(matchShortcut(ev("Slash", { shiftKey: true }))).toBe("help");
    expect(matchShortcut(ev("KeyL", { ctrlKey: true }))).toBe("favorite");
    expect(matchShortcut(ev("Comma", { ctrlKey: true }))).toBe("settings");
  });

  it("flèches : Ctrl = piste, Maj = ±10 s, Alt = historique", () => {
    expect(matchShortcut(ev("ArrowRight", { ctrlKey: true }))).toBe("next");
    expect(matchShortcut(ev("ArrowLeft", { ctrlKey: true }))).toBe("prev");
    expect(matchShortcut(ev("ArrowRight", { shiftKey: true }))).toBe("seekFwd");
    expect(matchShortcut(ev("ArrowLeft", { shiftKey: true }))).toBe("seekBack");
    expect(matchShortcut(ev("ArrowLeft", { altKey: true }))).toBe("back");
    expect(matchShortcut(ev("ArrowRight", { altKey: true }))).toBe("forward");
  });

  it("touche inconnue ou modificateurs en trop → null (correspondance exacte)", () => {
    expect(matchShortcut(ev("KeyQ"))).toBeNull();
    expect(matchShortcut(ev("ArrowRight"))).toBeNull();
    expect(matchShortcut(ev("KeyF"))).toBeNull();
    expect(matchShortcut(ev("ArrowRight", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev("Space", { shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev("KeyF", { ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it("« ? » d'une autre disposition (AZERTY : Maj+KeyM) ouvre aussi l'aide", () => {
    expect(matchShortcut(ev("KeyM", { shiftKey: true }, BODY, "?"))).toBe("help");
    // … mais jamais pendant la saisie.
    expect(matchShortcut(ev("KeyM", { shiftKey: true }, { tagName: "INPUT" }, "?"))).toBeNull();
    expect(matchShortcut(ev("KeyM", { shiftKey: true, ctrlKey: true }, BODY, "?"))).toBeNull();
  });

  it("AZERTY : la touche « , » (code KeyM) + Ctrl ouvre les réglages", () => {
    expect(matchShortcut(ev("KeyM", { ctrlKey: true }, BODY, ","))).toBe("settings");
    // Exacte : pas avec un autre modificateur, ni dans un champ.
    expect(matchShortcut(ev("KeyM", { ctrlKey: true, shiftKey: true }, BODY, ","))).toBeNull();
    expect(matchShortcut(ev("KeyM", { ctrlKey: true, altKey: true }, BODY, ","))).toBeNull();
    expect(matchShortcut(ev("KeyM", { ctrlKey: true }, { tagName: "INPUT" }, ","))).toBeNull();
    // Sans le caractère « , » : Ctrl+KeyM ne fait rien.
    expect(matchShortcut(ev("KeyM", { ctrlKey: true }, BODY, "m"))).toBeNull();
  });

  it("Espace dans un menu / dialogue / liste focalisé → null (le conteneur gère ses touches)", () => {
    expect(matchShortcut(ev("Space", {}, withRole("DIV", "menu")))).toBeNull();
    expect(matchShortcut(ev("Space", {}, withRole("DIV", "dialog")))).toBeNull();
    expect(matchShortcut(ev("Space", {}, withRole("UL", "listbox")))).toBeNull();
  });

  it("Espace sur un bouton / élément interactif → null (pas de double déclenchement)", () => {
    expect(matchShortcut(ev("Space", {}, { tagName: "BUTTON" }))).toBeNull();
    expect(matchShortcut(ev("Space", {}, { tagName: "A" }))).toBeNull();
    expect(matchShortcut(ev("Space", {}, withRole("DIV", "menuitem")))).toBeNull();
    expect(matchShortcut(ev("Space", {}, withRole("DIV", "button")))).toBeNull();
    expect(matchShortcut(ev("Space", {}, withRole("DIV", "radio")))).toBeNull();
    // Un curseur (scrubber) n'est pas activé par Espace : la bascule globale reste disponible.
    expect(matchShortcut(ev("Space", {}, withRole("DIV", "slider")))).toBe("toggle");
    // Les combinaisons avec modificateur restent actives sur un bouton focalisé.
    expect(matchShortcut(ev("ArrowRight", { ctrlKey: true }, { tagName: "BUTTON" }))).toBe("next");
    expect(matchShortcut(ev("Escape", {}, { tagName: "BUTTON" }))).toBe("close");
  });
});

describe("handleShortcutEvent", () => {
  function kev(
    code: string,
    mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {},
    extra: Partial<{ repeat: boolean; defaultPrevented: boolean; isComposing: boolean; target: ShortcutTarget }> = {},
  ) {
    return {
      ...ev(code, mods, extra.target ?? BODY),
      repeat: extra.repeat ?? false,
      defaultPrevented: extra.defaultPrevented ?? false,
      isComposing: extra.isComposing ?? false,
      preventDefault: vi.fn(),
    };
  }

  it("appelle le gestionnaire et empêche l'action par défaut (pas de défilement sur Espace)", () => {
    const toggle = vi.fn();
    const e = kev("Space");
    expect(handleShortcutEvent(e, { toggle })).toBe("toggle");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("Espace sur un bouton : ni bascule ni preventDefault (le bouton gère son clic)", () => {
    const toggle = vi.fn();
    const e = kev("Space", {}, { target: { tagName: "BUTTON" } });
    expect(handleShortcutEvent(e, { toggle })).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ignore un événement déjà traité (defaultPrevented) ou en composition IME", () => {
    const close = vi.fn();
    expect(handleShortcutEvent(kev("Escape", {}, { defaultPrevented: true }), { close })).toBeNull();
    expect(handleShortcutEvent(kev("Escape", {}, { isComposing: true }), { close })).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("la répétition automatique n'agit que pour l'avance/recul (pas de bascule en rafale)", () => {
    const toggle = vi.fn();
    const seekFwd = vi.fn();
    handleShortcutEvent(kev("Space", {}, { repeat: true }), { toggle });
    handleShortcutEvent(kev("ArrowRight", { shiftKey: true }, { repeat: true }), { seekFwd });
    expect(toggle).not.toHaveBeenCalled();
    expect(seekFwd).toHaveBeenCalledTimes(1);
  });

  it("sans gestionnaire pour l'action : rien n'est empêché", () => {
    const e = kev("KeyF", { ctrlKey: true });
    expect(handleShortcutEvent(e, {})).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("aide des raccourcis", () => {
  it("libellés FR des touches", () => {
    expect(shortcutKeys("toggle")).toEqual(["Espace"]);
    expect(shortcutKeys("next")).toEqual(["Ctrl", "→"]);
    expect(shortcutKeys("seekBack")).toEqual(["Maj", "←"]);
    expect(shortcutKeys("search")).toEqual(["Ctrl", "F"]);
    expect(shortcutKeys("help")).toEqual(["?"]);
    expect(shortcutKeys("close")).toEqual(["Échap"]);
    // Libellés par CARACTÈRE (pas par position) : ce qu'un utilisateur AZERTY presse vraiment.
    expect(shortcutKeys("settings")).toEqual(["Ctrl", ","]);
    expect(shortcutKeys("back")).toEqual(["Alt", "←"]);
  });

  it("chaque action apparaît exactement une fois, avec une description française", () => {
    const listed = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.action));
    expect([...listed].sort()).toEqual((Object.keys(KEYMAP) as Action[]).sort());
    for (const g of SHORTCUT_GROUPS) {
      expect(g.title.length).toBeGreaterThan(0);
      for (const i of g.items) expect(i.label.length).toBeGreaterThan(0);
    }
  });
});
