import { describe, expect, it } from "vitest";
import { cookieArgs, normalizeCookieSource } from "../src/main/youtube/cookieSource";

/**
 * Choix de la source de cookies. Le mode « navigateur » existe parce qu'un fichier exporté se
 * périme en quelques minutes (YouTube fait tourner les jetons) — c'est un vrai cas rencontré.
 */
describe("cookieSource", () => {
  it("normalise une entrée inconnue vers « aucun cookie »", () => {
    expect(normalizeCookieSource(null)).toEqual({ mode: "none", browser: "chrome" });
    expect(normalizeCookieSource({ mode: "n'importe quoi" })).toEqual({ mode: "none", browser: "chrome" });
    expect(normalizeCookieSource({ mode: "browser", browser: "opera" })).toEqual({ mode: "browser", browser: "chrome" });
  });

  it("accepte les modes et navigateurs connus", () => {
    expect(normalizeCookieSource({ mode: "browser", browser: "edge" })).toEqual({ mode: "browser", browser: "edge" });
    expect(normalizeCookieSource({ mode: "file" })).toEqual({ mode: "file", browser: "chrome" });
  });

  it("ne produit aucun argument quand rien n'est configuré", () => {
    expect(cookieArgs({ mode: "none", browser: "chrome" }, "C:/x.txt")).toEqual([]);
  });

  it("mode navigateur → --cookies-from-browser", () => {
    expect(cookieArgs({ mode: "browser", browser: "firefox" }, null)).toEqual(["--cookies-from-browser", "firefox"]);
  });

  it("mode fichier → --cookies, mais seulement si le fichier existe", () => {
    expect(cookieArgs({ mode: "file", browser: "chrome" }, "C:/chemin/inexistant.txt")).toEqual([]);
  });
});
