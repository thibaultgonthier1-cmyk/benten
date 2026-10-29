import { describe, expect, it, vi } from "vitest";
import { detachedPresenceValue } from "../src/renderer/ui/DetachedPresence";
import { exitIsInstant } from "../src/renderer/shell/routeTransition";

describe("detachedPresenceValue", () => {
  it("reflète isPresent/custom de la page mais ne retient jamais sa sortie", () => {
    const register = vi.fn(() => () => {});
    const onExitComplete = vi.fn();
    const parent = { id: "p", isPresent: false, custom: true, register, onExitComplete };
    const v = detachedPresenceValue(parent)!;
    expect(v.isPresent).toBe(false);
    expect(v.custom).toBe(true);
    expect(v.id).toBe("p");
    // Un descendant démonté sans se désenregistrer (bug framer 11.18) ne bloque rien :
    const unregister = v.register("tile-1");
    expect(typeof unregister).toBe("function");
    v.onExitComplete?.("tile-1");
    expect(register).not.toHaveBeenCalled();
    expect(onExitComplete).not.toHaveBeenCalled();
  });

  it("hors AnimatePresence : null reste null", () => {
    expect(detachedPresenceValue(null)).toBeNull();
  });
});

describe("exitIsInstant", () => {
  it("transition partagée → sortie instantanée (seule la pochette voyage)", () => {
    expect(exitIsInstant({ shared: true, prevScroll: 0, nextScroll: 0 })).toBe(true);
  });
  it("le défilement change → sortie instantanée (sinon la page sortante saute pendant son fondu)", () => {
    expect(exitIsInstant({ shared: false, prevScroll: 640, nextScroll: 0 })).toBe(true);
    expect(exitIsInstant({ shared: false, prevScroll: 0, nextScroll: 1500 })).toBe(true);
  });
  it("défilement inchangé → fondu normal", () => {
    expect(exitIsInstant({ shared: false, prevScroll: 0, nextScroll: 0 })).toBe(false);
    expect(exitIsInstant({ shared: false, prevScroll: 300, nextScroll: 300 })).toBe(false);
  });
});
