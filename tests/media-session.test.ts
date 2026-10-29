import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMediaSession } from "../src/renderer/runtime/mediaSession";
import { createPlayerStore } from "../src/renderer/state/player";
import type { PlayerControls } from "../src/renderer/components/controls";
import type { TrackRow } from "../src/shared/types";

/** MediaSession factice (node : pas de navigator.mediaSession). */
class FakeMediaSession {
  metadata: unknown = null;
  playbackState: MediaSessionPlaybackState = "none";
  handlers = new Map<string, ((details: MediaSessionActionDetails) => void) | null>();
  positions: MediaPositionState[] = [];
  setActionHandler(action: string, handler: ((d: MediaSessionActionDetails) => void) | null): void {
    this.handlers.set(action, handler);
  }
  setPositionState(state?: MediaPositionState): void {
    if (state) this.positions.push(state);
  }
  fire(action: string, details: Partial<MediaSessionActionDetails> = {}): void {
    const h = this.handlers.get(action);
    if (!h) throw new Error(`no handler for ${action}`);
    h({ action, ...details } as MediaSessionActionDetails);
  }
}

const track = (id: number, title: string, extra: Partial<TrackRow> = {}): TrackRow => ({
  id,
  path: `C:/m/${id}.flac`,
  title,
  artist: "Ryuichi Sakamoto",
  album: "async",
  albumArtist: null,
  albumId: 1,
  trackNo: id,
  discNo: 1,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 16,
  playable: true,
  artKey: "abc/def",
  mtimeMs: null,
  sizeBytes: null,
  addedAtMs: null,
  ...extra,
});

const fakeControls = (): PlayerControls & Record<string, ReturnType<typeof vi.fn>> =>
  ({
    playAlbum: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seekFraction: vi.fn(),
  }) as unknown as PlayerControls & Record<string, ReturnType<typeof vi.fn>>;

const meta = (ms: FakeMediaSession) =>
  ms.metadata as { title: string; artist: string; album: string; artwork: MediaImage[] } | null;

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  vi.unstubAllGlobals();
});

describe("bindMediaSession", () => {
  it("changement de currentTrack → metadata (titre, artiste, album, pochette 512)", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession);
    expect(ms.metadata).toBeNull();

    store.getState().setQueue([track(1, "andata"), track(2, "disintegration")], 0);
    expect(meta(ms)?.title).toBe("andata");
    expect(meta(ms)?.artist).toBe("Ryuichi Sakamoto");
    expect(meta(ms)?.album).toBe("async");
    expect(meta(ms)?.artwork).toEqual([
      { src: "benten-art://abc%2Fdef?size=512", sizes: "512x512" },
    ]);

    store.getState().next();
    expect(meta(ms)?.title).toBe("disintegration");
  });

  it("piste sans pochette : pas d'artwork ; file vidée : metadata null", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession);
    store.getState().setQueue([track(1, "solari", { artKey: null })], 0);
    expect(meta(ms)?.artwork).toEqual([]);
    store.getState().setQueue([], 0);
    expect(ms.metadata).toBeNull();
  });

  it("playbackState suit le statut du moteur", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession);
    store.getState().setQueue([track(1, "a")], 0);
    const base = { trackId: 1, queueIndex: 0, positionSec: 0, durationSec: 200 };
    store.getState().applyEngineState({ ...base, status: "playing" } as never);
    expect(ms.playbackState).toBe("playing");
    store.getState().applyEngineState({ ...base, status: "paused" } as never);
    expect(ms.playbackState).toBe("paused");
    store.getState().applyEngineState({ ...base, status: "idle" } as never);
    expect(ms.playbackState).toBe("none");
  });

  it("file vidée en pause (statut inchangé) : playbackState repasse à none", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession);
    store.getState().setQueue([track(1, "a")], 0);
    store.getState().applyEngineState({
      trackId: 1,
      queueIndex: 0,
      positionSec: 3,
      durationSec: 200,
      status: "paused",
    } as never);
    expect(ms.playbackState).toBe("paused");
    store.getState().setQueue([], 0);
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe("none");
  });

  it("nexttrack → controls.next ; previoustrack → prev ; play/pause → toggle selon l'état", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const controls = fakeControls();
    release = bindMediaSession(store, controls, ms as unknown as MediaSession);
    ms.fire("nexttrack");
    expect(controls.next).toHaveBeenCalledTimes(1);
    ms.fire("previoustrack");
    expect(controls.prev).toHaveBeenCalledTimes(1);

    ms.fire("play"); // à l'arrêt : bascule vers lecture
    expect(controls.toggle).toHaveBeenCalledTimes(1);
    ms.fire("pause"); // déjà à l'arrêt : rien
    expect(controls.toggle).toHaveBeenCalledTimes(1);
  });

  it("seekto → seekFraction(seekTime / durée)", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const controls = fakeControls();
    release = bindMediaSession(store, controls, ms as unknown as MediaSession);
    store.getState().setQueue([track(1, "a")], 0);
    ms.fire("seekto", { seekTime: 50 });
    expect(controls.seekFraction).toHaveBeenCalledWith(0.25);
  });

  it("le désabonnement retire les gestionnaires et ne suit plus le store", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const off = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession);
    store.getState().setQueue([track(1, "a")], 0);
    off();
    for (const a of ["play", "pause", "previoustrack", "nexttrack", "seekto"]) {
      expect(ms.handlers.get(a)).toBeNull();
    }
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe("none");
    store.getState().setQueue([track(2, "b")], 0);
    expect(ms.metadata).toBeNull();
  });

  it("sans MediaSession (node, navigator sans mediaSession) : no-op qui ne lève jamais", () => {
    const store = createPlayerStore();
    vi.stubGlobal("navigator", {});
    const off = bindMediaSession(store, fakeControls());
    expect(() => store.getState().setQueue([track(1, "a")], 0)).not.toThrow();
    expect(() => off()).not.toThrow();
  });

  it("utilise navigator.mediaSession par défaut quand il existe", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    vi.stubGlobal("navigator", { mediaSession: ms });
    release = bindMediaSession(store, fakeControls());
    store.getState().setQueue([track(1, "andata")], 0);
    expect(meta(ms)?.title).toBe("andata");
  });

  it("un gestionnaire non pris en charge (setActionHandler lève) n'empêche pas les autres", () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const orig = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (a, h) => {
      if (a === "seekto") throw new TypeError("unsupported");
      orig(a, h);
    };
    const controls = fakeControls();
    expect(() => {
      release = bindMediaSession(store, controls, ms as unknown as MediaSession);
    }).not.toThrow();
    ms.fire("nexttrack");
    expect(controls.next).toHaveBeenCalled();
  });
});

describe("bindMediaSession : pochette servie en blob (repli robuste pour l'overlay système)", () => {
  /** fetch factice contrôlable : chaque appel renvoie une promesse résolue à la main. */
  function harness() {
    const pending = new Map<string, { resolve: (b: Blob) => void; reject: (e: unknown) => void }>();
    const fetchArt = vi.fn(
      (url: string) =>
        new Promise<Blob>((resolve, reject) => {
          pending.set(url, { resolve, reject });
        }),
    );
    let n = 0;
    const created: string[] = [];
    const revoked: string[] = [];
    const objectUrls = {
      create: vi.fn((_b: Blob) => {
        const u = `blob:fake/${++n}`;
        created.push(u);
        return u;
      }),
      revoke: vi.fn((u: string) => {
        revoked.push(u);
      }),
    };
    const settle = async (url: string, ok = true): Promise<void> => {
      const p = pending.get(url)!;
      if (ok) p.resolve(new Blob(["jpg"], { type: "image/jpeg" }));
      else p.reject(new TypeError("Failed to fetch"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { fetchArt, objectUrls, settle, created, revoked };
  }
  const ART1 = "benten-art://abc%2Fdef?size=512";
  const ART2 = "benten-art://zzz?size=512";

  it("remplace l'URL du protocole par une URL d'objet une fois la pochette chargée", async () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const h = harness();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession, {
      fetchArt: h.fetchArt,
      objectUrls: h.objectUrls,
    });
    store.getState().setQueue([track(1, "andata")], 0);
    // Immédiatement : URL du protocole (rien n'attend le chargement).
    expect(meta(ms)?.artwork[0]?.src).toBe(ART1);
    expect(h.fetchArt).toHaveBeenCalledWith(ART1);
    await h.settle(ART1);
    expect(meta(ms)?.title).toBe("andata");
    expect(meta(ms)?.artwork).toEqual([{ src: "blob:fake/1", sizes: "512x512", type: "image/jpeg" }]);
  });

  it("résultat périmé (piste déjà changée) : n'écrase jamais la nouvelle piste, rien ne fuit", async () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const h = harness();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession, {
      fetchArt: h.fetchArt,
      objectUrls: h.objectUrls,
    });
    store.getState().setQueue([track(1, "a"), track(2, "b", { artKey: "zzz" })], 0);
    store.getState().next(); // la piste 2 arrive avant la pochette de la 1
    await h.settle(ART1); // pochette de la 1, en retard
    expect(meta(ms)?.title).toBe("b");
    expect(meta(ms)?.artwork[0]?.src).toBe(ART2);
    expect(h.created).toEqual([]); // aucune URL d'objet créée pour un résultat périmé
    await h.settle(ART2);
    expect(meta(ms)?.artwork[0]?.src).toBe("blob:fake/1");
  });

  it("révoque l'URL précédente au changement de piste et au désabonnement", async () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const h = harness();
    const off = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession, {
      fetchArt: h.fetchArt,
      objectUrls: h.objectUrls,
    });
    store.getState().setQueue([track(1, "a"), track(2, "b", { artKey: "zzz" })], 0);
    await h.settle(ART1);
    store.getState().next();
    expect(h.revoked).toEqual(["blob:fake/1"]);
    await h.settle(ART2);
    off();
    expect(h.revoked).toEqual(["blob:fake/1", "blob:fake/2"]);
  });

  it("échec du chargement : l'URL du protocole reste (jamais d'exception)", async () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const h = harness();
    release = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession, {
      fetchArt: h.fetchArt,
      objectUrls: h.objectUrls,
    });
    store.getState().setQueue([track(1, "a")], 0);
    await h.settle(ART1, false);
    expect(meta(ms)?.artwork[0]?.src).toBe(ART1);
    expect(h.created).toEqual([]);
  });

  it("désabonné avant la fin du chargement : le résultat est ignoré", async () => {
    const store = createPlayerStore();
    const ms = new FakeMediaSession();
    const h = harness();
    const off = bindMediaSession(store, fakeControls(), ms as unknown as MediaSession, {
      fetchArt: h.fetchArt,
      objectUrls: h.objectUrls,
    });
    store.getState().setQueue([track(1, "a")], 0);
    off();
    await h.settle(ART1);
    expect(ms.metadata).toBeNull();
    expect(h.created).toEqual([]);
  });
});
