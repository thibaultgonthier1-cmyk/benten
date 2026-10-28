import { describe, expect, it } from "vitest";
import { basename, dirname, join } from "node:path";
import { readMetadata } from "../src/main/library/metadata";

const FIX = join(__dirname, "fixtures");
const TAGGED = join(FIX, "library", "Ridsa", "Tranquille", "13 - Pardon.flac");

describe("readMetadata", () => {
  it("lit l'en-tete reel d'un FLAC (format, frequence, profondeur, duree)", async () => {
    const t = await readMetadata(TAGGED);
    expect(t.path).toBe(TAGGED);
    expect(t.format).toBe("FLAC");
    expect(t.sampleRate).toBe(44100);
    expect(t.bitDepth).toBe(24);
    expect(t.durationSec).toBeGreaterThan(0);
    expect(t.playable).toBe(true);
    expect(t.title.length).toBeGreaterThan(0);
    expect(t.artKey).toBeNull();
  });

  it("derive titre/artiste/album/trackNo des tags (valeurs exactes)", async () => {
    const t = await readMetadata(TAGGED);
    expect(t.title).toBe("Pardon");
    expect(t.artist).toBe("Ridsa");
    expect(t.album).toBe("Tranquille");
    expect(t.trackNo).toBe(13);
  });

  // Discriminant : le tag (« *NSYNC ») differe du dossier (« NSYNC »). Si la lecture
  // des tags etait cassee et que le repli sur le chemin gagnait, ce test echouerait.
  it("le tag gagne sur le dossier quand les deux different", async () => {
    const p = join(FIX, "library", "NSYNC", "No Strings Attached", "01 - Bye Bye Bye.flac");
    expect(basename(dirname(dirname(p)))).toBe("NSYNC");
    const t = await readMetadata(p);
    expect(t.artist).toBe("*NSYNC");
    expect(t.title).toBe("Bye Bye Bye");
    expect(t.album).toBe("No Strings Attached");
    expect(t.trackNo).toBe(1);
  });

  it("replie sur l'arborescence Artiste/Album/NN - Titre quand les tags manquent", async () => {
    const t = await readMetadata(join(FIX, "untagged", "Artiste X", "Album Y", "03 - Titre.flac"));
    expect(t.artist).toBe("Artiste X");
    expect(t.album).toBe("Album Y");
    expect(t.trackNo).toBe(3);
    expect(t.title).toBe("Titre");
    // l'en-tete reste lu pour de vrai
    expect(t.format).toBe("FLAC");
    expect(t.playable).toBe(true);
  });

  it("marque un .m4p (DRM) comme non lisible", async () => {
    const t = await readMetadata(join(FIX, "drm", "Protected.m4p"));
    expect(t.playable).toBe(false);
  });

  it("ne leve jamais d'exception sur un fichier tronque et le marque non lisible", async () => {
    const p = join(FIX, "corrupt", "Artiste Z", "Album Cassé", "01 - Tronqué.flac");
    const t = await readMetadata(p);
    expect(t.playable).toBe(false);
    expect(t.path).toBe(p);
    // le repli d'arborescence reste disponible pour afficher l'entree
    expect(t.artist).toBe("Artiste Z");
    expect(t.album).toBe("Album Cassé");
    expect(t.trackNo).toBe(1);
    expect(t.title).toBe("Tronqué");
  });

  it("ne leve pas non plus sur un fichier inexistant", async () => {
    const t = await readMetadata(join(FIX, "nope", "Nobody", "Nothing", "01 - Rien.flac"));
    expect(t.playable).toBe(false);
  });
});
