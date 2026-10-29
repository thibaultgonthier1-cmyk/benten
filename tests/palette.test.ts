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
  COVER_CONCURRENCY,
  COVER_ERROR_TTL_MS,
  createCoverColorCache,
  fallbackCoverColors,
  initCoverState,
  selectCoverColors,
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

/** Luminosité HSL (0..1). */
const hslL = (c: RGB) => (Math.max(...c) + Math.min(...c)) / 510;

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

  it("régression : 60 % marine / 25 % bleu / 15 % presque blanc -> vive = le bleu (chroma)", () => {
    // Avec saturation HSL × population, le marine (S gonflée près du noir) gagnait.
    const px = image(32, 32, (x, y) => {
      const p = y * 32 + x;
      return p < 614 ? [20, 30, 80] : p < 870 ? [30, 90, 230] : [240, 238, 230];
    });
    const { dominant, vibrant } = extractPalette(px, 32, 32);
    expect(near(vibrant, [30, 90, 230], 16)).toBe(true);
    expect(near(dominant, [20, 30, 80], 16)).toBe(true);
  });

  it("une crème pâle saturée (majoritaire) ne bat pas un bleu moyen", () => {
    // HSL S de la crème ≈ 0.77 (gonflée près du blanc) contre ≈ 0.67 pour le bleu.
    const px = image(32, 32, (x) => (x < 22 ? [245, 230, 180] : [40, 90, 200]));
    const { dominant, vibrant } = extractPalette(px, 32, 32);
    expect(near(dominant, [245, 230, 180], 16)).toBe(true);
    expect(near(vibrant, [40, 90, 200], 16)).toBe(true);
  });

  it("vive : les boîtes très sombres / très claires (L HSL < 0.15 ou > 0.85) ne concourent pas", () => {
    // Rouge très sombre mais très chromatique (L ≈ 0.14) contre vert moyen peu nombreux.
    const px = image(32, 32, (x) => (x < 28 ? [70, 0, 0] : [60, 160, 70]));
    expect(near(extractPalette(px, 32, 32).vibrant, [60, 160, 70], 16)).toBe(true);
  });

  it("dominante = boîte la plus peuplée, vive = chroma × population", () => {
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

  it("vive ET dominante grises -> repli magenta Benten", () => {
    expect(pickAccent({ dominant: [120, 118, 122], vibrant: [200, 196, 190] })).toEqual(FALLBACK_RGB);
    expect(pickAccent({ dominant: [40, 40, 40], vibrant: [60, 70, 65] })).toEqual(FALLBACK_RGB);
  });

  it("gate en chroma : une vive sombre très « saturée » HSL mais peu chromatique est grise", () => {
    // (30,10,20) : S HSL = 0.5 mais chroma 20 (< 0.12 × 255) -> on prend la dominante.
    const acc = pickAccent({ dominant: [40, 160, 70], vibrant: [30, 10, 20] });
    expect(acc[1]).toBeGreaterThan(acc[0] + 40);
  });

  it("luminosité bornée : une teinte pâle garde sa teinte (L HSL ≤ 0.75) et reste ≥ 4.5:1", () => {
    for (const c of [[249, 243, 226], [184, 214, 231], [250, 200, 220], [200, 255, 200]] as RGB[]) {
      const acc = pickAccent({ dominant: [0, 0, 0], vibrant: c });
      expect(hslL(acc)).toBeLessThanOrEqual(0.755);
      expect(wcagContrastOnBlack(acc)).toBeGreaterThanOrEqual(4.5);
      // la teinte dominante est conservée (canal max inchangé)
      expect(acc.indexOf(Math.max(...acc))).toBe(c.indexOf(Math.max(...c)));
    }
  });

  it("borne + plancher : un bleu pur sombre est relevé à ≥ 4.5:1 sans dépasser L 0.75", () => {
    for (const c of [[0, 0, 140], [20, 30, 80], [90, 0, 120]] as RGB[]) {
      const acc = pickAccent({ dominant: c, vibrant: c });
      expect(wcagContrastOnBlack(acc)).toBeGreaterThanOrEqual(4.5);
      expect(hslL(acc)).toBeLessThanOrEqual(0.755);
    }
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
    // `peek` ne réordonne PAS (lecture de rendu) ; `load` sur un hit « touche » k0 :
    // il devient le plus récent, k1 devient le plus ancien.
    expect(cache.peek("k0")).toBeDefined();
    await cache.load("k0", "f");
    expect(sampler).toHaveBeenCalledTimes(512);
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

  it("peek est une lecture pure : elle ne protège pas une entrée de l'éviction", async () => {
    const sampler = vi.fn<CoverSampler>(async () => solid([30, 200, 60]));
    const cache = createCoverColorCache({ sampler, capacity: 3 });
    for (const k of ["a", "b", "c"]) await cache.load(k, "f");
    for (let i = 0; i < 5; i++) expect(cache.peek("a")).toBeDefined();
    await cache.load("d", "f");
    expect(cache.peek("a")).toBeUndefined(); // toujours la plus ancienne malgré les peek
    expect(cache.peek("b")).toBeDefined();
  });

  it("repli après erreur : TTL ~30 s puis nouvel essai", async () => {
    let t = 1_000;
    let fail = true;
    const sampler = vi.fn<CoverSampler>(async () => {
      if (fail) throw new Error("404");
      return solid([30, 60, 210]);
    });
    const cache = createCoverColorCache({ sampler, now: () => t });
    expect(COVER_ERROR_TTL_MS).toBe(30_000);
    const fb = await cache.load("x", "Album");
    expect(fb).toEqual(fallbackCoverColors("Album"));
    t += 29_000;
    expect(await cache.load("x", "Album")).toBe(fb); // encore dans le TTL : pas de nouvel essai
    expect(sampler).toHaveBeenCalledTimes(1);
    t += 2_000;
    expect(cache.peek("x")).toBeUndefined(); // expiré
    fail = false;
    const ok = await cache.load("x", "Album");
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(ok).not.toEqual(fb);
    t += 10 * 60_000;
    expect(cache.peek("x")).toBe(ok); // un succès n'expire pas
  });

  it("limite la concurrence (200 tuiles -> au plus 4 décodages simultanés)", async () => {
    expect(COVER_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(COVER_CONCURRENCY).toBeLessThanOrEqual(6);
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const sampler = vi.fn<CoverSampler>(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => gates.push(r));
      active--;
      return solid([220, 30, 40]);
    });
    const cache = createCoverColorCache({ sampler });
    const all = Promise.all(Array.from({ length: 200 }, (_, i) => cache.load(`t${i}`, "f")));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    await flush();
    expect(active).toBe(COVER_CONCURRENCY);
    while (sampler.mock.calls.length < 200 || active > 0) {
      gates.splice(0).forEach((g) => g());
      await flush();
    }
    await all;
    expect(peak).toBe(COVER_CONCURRENCY);
    expect(sampler).toHaveBeenCalledTimes(200);
    expect(cache.size()).toBe(200);
  });

  it("concurrence : une erreur libère bien son créneau", async () => {
    const sampler = vi.fn<CoverSampler>(async (url) => {
      if (url.includes("bad")) throw new Error("x");
      return solid([30, 60, 210]);
    });
    const cache = createCoverColorCache({ sampler, concurrency: 1 });
    const res = await Promise.all([cache.load("bad1", "a"), cache.load("bad2", "b"), cache.load("good", "c")]);
    expect(res[2].accent).not.toEqual(fallbackCoverColors("c").accent);
    expect(sampler).toHaveBeenCalledTimes(3);
  });
});

describe("état du hook (initCoverState / selectCoverColors)", () => {
  it("un hit au montage est figé dans l'état : l'éviction LRU ultérieure ne rend pas le repli", async () => {
    const sampler = vi.fn<CoverSampler>(async () => solid([30, 60, 210]));
    const cache = createCoverColorCache({ sampler, capacity: 1 });
    const colors = await cache.load("k", "fb");
    const state = initCoverState("k", cache);
    expect(state).toEqual({ key: "k", colors });
    await cache.load("other", "fb"); // évince k
    expect(cache.peek("k")).toBeUndefined();
    const fb = fallbackCoverColors("fb");
    expect(selectCoverColors("k", state, cache, fb)).toBe(colors);
  });

  it("état d'une autre artKey (périmé) ignoré ; artKey null -> repli", async () => {
    const cache = createCoverColorCache({ sampler: async () => solid([30, 60, 210]) });
    const a = await cache.load("a", "fb");
    const fb = fallbackCoverColors("fb");
    expect(selectCoverColors("b", { key: "a", colors: a }, cache, fb)).toBe(fb);
    expect(selectCoverColors(null, { key: "a", colors: a }, cache, fb)).toBe(fb);
    expect(initCoverState(null, cache)).toBeNull();
    expect(initCoverState("missing", cache)).toBeNull();
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
