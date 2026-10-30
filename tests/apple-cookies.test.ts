import { describe, expect, it } from "vitest";
import { countCookieEntries, looksLikeNetscapeCookies } from "../src/main/apple/cookies";

/**
 * Les cookies sont un secret de session : on valide le FORMAT avant d'écrire quoi que ce soit, et
 * on ne journalise jamais les valeurs. Un fichier refusé doit produire un message utile.
 */

const VALID = [
  "# Netscape HTTP Cookie File",
  ".music.apple.com\tTRUE\t/\tTRUE\t0\tmedia-user-token\tABC",
  ".music.apple.com\tTRUE\t/\tTRUE\t0\tmyacinfo\tXYZ",
].join("\n");

describe("cookies Apple Music", () => {
  it("accepte un export Netscape contenant apple.com", () => {
    expect(looksLikeNetscapeCookies(VALID)).toBe(true);
    expect(countCookieEntries(VALID)).toBe(2);
  });

  it("refuse un lien collé par erreur", () => {
    expect(looksLikeNetscapeCookies("https://music.apple.com/fr/playlist/x/pl.abc")).toBe(false);
  });

  it("refuse du texte quelconque et le vide", () => {
    expect(looksLikeNetscapeCookies("bonjour")).toBe(false);
    expect(looksLikeNetscapeCookies("")).toBe(false);
  });

  it("refuse un fichier sans apple.com (mauvais site exporté)", () => {
    const other = ".example.com\tTRUE\t/\tTRUE\t0\tfoo\tbar";
    expect(looksLikeNetscapeCookies(other)).toBe(false);
  });

  it("ignore les commentaires et les lignes incomplètes dans le compte", () => {
    const text = "# commentaire\n.music.apple.com\tTRUE\t/\tTRUE\t0\tmedia-user-token\tABC\ntrop court";
    expect(countCookieEntries(text)).toBe(1);
  });
});
