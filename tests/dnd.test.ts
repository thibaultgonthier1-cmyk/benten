import { describe, expect, it } from "vitest";
import {
  BENTEN_TRACKS_MIME,
  DND_MAX_RAW_CHARS,
  DND_MAX_TRACKS,
  hasDragTracks,
  readDragTracks,
  setDragTracks,
} from "../src/renderer/lib/dnd";

/** DataTransfer minimal (node : pas de DOM). */
class FakeDataTransfer {
  private data = new Map<string, string>();
  effectAllowed = "uninitialized";
  get types(): string[] {
    return [...this.data.keys()];
  }
  setData(format: string, value: string): void {
    this.data.set(format, value);
  }
  getData(format: string): string {
    return this.data.get(format) ?? "";
  }
}

const asDt = (f: FakeDataTransfer): DataTransfer => f as unknown as DataTransfer;

describe("dnd", () => {
  it("MIME dédié", () => {
    expect(BENTEN_TRACKS_MIME).toBe("application/x-benten-tracks");
  });

  it("aller-retour setDragTracks / readDragTracks = [3,7]", () => {
    const dt = new FakeDataTransfer();
    setDragTracks(asDt(dt), [3, 7]);
    expect(readDragTracks(asDt(dt))).toEqual([3, 7]);
    expect(hasDragTracks(asDt(dt))).toBe(true);
    expect(dt.effectAllowed).toBe("copyMove");
  });

  it("MIME étranger seulement → null", () => {
    const dt = new FakeDataTransfer();
    dt.setData("text/plain", "[3,7]");
    expect(readDragTracks(asDt(dt))).toBeNull();
    expect(hasDragTracks(asDt(dt))).toBe(false);
  });

  it("JSON corrompu → null", () => {
    const dt = new FakeDataTransfer();
    dt.setData(BENTEN_TRACKS_MIME, "[3,7");
    expect(readDragTracks(asDt(dt))).toBeNull();
  });

  it("charge invalide (pas un tableau d'ids entiers positifs, ou vide) → null", () => {
    for (const raw of ['{"a":1}', '[1,"2"]', "[1.5]", "[-1]", "[0]", "[]", "null", '"3"']) {
      const dt = new FakeDataTransfer();
      dt.setData(BENTEN_TRACKS_MIME, raw);
      expect(readDragTracks(asDt(dt))).toBeNull();
    }
  });

  it("charge plafonnée : > 10 000 ids ou > 200 000 caractères → null", () => {
    const max = Array.from({ length: DND_MAX_TRACKS }, (_, i) => i + 1);
    const ok = new FakeDataTransfer();
    ok.setData(BENTEN_TRACKS_MIME, JSON.stringify(max));
    expect(readDragTracks(asDt(ok))?.length).toBe(10_000);

    const tooMany = new FakeDataTransfer();
    tooMany.setData(BENTEN_TRACKS_MIME, JSON.stringify([...max, 10_001]));
    expect(readDragTracks(asDt(tooMany))).toBeNull();

    const tooLong = new FakeDataTransfer();
    tooLong.setData(BENTEN_TRACKS_MIME, "[1" + " ".repeat(DND_MAX_RAW_CHARS) + "]");
    expect(readDragTracks(asDt(tooLong))).toBeNull();
    expect(DND_MAX_TRACKS).toBe(10_000);
    expect(DND_MAX_RAW_CHARS).toBe(200_000);
  });

  it("pose aussi un repli texte lisible (déposer hors de Benten ne casse rien)", () => {
    const dt = new FakeDataTransfer();
    setDragTracks(asDt(dt), [3, 7]);
    expect(dt.getData("text/plain")).toBe("benten:tracks:3,7");
  });
});
