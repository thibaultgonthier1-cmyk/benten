import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeText,
  parseApplePlist,
  parseAppleTxt,
  parseImportFile,
  parseM3u,
} from "../src/main/importer/applePlaylist";

/**
 * T16 — analyseurs. Le cas qui compte : l'export réel d'Apple Music est en **UTF-16LE** avec des
 * en-têtes **français**, et les accents doivent survivre intacts.
 */

const FIX = join(__dirname, "fixtures", "import");
const fixture = (name: string): Buffer => readFileSync(join(FIX, name));

describe("decodeText", () => {
  it("reconnaît UTF-16LE avec BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Nom\tArtiste", "utf16le")]);
    expect(decodeText(buf)).toBe("Nom\tArtiste");
  });

  it("reconnaît un UTF-16LE sans BOM (octets nuls alternés)", () => {
    expect(decodeText(Buffer.from("Nom\tArtiste", "utf16le"))).toBe("Nom\tArtiste");
  });

  it("laisse passer l'UTF-8", () => {
    expect(decodeText(Buffer.from("Nom\tArtiste", "utf8"))).toBe("Nom\tArtiste");
  });
});

describe("parseAppleTxt", () => {
  it("lit un export UTF-16LE à en-têtes FRANÇAIS, dans l'ordre, accents intacts", () => {
    const rows = parseAppleTxt(fixture("playlist-fr.txt"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ title: "Montagem Aghanim", artist: "DJ Ritmo", album: "Montagem", durationSec: 272 });
    expect(rows[1]?.title).toBe("C’est la vie");
    expect(rows[3]).toMatchObject({ title: "Nautilus (feat. Kaaris)", artist: "Vald", durationSec: 240 });
    expect(rows[0]?.dateAdded).toBeTypeOf("number");
  });

  it("lit un export UTF-8 à en-têtes ANGLAIS", () => {
    const rows = parseAppleTxt(fixture("playlist-en.txt"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "Montagem Aghanim", artist: "DJ Ritmo", durationSec: 272 });
    expect(rows[1]?.title).toBe("C'est la vie");
  });

  it("renvoie une liste vide sans en-tête de titre", () => {
    expect(parseAppleTxt(Buffer.from("a\tb\n1\t2"))).toEqual([]);
  });
});

describe("parseM3u", () => {
  it("lit EXTINF et sépare artiste / titre, ordre conservé", () => {
    const rows = parseM3u(readFileSync(join(FIX, "playlist.m3u8"), "utf8"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "Montagem Aghanim", artist: "DJ Ritmo", durationSec: 272 });
    expect(rows[1]).toMatchObject({ title: "C'est la vie", artist: "Khaled" });
  });
});

describe("parseApplePlist", () => {
  it("lit Playlist Items dans l'ordre, en secondes", () => {
    const rows = parseApplePlist(readFileSync(join(FIX, "playlist.xml"), "utf8"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "Montagem Aghanim", durationSec: 272 });
    expect(rows[1]?.title).toBe("C’est la vie");
    expect(rows[0]?.dateAdded).toBeTypeOf("number");
  });
});

describe("parseImportFile", () => {
  it("choisit l'analyseur d'après l'extension", () => {
    expect(parseImportFile("x.m3u8", fixture("playlist.m3u8"))).toHaveLength(2);
    expect(parseImportFile("x.xml", fixture("playlist.xml"))).toHaveLength(2);
    expect(parseImportFile("x.txt", fixture("playlist-fr.txt"))).toHaveLength(4);
  });
});
