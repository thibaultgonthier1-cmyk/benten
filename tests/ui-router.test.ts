import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUiStore,
  uiStore,
  sameRoute,
  routeKey,
  navSectionOf,
  HISTORY_LIMIT,
  type Route,
} from "../src/renderer/state/ui";
import { startAudioRuntime, type AudioRuntime } from "../src/renderer/runtime/audioRuntime";
import type { Decoder } from "../src/renderer/audio/decoder";

/**
 * Routeur maison (Phase 3, Tâche 3) : route courante + historique précédent/suivant, sans
 * dépendance de routage externe. Store vanilla testable hors React.
 */

const home: Route = { name: "home" };
const albums: Route = { name: "albums" };
const album3: Route = { name: "album", id: 3 };
const artists: Route = { name: "artists" };

describe("ui router (navigate / back / forward)", () => {
  it("démarre sur home, sans historique : canBack() et canForward() faux", () => {
    const s = createUiStore();
    expect(s.getState().route).toEqual(home);
    expect(s.getState().past).toEqual([]);
    expect(s.getState().future).toEqual([]);
    expect(s.getState().canBack()).toBe(false);
    expect(s.getState().canForward()).toBe(false);
  });

  it("navigate(albums) puis navigate(album 3) → past=[home, albums], route=album 3", () => {
    const s = createUiStore();
    s.getState().navigate(albums);
    s.getState().navigate(album3);
    expect(s.getState().past).toEqual([home, albums]);
    expect(s.getState().route).toEqual(album3);
    expect(s.getState().canBack()).toBe(true);
  });

  it("back() → route=albums, future=[album 3] ; forward() revient à album 3", () => {
    const s = createUiStore();
    s.getState().navigate(albums);
    s.getState().navigate(album3);
    s.getState().back();
    expect(s.getState().route).toEqual(albums);
    expect(s.getState().future).toEqual([album3]);
    expect(s.getState().past).toEqual([home]);
    expect(s.getState().canForward()).toBe(true);

    s.getState().forward();
    expect(s.getState().route).toEqual(album3);
    expect(s.getState().future).toEqual([]);
    expect(s.getState().past).toEqual([home, albums]);
  });

  it("navigate(artists) après back() vide future", () => {
    const s = createUiStore();
    s.getState().navigate(albums);
    s.getState().navigate(album3);
    s.getState().back();
    s.getState().navigate(artists);
    expect(s.getState().future).toEqual([]);
    expect(s.getState().canForward()).toBe(false);
    expect(s.getState().route).toEqual(artists);
    expect(s.getState().past).toEqual([home, albums]);
  });

  it("navigate vers la route courante ne pousse rien (ni ne vide future)", () => {
    const s = createUiStore();
    s.getState().navigate(albums);
    s.getState().navigate(album3);
    s.getState().back();
    const before = s.getState();
    s.getState().navigate({ name: "albums" });
    expect(s.getState().past).toEqual([home]);
    expect(s.getState().future).toEqual([album3]);
    expect(s.getState().route).toBe(before.route);
  });

  it("back()/forward() sans historique sont des no-op", () => {
    const s = createUiStore();
    s.getState().back();
    s.getState().forward();
    expect(s.getState().route).toEqual(home);
    expect(s.getState().past).toEqual([]);
    expect(s.getState().future).toEqual([]);
  });

  it("l'historique précédent est borné à HISTORY_LIMIT entrées", () => {
    const s = createUiStore();
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) s.getState().navigate({ name: "album", id: i });
    expect(s.getState().past.length).toBe(HISTORY_LIMIT);
    expect(s.getState().route).toEqual({ name: "album", id: HISTORY_LIMIT + 20 });
    // Les plus anciennes entrées sont abandonnées en premier.
    expect(s.getState().past[HISTORY_LIMIT - 1]).toEqual({ name: "album", id: HISTORY_LIMIT + 19 });
  });

  it("setCompact / setShortcutsHelpOpen", () => {
    const s = createUiStore();
    expect(s.getState().compact).toBe(false);
    expect(s.getState().shortcutsHelpOpen).toBe(false);
    s.getState().setCompact(true);
    s.getState().setShortcutsHelpOpen(true);
    expect(s.getState().compact).toBe(true);
    expect(s.getState().shortcutsHelpOpen).toBe(true);
  });

  it("le singleton uiStore expose la même API", () => {
    expect(typeof uiStore.getState().navigate).toBe("function");
    expect(uiStore.getState().route.name).toBeDefined();
  });
});

describe("sameRoute / routeKey / navSectionOf", () => {
  it("sameRoute compare le nom ET les paramètres", () => {
    expect(sameRoute(home, { name: "home" })).toBe(true);
    expect(sameRoute(album3, { name: "album", id: 3 })).toBe(true);
    expect(sameRoute(album3, { name: "album", id: 4 })).toBe(false);
    expect(sameRoute({ name: "artist", artist: "A" }, { name: "artist", artist: "B" })).toBe(false);
    expect(sameRoute({ name: "search", q: "abc" }, { name: "search", q: "abc" })).toBe(true);
    expect(sameRoute({ name: "search", q: "abc" }, { name: "search", q: "abd" })).toBe(false);
    expect(sameRoute({ name: "playlist", id: 1 }, { name: "album", id: 1 })).toBe(false);
    expect(sameRoute(albums, artists)).toBe(false);
  });

  it("routeKey est stable et distingue les paramètres", () => {
    expect(routeKey(home)).toBe("home");
    expect(routeKey(album3)).toBe("album:3");
    expect(routeKey({ name: "playlist", id: 7 })).toBe("playlist:7");
    expect(routeKey({ name: "search", q: "x" })).toBe("search");
    expect(routeKey({ name: "artist", artist: "Ado" })).not.toBe(
      routeKey({ name: "artist", artist: "Aimer" }),
    );
  });

  it("navSectionOf rattache les pages de détail à leur entrée de barre latérale", () => {
    expect(navSectionOf(home)).toBe("home");
    expect(navSectionOf(album3)).toBe("albums");
    expect(navSectionOf({ name: "artist", artist: "Ado" })).toBe("artists");
    expect(navSectionOf({ name: "playlist", id: 2 })).toBe("playlists");
    expect(navSectionOf({ name: "search", q: "" })).toBeNull();
    expect(navSectionOf({ name: "settings" })).toBe("settings");
  });
});

// --- Pont DEV : `window.__benten.ui` -----------------------------------------------------------

class FakeNode {
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}
class FakeAudioContext {
  currentTime = 0;
  state = "running";
  sampleRate = 48000;
  destination = new FakeNode();
  createGain(): FakeNode & { gain: Record<string, unknown> } {
    return Object.assign(new FakeNode(), {
      gain: {
        value: 1,
        cancelScheduledValues(): void {},
        setValueAtTime(): void {},
        linearRampToValueAtTime(): void {},
      },
    });
  }
  createAnalyser(): FakeNode {
    return new FakeNode();
  }
  async close(): Promise<void> {}
}

describe("pont dev", () => {
  let runtime: AudioRuntime | null = null;
  afterEach(() => {
    runtime?.dispose();
    runtime = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("en dev, window.__benten.ui expose uiStore", () => {
    vi.stubEnv("DEV", true);
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    runtime = startAudioRuntime({
      createContext: () => new FakeAudioContext() as unknown as AudioContext,
      createDecoder: (): Decoder => ({
        canDecode: () => true,
        decode: async () => ({ duration: 1 }) as unknown as AudioBuffer,
      }),
      raf: () => 1,
      caf: () => undefined,
    });
    const bridge = win.__benten as Record<string, unknown>;
    expect(bridge.ui).toBe(uiStore);
  });
});
