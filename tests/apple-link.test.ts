import { describe, expect, it } from "vitest";
import { parseAppleLink } from "../src/main/apple/link";

/**
 * Ce que l'utilisateur colle vraiment. « Copier le lien » sur une chanson donne une URL d'ALBUM
 * avec `?i=<trackId>` : si on ne le reconnaît pas, le lien est refusé ou télécharge l'album entier.
 */
describe("parseAppleLink", () => {
  it("reconnaît une playlist", () => {
    const link = parseAppleLink("https://music.apple.com/fr/playlist/playlisttg2017/pl.u-DdAN8P6ta3R5yeV");
    expect(link).toMatchObject({ kind: "playlist", trackId: null });
    expect(link?.resolveUrl).not.toContain("?");
  });

  it("reconnaît un album", () => {
    expect(parseAppleLink("https://music.apple.com/fr/album/raina-ep/1234567890")).toMatchObject({
      kind: "album",
      trackId: null,
    });
  });

  it("reconnaît un TITRE via ?i= et isole l'identifiant de piste", () => {
    const link = parseAppleLink("https://music.apple.com/fr/album/raina-ep/1234567890?i=987654321");
    expect(link?.kind).toBe("song");
    expect(link?.trackId).toBe("987654321");
    expect(link?.trackIdIsPath).toBe(false);
    // L'URL de résolution ne doit plus porter le `?i` : on résout l'album.
    expect(link?.resolveUrl).toBe("https://music.apple.com/fr/album/raina-ep/1234567890");
  });

  it("reconnaît /song/<id>", () => {
    const link = parseAppleLink("https://music.apple.com/fr/song/raina/987654321");
    expect(link).toMatchObject({ kind: "song", trackId: "987654321", trackIdIsPath: true });
  });

  it("ignore les paramètres de suivi et accepte http(s)", () => {
    const link = parseAppleLink("https://music.apple.com/us/album/x/1234567890?i=111111111&uo=4&at=1000l");
    expect(link?.trackId).toBe("111111111");
  });

  it("refuse tout le reste", () => {
    expect(parseAppleLink("https://open.spotify.com/track/abc")).toBeNull();
    expect(parseAppleLink("https://music.apple.com/fr")).toBeNull();
    expect(parseAppleLink("file:///C:/x")).toBeNull();
    expect(parseAppleLink("javascript:alert(1)")).toBeNull();
    expect(parseAppleLink("")).toBeNull();
    expect(parseAppleLink("https://music.apple.com/fr/album/x/")).toBeNull();
    expect(parseAppleLink("https://music.apple.com/fr/playlist/x/pl.")).toBeNull();
  });
});
