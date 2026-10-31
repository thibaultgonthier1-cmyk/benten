import { describe, expect, it } from "vitest";
import { findContentBox } from "../src/main/library/artcrop";

/**
 * Détection des bandes sur une pochette. Le calcul est pur, donc on fabrique des images de test :
 * une bande blanche en haut et en bas doit être rognée ; une image pleine ne doit pas bouger.
 */
function makeImage(width: number, height: number, bands: { top: number; bottom: number }, fill = [40, 60, 120]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const blank = y < bands.top || y >= height - bands.bottom;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (blank) {
        pixels[i] = 255;
        pixels[i + 1] = 255;
        pixels[i + 2] = 255;
      } else {
        // contenu : dégradé horizontal pour avoir du détail (donc non uniforme)
        pixels[i] = fill[2];
        pixels[i + 1] = fill[1];
        pixels[i + 2] = Math.min(255, fill[0] + (x % 40) * 3);
      }
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

describe("findContentBox", () => {
  it("rogne des bandes blanches en haut et en bas", () => {
    const width = 100;
    const height = 100;
    const box = findContentBox(makeImage(width, height, { top: 20, bottom: 15 }), width, height, width * 4);
    expect(box).not.toBeNull();
    expect(box!.y).toBe(20);
    expect(box!.height).toBe(65);
    expect(box!.x).toBe(0);
  });

  it("ne touche pas une image pleine", () => {
    const width = 100;
    const height = 100;
    expect(findContentBox(makeImage(width, height, { top: 0, bottom: 0 }), width, height, width * 4)).toBeNull();
  });

  it("ignore une fine bande (moins de 4 %)", () => {
    const width = 100;
    const height = 200;
    expect(findContentBox(makeImage(width, height, { top: 4, bottom: 0 }), width, height, width * 4)).toBeNull();
  });

  it("refuse de rogner plus de la moitié de l'image", () => {
    const width = 100;
    const height = 100;
    // 60 % de bande en haut : au-delà du plafond, on considère la mesure suspecte.
    expect(findContentBox(makeImage(width, height, { top: 60, bottom: 0 }), width, height, width * 4)).toBeNull();
  });

  it("ne traite pas des images minuscules", () => {
    expect(findContentBox(new Uint8Array(4 * 4 * 4), 4, 4, 16)).toBeNull();
  });
});
