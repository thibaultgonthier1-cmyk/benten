import { afterEach, describe, expect, it, vi } from "vitest";
import { createLibraryStore } from "../src/renderer/state/library";
import type { SourceRow, TrackRow } from "../src/shared/types";

/**
 * Store bibliothèque (Phase 3, Tâche 2) testé hors React avec un FAUX `window.benten` :
 *  - `reload()` pagine `library.query` par 1000 jusqu'à une page incomplète ; `tracks` (plat) et
 *    `albums` (groupés) sont remplis ;
 *  - `scan(path)` appelle `library.scan([path])`, recharge puis rafraîchit `sources` ;
 *  - `setQuery` est anti-rebondé (150 ms) et une réponse obsolète n'écrase jamais le terme courant.
 */

const track = (id: number, albumId: number, over: Partial<TrackRow> = {}): TrackRow => ({
  id,
  path: `C:\\music\\${albumId}\\${id}.flac`,
  title: `T${id}`,
  artist: "X",
  album: `Album ${albumId}`,
  albumArtist: null,
  albumId,
  trackNo: id,
  discNo: null,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 24,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  ...over,
});

/** Génère `n` pistes réparties sur des albums de 10 pistes. */
const makeTracks = (n: number): TrackRow[] =>
  Array.from({ length: n }, (_, i) => track(i + 1, Math.floor(i / 10) + 1));

function fakeBenten(all: TrackRow[] = []) {
  const sources: SourceRow[] = [];
  return {
    library: {
      query: vi.fn(async (args: { limit: number; offset: number }) => ({
        view: "tracks" as const,
        rows: all.slice(args.offset, args.offset + args.limit),
      })),
      scan: vi.fn(async (paths: readonly string[]) => {
        sources.push({ id: sources.length + 1, path: paths[0]!, addedAt: 0 });
        return { scanned: 3, added: 3, skipped: 0, errors: 0 };
      }),
      search: vi.fn(async (_args: { q: string; limit?: number }) => [] as TrackRow[]),
      tracksByIds: vi.fn(async () => [] as TrackRow[]),
    },
    sources: {
      list: vi.fn(async () => sources.slice()),
      remove: vi.fn(async () => undefined),
    },
    dialog: { pickFolder: vi.fn(async () => null as string | null) },
    onLibraryChanged: vi.fn((_cb: () => void) => () => undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("libraryStore — chargement", () => {
  it("reload() pagine par 1000 jusqu'à une page incomplète et remplit tracks + albums", async () => {
    const all = makeTracks(2345);
    const benten = fakeBenten(all);
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();

    expect(store.getState().loading).toBe(true);
    await store.getState().reload();

    const offsets = benten.library.query.mock.calls.map((c) => c[0]);
    expect(offsets).toEqual([
      { view: "tracks", limit: 1000, offset: 0 },
      { view: "tracks", limit: 1000, offset: 1000 },
      { view: "tracks", limit: 1000, offset: 2000 },
    ]);
    const s = store.getState();
    expect(s.tracks).toHaveLength(2345);
    expect(s.albums).toHaveLength(235); // 234 albums pleins + 1 de 5 pistes
    expect(s.albums[0]!.tracks).toHaveLength(10);
    expect(s.loading).toBe(false);
  });

  it("reload() s'arrête après une page pleine suivie d'une page vide", async () => {
    const benten = fakeBenten(makeTracks(1000));
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();
    await store.getState().reload();
    expect(benten.library.query).toHaveBeenCalledTimes(2);
    expect(store.getState().tracks).toHaveLength(1000);
  });
});

describe("libraryStore — scan & sources", () => {
  it('scan("/x") appelle library.scan(["/x"]) puis recharge et rafraîchit sources', async () => {
    const benten = fakeBenten(makeTracks(3));
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();

    await store.getState().scan("/x");

    expect(benten.library.scan).toHaveBeenCalledWith(["/x"]);
    expect(benten.library.query).toHaveBeenCalled(); // rechargement après scan
    expect(benten.sources.list).toHaveBeenCalled();
    const s = store.getState();
    expect(s.sources.map((r) => r.path)).toEqual(["/x"]);
    expect(s.tracks).toHaveLength(3);
    expect(s.scanning).toBe(false);
    expect(s.scanMsg).toBe("Indexation : 3 ajoutes, 0 ignores.");
  });

  it("scan d'un chemin vide est ignoré", async () => {
    const benten = fakeBenten();
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();
    await store.getState().scan("   ");
    expect(benten.library.scan).not.toHaveBeenCalled();
  });

  it("un échec de scan pose un message d'échec et libère `scanning`", async () => {
    const benten = fakeBenten();
    benten.library.scan.mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();
    await store.getState().scan("/x");
    expect(store.getState().scanMsg).toBe("Echec : boom");
    expect(store.getState().scanning).toBe(false);
  });

  it("pickFolderAndScan() scanne le dossier choisi (et le signale)", async () => {
    const benten = fakeBenten();
    benten.dialog.pickFolder.mockResolvedValueOnce("/picked");
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();
    const onPicked = vi.fn();
    await store.getState().pickFolderAndScan(onPicked);
    expect(onPicked).toHaveBeenCalledWith("/picked");
    expect(benten.library.scan).toHaveBeenCalledWith(["/picked"]);
  });

  it("refreshSources() charge les racines persistées", async () => {
    const benten = fakeBenten();
    benten.sources.list.mockResolvedValueOnce([{ id: 7, path: "/m", addedAt: 1 }]);
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();
    await store.getState().refreshSources();
    expect(store.getState().sources).toEqual([{ id: 7, path: "/m", addedAt: 1 }]);
  });

  it("subscribeLibraryChanged() recharge à chaque signal et se désabonne", async () => {
    const benten = fakeBenten(makeTracks(2));
    const off = vi.fn();
    let fire: (() => void) | undefined;
    benten.onLibraryChanged.mockImplementation((cb: () => void) => {
      fire = cb;
      return off;
    });
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();
    const unsubscribe = store.getState().subscribeLibraryChanged();
    fire!();
    await vi.waitFor(() => expect(store.getState().tracks).toHaveLength(2));
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("subscribeLibraryChanged() est un no-op hors fenêtre", () => {
    const store = createLibraryStore();
    expect(() => store.getState().subscribeLibraryChanged()()).not.toThrow();
  });
});

describe("libraryStore — recherche anti-rebondée", () => {
  it('setQuery("a") puis setQuery("ab") en < 150 ms → une seule recherche', async () => {
    vi.useFakeTimers();
    const benten = fakeBenten();
    const hit = [track(1, 1)];
    benten.library.search.mockResolvedValue(hit);
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();

    store.getState().setQuery("a");
    await vi.advanceTimersByTimeAsync(100);
    store.getState().setQuery("ab");
    expect(store.getState().searched).toBe(false);
    await vi.advanceTimersByTimeAsync(150);

    expect(benten.library.search).toHaveBeenCalledTimes(1);
    expect(benten.library.search).toHaveBeenCalledWith({ q: "ab", limit: 200 });
    expect(store.getState().query).toBe("ab");
    expect(store.getState().results).toEqual(hit);
    expect(store.getState().searched).toBe(true);
  });

  it('une réponse tardive pour "a" n\'écrase pas "ab"', async () => {
    vi.useFakeTimers();
    const benten = fakeBenten();
    const resolvers: Record<string, (rows: TrackRow[]) => void> = {};
    benten.library.search.mockImplementation(
      (args: { q: string }) =>
        new Promise<TrackRow[]>((resolve) => {
          resolvers[args.q] = resolve;
        }),
    );
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();

    store.getState().setQuery("a");
    await vi.advanceTimersByTimeAsync(150); // la recherche "a" part (réponse en vol)
    store.getState().setQuery("ab");
    await vi.advanceTimersByTimeAsync(150); // la recherche "ab" part
    expect(benten.library.search).toHaveBeenCalledTimes(2);

    resolvers["ab"]!([track(2, 1, { title: "AB" })]);
    await vi.advanceTimersByTimeAsync(0);
    resolvers["a"]!([track(1, 1, { title: "A" })]); // réponse obsolète, arrive en retard
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().results.map((t) => t.title)).toEqual(["AB"]);
    expect(store.getState().searched).toBe(true);
  });

  it("terme vide → résultats vidés sans interroger", async () => {
    vi.useFakeTimers();
    const benten = fakeBenten();
    benten.library.search.mockResolvedValue([track(1, 1)]);
    vi.stubGlobal("window", { benten });
    const store = createLibraryStore();

    store.getState().setQuery("a");
    await vi.advanceTimersByTimeAsync(150);
    expect(store.getState().results).toHaveLength(1);
    store.getState().setQuery("  ");
    await vi.advanceTimersByTimeAsync(300);
    expect(benten.library.search).toHaveBeenCalledTimes(1);
    expect(store.getState().results).toEqual([]);
    expect(store.getState().searched).toBe(false);
  });
});
