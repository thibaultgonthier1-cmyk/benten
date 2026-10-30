import { describe, expect, it } from "vitest";
import { diceSimilarity, matchTracks, normalizeKey } from "../src/main/importer/matcher";
import type { ImportedTrack } from "../src/main/importer/applePlaylist";
import type { TrackRow } from "../src/shared/types";

/** T16 — rapprochement : l'exact d'abord, la similarité ensuite, l'ordre conservé. */

function track(id: number, title: string, artist: string, durationSec = 200): TrackRow {
  return { id, title, artist, album: "Album", durationSec } as unknown as TrackRow;
}

describe("normalizeKey", () => {
  it("retire accents, ponctuation, mentions entre parenthèses et « feat. »", () => {
    expect(normalizeKey("Montagem Aghanim (Slowed) [feat. X]")).toBe("montagem aghanim");
    expect(normalizeKey("C’est la vie")).toBe("c est la vie");
    expect(normalizeKey("NO BATIDÃO")).toBe("no batidao");
    expect(normalizeKey("Titre — Remastered")).toBe("titre remastered");
  });
});

describe("diceSimilarity", () => {
  it("vaut 1 pour deux chaînes identiques et 0 pour deux chaînes sans bigramme commun", () => {
    expect(diceSimilarity("montagem aghanim", "montagem aghanim")).toBe(1);
    expect(diceSimilarity("abc", "xyz")).toBe(0);
  });
});

describe("matchTracks", () => {
  const library: readonly TrackRow[] = [
    track(1, "Montagem Aghanim", "DJ Ritmo", 272),
    track(2, "C'est la vie", "Khaled", 215),
    track(3, "NO BATIDÃO", "ZXKAI & slxwghter", 180),
    track(4, "Nautilus", "Vald", 240),
  ];

  const imported: readonly ImportedTrack[] = [
    { title: "Montagem Aghanim (Slowed)", artist: "DJ Ritmo", durationSec: 272 },
    { title: "C’est la vie", artist: "Khaled", durationSec: 215 },
    { title: "Titre qui n'existe pas", artist: "Inconnu", durationSec: 100 },
    { title: "NO BATIDAO", artist: "ZXKAI & slxwghter", durationSec: 180 },
  ];

  it("retrouve l'apostrophe typographique et les mentions entre parenthèses", () => {
    const results = matchTracks(imported, library);
    expect(results[0]?.track?.id).toBe(1);
    expect(results[1]?.track?.id).toBe(2);
  });

  it("laisse sans correspondance un titre absent", () => {
    const results = matchTracks(imported, library);
    expect(results[2]?.track).toBeNull();
    expect(results[2]?.score).toBe(0);
  });

  it("rapproche malgré l'accent manquant, et conserve l'ordre d'entrée", () => {
    const results = matchTracks(imported, library);
    expect(results[3]?.track?.id).toBe(3);
    expect(results.map((r) => r.imported.title)).toEqual(imported.map((i) => i.title));
  });

  it("préfère l'exact au similaire quand les deux existent", () => {
    const lib = [track(10, "Nautilus (feat. Kaaris)", "Vald", 240), track(11, "Nautilus", "Autre", 200)];
    const [result] = matchTracks([{ title: "Nautilus (feat. Kaaris)", artist: "Vald", durationSec: 240 }], lib);
    expect(result?.track?.id).toBe(10);
    expect(result?.score).toBe(1);
  });
});
