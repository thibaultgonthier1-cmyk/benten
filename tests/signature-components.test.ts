import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Composants signature (DA2) rendus côté serveur (node, sans DOM) : accessibilité, points de
 * branchement des ressources (manifeste) et replis dessinés en code, et — en mouvement Réduit —
 * AUCUNE <video> d'effet montée.
 */

const urls = vi.hoisted(() => ({}) as Record<string, string | null>);
vi.mock("../src/renderer/assets/manifest", async (orig) => {
  const real = await orig<typeof import("../src/renderer/assets/manifest")>();
  return { ...real, assetUrl: (id: string) => urls[id] ?? null };
});

const { GoldMedallion } = await import("../src/renderer/ui/GoldMedallion");
const { BiwaString } = await import("../src/renderer/ui/BiwaString");
const { LacquerDisc } = await import("../src/renderer/ui/LacquerDisc");
const { FxLayer } = await import("../src/renderer/ui/FxOverlay");
const { settingsStore } = await import("../src/renderer/state/settings");
const { motionLevel } = await import("../src/renderer/lib/motionLevel");

afterEach(() => {
  for (const k of Object.keys(urls)) delete urls[k];
  settingsStore.getState().setMotionIntensity("full");
});

const noop = (): void => {};

describe("GoldMedallion", () => {
  it("bouton bascule accessible : aria-label + aria-pressed, variante de taille", () => {
    const html = renderToStaticMarkup(
      createElement(GoldMedallion, { playing: true, size: "lg", onToggle: noop, label: "Pause" }),
    );
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("gm--lg");
    expect(html).toContain('data-playing="true"');
  });

  it("libellé par défaut selon l'état, taille md par défaut", () => {
    const html = renderToStaticMarkup(createElement(GoldMedallion, { playing: false, onToggle: noop }));
    expect(html).toContain('aria-label="Lecture"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("gm--md");
  });

  it("texture tex.goldLeaf branchée quand elle existe, sinon dessin en code seul", () => {
    expect(renderToStaticMarkup(createElement(GoldMedallion, { playing: false, onToggle: noop }))).not.toContain(
      "gold-leaf.webp",
    );
    urls["tex.goldLeaf"] = "/assets/tex/gold-leaf.webp";
    expect(renderToStaticMarkup(createElement(GoldMedallion, { playing: false, onToggle: noop }))).toContain(
      "gold-leaf.webp",
    );
  });
});

describe("BiwaString", () => {
  it("slider accessible : valeur en secondes et texte mm:ss", () => {
    const html = renderToStaticMarkup(
      createElement(BiwaString, {
        value: 0.25,
        duration: 240,
        onSeek: noop,
        playing: true,
        trackKey: "t1",
        label: "Position",
      }),
    );
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Position"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="240"');
    expect(html).toContain('aria-valuenow="60"');
    expect(html).toContain('aria-valuetext="1:00 sur 4:00"');
    expect(html).toContain('tabindex="0"');
  });

  it("sans durée (volume) : pourcentage ; variante fine", () => {
    const html = renderToStaticMarkup(
      createElement(BiwaString, { value: 0.5, onSeek: noop, playing: false, trackKey: null, thin: true, label: "Volume" }),
    );
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("biwa--thin");
  });
});

describe("LacquerDisc", () => {
  it("repli : seigaiha dessiné en code (motif SVG), pastille d'or", () => {
    const html = renderToStaticMarkup(createElement(LacquerDisc, { artKey: null, playing: false, size: 240 }));
    expect(html).toContain("<pattern");
    expect(html).toContain("lacquer-disc__label");
    expect(html).not.toContain("<image");
  });

  it("texture tex.seigaihaDisc branchée : remplace le motif dessiné", () => {
    urls["tex.seigaihaDisc"] = "/assets/tex/disc.webp";
    const html = renderToStaticMarkup(createElement(LacquerDisc, { artKey: null, playing: false, size: 240 }));
    expect(html).toContain("disc.webp");
    expect(html).not.toContain("<pattern");
  });

  it("reflet teinté par la couleur de pochette", () => {
    const html = renderToStaticMarkup(
      createElement(LacquerDisc, { artKey: null, playing: true, size: 240, tint: "rgb(10, 120, 200)" }),
    );
    expect(html).toContain("--disc-tint:rgb(10, 120, 200)");
  });
});

describe("FxLayer", () => {
  const ticket = { id: 1, kind: "pluck" as const, at: { x: 40, y: 50 }, dim: false };

  it("url null → repli CSS, aucune <video>", () => {
    const html = renderToStaticMarkup(createElement(FxLayer, { tickets: [ticket], level: motionLevel("full", false), onDone: noop }));
    expect(html).toContain("fx-fallback--pluck");
    expect(html).not.toContain("<video");
  });

  it("url présente → <video> muette, inline, composée en « screen » (fond noir opaque)", () => {
    urls["fx.pluck"] = "/assets/fx/fx-pluck.webm";
    const html = renderToStaticMarkup(createElement(FxLayer, { tickets: [ticket], level: motionLevel("full", false), onDone: noop }));
    expect(html).toContain("<video");
    expect(html).toContain("fx-pluck.webm");
    expect(html).toContain("mix-blend-mode:screen");
    expect(html).toMatch(/muted/);
    expect(html).toMatch(/playsinline/i);
  });

  it("Sobre : effet atténué", () => {
    urls["fx.pluck"] = "/assets/fx/fx-pluck.webm";
    const html = renderToStaticMarkup(
      createElement(FxLayer, { tickets: [{ ...ticket, dim: true }], level: motionLevel("subtle", false), onDone: noop }),
    );
    expect(html).toContain("is-dim");
  });

  it("Réduit → rien n'est rendu, même avec une url", () => {
    urls["fx.pluck"] = "/assets/fx/fx-pluck.webm";
    const html = renderToStaticMarkup(createElement(FxLayer, { tickets: [ticket], level: motionLevel("reduced", false), onDone: noop }));
    expect(html).not.toContain("<video");
    expect(html).not.toContain("fx-fallback");
  });
});
