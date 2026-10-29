import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK_RGB,
  extractPalette,
  pickAccent,
  readableOnBlack,
  toCss,
  type RGB,
} from "../src/renderer/lib/palette";
import {
  COVER_COLOR_CACHE_SIZE,
  createCoverColorCache,
  fallbackCoverColors,
  type CoverSample,
  type CoverSampler,
} from "../src/renderer/lib/useCoverColors";
import { artUrl } from "../src/renderer/lib/library";

/** Image RGBA `w×h` remplie par `fill(x, y)`. */
function image(w: number, h: number, fill: (x: number, y: number) => RGB): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Contraste WCAG 2.x recalculé indépendamment de l'implémentation. */
function wcagContrastOnBlack([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return (L + 0.05) / 0.05;
}

const near = (a: RGB, b: RGB, tol: number) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe("extractPalette", () => {
  it("image unie rouge -> dominante rouge (±16)", () => {
    const px = image(32, 32, () => [220, 30, 40]);
    const { dominant, vibrant } = extractPalette(px, 32, 32);
    expect(near(dominant, [220, 30, 40], 16)).toBe(true);
    expect(near(vibrant, [220, 30, 40], 16)).toBe(true);
  });

  it("moitié noire / moitié bleue -> vive bleue (le noir est ignoré)", () => {
    const px = image(32, 32, (x) => (x < 16 ? [0, 0, 0] : [30, 60, 210]));
    const { dominant, vibrant } = extractPalette(px, 32, 32);
    expect(near(vibrant, [30, 60, 210], 16)).toBe(true);
    expect(near(dominant, [30, 60, 210], 16)).toBe(true);
  });

  it("image toute noire -> repli magenta", () => {
    const px = image(32, 32, () => [3, 3, 3]);
    expect(extractPalette(px, 32, 32)).toEqual({ dominant: FALLBACK_RGB, vibrant: FALLBACK_RGB });
    expect(FALLBACK_RGB).toEqual([231, 60, 130]);
  });

  it("image toute blanche (ignorée aussi) -> repli magenta", () => {
    const px = image(8, 8, () => [252, 252, 252]);
    expect(extractPalette(px, 8, 8).dominant).toEqual([231, 60, 130]);
  });

  it("dominante = boîte la plus peuplée, vive = saturation × population", () => {
    // 75 % gris moyen, 25 % orange vif : le gris domine, l'orange est la vive.
    const px = image(32, 32, (x) => (x < 24 ? [120, 120, 120] : [240, 120, 20]));
    const { dominant, vibrant } = extractPalette(px, 32, 32);
    expect(near(dominant, [120, 120, 120], 16)).toBe(true);
    expect(near(vibrant, [240, 120, 20], 16)).toBe(true);
  });

  it("ignore les pixels transparents", () => {
    const px = image(4, 4, () => [30, 200, 60]);
    for (let i = 0; i < 8 * 4; i += 4) {
      px[i] = 250;
      px[i + 1] = 0;
      px[i + 2] = 0;
      px[i + 3] = 0; // moitié rouge mais transparente
    }
    expect(near(extractPalette(px, 4, 4).dominant, [30, 200, 60], 16)).toBe(true);
  });

  it("est déterministe (deux appels identiques -> même résultat)", () => {
    const px = image(32, 32, (x, y) => [(x * 37 + y * 11) % 256, (x * 7) % 256, (y * 13) % 256]);
    expect(extractPalette(px, 32, 32)).toEqual(extractPalette(px, 32, 32));
  });
});

describe("readableOnBlack", () => {
  it("[20,20,60] -> contraste ≥ 4.5 sur #000", () => {
    const out = readableOnBlack([20, 20, 60]);
    expect(wcagContrastOnBlack(out)).toBeGreaterThanOrEqual(4.5);
    // la teinte est conservée : le bleu reste le canal dominant
    expect(out[2]).toBeGreaterThan(out[0]);
  });

  it("laisse inchangée une couleur déjà lisible", () => {
    expect(readableOnBlack([231, 60, 130])).toEqual([231, 60, 130]);
  });

  it("couvre les cas extrêmes (noir pur, rouge sombre)", () => {
    for (const c of [[0, 0, 0], [80, 0, 0], [0, 0, 255], [10, 40, 10]] as RGB[]) {
      expect(wcagContrastOnBlack(readableOnBlack(c))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("toCss", () => {
  it("rgb() opaque, rgba() avec alpha", () => {
    expect(toCss([1, 2, 3])).toBe("rgb(1, 2, 3)");
    expect(toCss([1, 2, 3], 0.5)).toBe("rgba(1, 2, 3, 0.5)");
  });
});

describe("pickAccent", () => {
  it("prend la vive quand elle est saturée", () => {
    const acc = pickAccent({ dominant: [120, 120, 120], vibrant: [30, 60, 210] });
    expect(acc[2]).toBeGreaterThan(acc[0]);
    expect(wcagContrastOnBlack(acc)).toBeGreaterThanOrEqual(4.5);
  });

  it("retombe sur la dominante quand la vive est trop grise", () => {
    const acc = pickAccent({ dominant: [200, 40, 40], vibrant: [128, 125, 130] });
    expect(acc[0]).toBeGreaterThan(acc[1] + 50);
    expect(wcagContrastOnBlack(acc)).toBeGreaterThanOrEqual(4.5);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Cache LRU + déduplication + repli (le hook React n'est qu'une fine couche dessus).          */
/* ------------------------------------------------------------------------------------------ */

const solid = (rgb: RGB): CoverSample => ({ data: image(32, 32, () => rgb), width: 32, height: 32 });

describe("createCoverColorCache", () => {
  it("échantillonne artUrl(artKey, 64) et renvoie des couleurs CSS", async () => {
    const sampler = vi.fn<CoverSampler>(async () => solid([30, 60, 210]));
    const cache = createCoverColorCache({ sampler });
    const c = await cache.load("abc", "Album");
    expect(sampler).toHaveBeenCalledWith(artUrl("abc", 64));
    expect(c.dominant).toMatch(/^rgb\(/);
    expect(c.vibrant).toMatch(/^rgb\(/);
    expect(c.accent).toMatch(/^rgb\(/);
    expect(cache.peek("abc")).toEqual(c);
  });

  it("déduplique les chargements en vol par artKey (30 tuiles -> 1 chargement)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sampler = vi.fn<CoverSampler>(async () => {
      await gate;
      return solid([220, 30, 40]);
    });
    const cache = createCoverColorCache({ sampler });
    const loads = Array.from({ length: 30 }, () => cache.load("same", "x"));
    release();
    const results = await Promise.all(loads);
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    await cache.load("same", "x");
    expect(sampler).toHaveBeenCalledTimes(1); // servi par le cache ensuite
  });

  it("erreur d'image / exception canvas -> repli génératif, mis en cache (pas de boucle)", async () => {
    const sampler = vi.fn<CoverSampler>(async () => {
      throw new Error("SecurityError");
    });
    const cache = createCoverColorCache({ sampler });
    const c = await cache.load("broken", "Mon Album");
    expect(c).toEqual(fallbackCoverColors("Mon Album"));
    await cache.load("broken", "Mon Album");
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(cache.peek("broken")).toEqual(c);
  });

  it("exception synchrone du sampler -> repli aussi", async () => {
    const sampler = vi.fn<CoverSampler>(() => {
      throw new Error("boom");
    });
    const cache = createCoverColorCache({ sampler });
    await expect(cache.load("k", "fb")).resolves.toEqual(fallbackCoverColors("fb"));
  });

  it("LRU : capacité 512 par défaut, évince la moins récemment utilisée", async () => {
    expect(COVER_COLOR_CACHE_SIZE).toBe(512);
    const sampler = vi.fn<CoverSampler>(async () => solid([30, 200, 60]));
    const cache = createCoverColorCache({ sampler });
    for (let i = 0; i < 512; i++) await cache.load(`k${i}`, "f");
    expect(cache.size()).toBe(512);
    // on « touche » k0 : il devient le plus récent, k1 devient le plus ancien
    expect(cache.peek("k0")).toBeDefined();
    await cache.load("k512", "f");
    expect(cache.size()).toBe(512);
    expect(cache.peek("k0")).toBeDefined();
    expect(cache.peek("k1")).toBeUndefined();
    expect(cache.peek("k512")).toBeDefined();
    expect(sampler).toHaveBeenCalledTimes(513);
    // k1 évincé -> rechargé à la demande
    await cache.load("k1", "f");
    expect(sampler).toHaveBeenCalledTimes(514);
    expect(cache.size()).toBe(512);
  });
});

describe("fallbackCoverColors", () => {
  it("dérive de generativeCover(fallbackKey).accent, accent lisible sur noir", () => {
    const fb = fallbackCoverColors("Some Album");
    expect(fb).toEqual(fallbackCoverColors("Some Album"));
    const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(fb.accent);
    expect(m).not.toBeNull();
    const rgb = [Number(m![1]), Number(m![2]), Number(m![3])] as RGB;
    expect(wcagContrastOnBlack(rgb)).toBeGreaterThanOrEqual(4.5);
  });
});
