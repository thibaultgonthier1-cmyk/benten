import { afterEach, describe, expect, it, vi } from "vitest";
import { startAudioRuntime, type AudioRuntime } from "../src/renderer/runtime/audioRuntime";
import { playerStore } from "../src/renderer/state/player";
import { libraryStore } from "../src/renderer/state/library";
import type { Decoder } from "../src/renderer/audio/decoder";

/**
 * Runtime audio (Phase 3, Tâche 2) : la logique jadis dans l'effet d'`App.tsx` (liaison store,
 * `attachEngine`, recréation de contexte au changement de qualité, pont dev, boucle rAF 66 ms,
 * sauvegarde) vit désormais dans `startAudioRuntime`. Fabriques injectées : aucun vrai Web Audio.
 */

class FakeNode {
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}
class FakeGain extends FakeNode {
  gain = {
    value: 1,
    cancelScheduledValues(): void {},
    setValueAtTime(v: number): void {
      this.value = v;
    },
    linearRampToValueAtTime(v: number): void {
      this.value = v;
    },
  };
}
class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = new FakeNode();
  closed = 0;
  constructor(public sampleRate = 48000) {}
  createGain(): FakeGain {
    return new FakeGain();
  }
  createAnalyser(): FakeNode {
    return new FakeNode();
  }
  async close(): Promise<void> {
    this.closed++;
    this.state = "closed";
  }
}

const fakeDecoder = (): Decoder => ({
  canDecode: () => true,
  decode: async () => ({ duration: 1 }) as unknown as AudioBuffer,
});

function harness() {
  const contexts: FakeAudioContext[] = [];
  const createContext = vi.fn((opts?: AudioContextOptions) => {
    const ctx = new FakeAudioContext(opts?.sampleRate ?? 48000);
    contexts.push(ctx);
    return ctx as unknown as AudioContext;
  });
  const createDecoder = vi.fn((_ctx: AudioContext) => fakeDecoder());
  const frames: FrameRequestCallback[] = [];
  let nextId = 0;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    frames.push(cb);
    return ++nextId;
  });
  const caf = vi.fn((_id: number) => undefined);
  /** Exécute le dernier callback rAF programmé avec le timestamp donné. */
  const frame = (ts: number): void => {
    const cb = frames[frames.length - 1]!;
    cb(ts);
  };
  return { contexts, createContext, createDecoder, raf, caf, frame, lastId: () => nextId };
}

let runtime: AudioRuntime | undefined;

afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("startAudioRuntime", () => {
  it("crée UN SEUL contexte (et un décodeur dessus) et démarre la boucle rAF", () => {
    const h = harness();
    runtime = startAudioRuntime(h);
    expect(h.createContext).toHaveBeenCalledTimes(1);
    expect(h.createContext).toHaveBeenCalledWith();
    expect(h.createDecoder).toHaveBeenCalledTimes(1);
    expect(h.createDecoder).toHaveBeenCalledWith(h.contexts[0]);
    expect(runtime.engine.getContext()).toBe(h.contexts[0]);
    expect(h.raf).toHaveBeenCalledTimes(1);
    expect(typeof runtime.controls.playAlbum).toBe("function");
  });

  it("la boucle rAF pompe tick() à ~15 Hz (porte 66 ms) et se reprogramme à chaque frame", () => {
    const h = harness();
    runtime = startAudioRuntime(h);
    const tick = vi.spyOn(runtime.engine, "tick");
    h.frame(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    h.frame(1030); // < 66 ms : pas de tick
    expect(tick).toHaveBeenCalledTimes(1);
    h.frame(1070);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(h.raf).toHaveBeenCalledTimes(4); // initial + une reprogrammation par frame
  });

  it("rattache le moteur au store ; dispose() annule la boucle rAF et détache le store", () => {
    const h = harness();
    runtime = startAudioRuntime(h);
    const setVolume = vi.spyOn(runtime.engine, "setVolume");
    playerStore.getState().setVolume(0.5);
    expect(setVolume).toHaveBeenCalledWith(0.5);

    h.frame(0);
    const pending = h.lastId();
    runtime.dispose();
    expect(h.caf).toHaveBeenCalledWith(pending);

    setVolume.mockClear();
    playerStore.getState().setVolume(0.8);
    expect(setVolume).not.toHaveBeenCalled(); // store détaché du moteur
    playerStore.getState().setVolume(1);
  });

  it("dispose() est idempotent", () => {
    const h = harness();
    runtime = startAudioRuntime(h);
    runtime.dispose();
    runtime.dispose();
    expect(h.caf).toHaveBeenCalledTimes(1);
  });

  it("dispose() garde le contexte ouvert par défaut ; dispose({closeContext}) le ferme", () => {
    const h1 = harness();
    const r1 = startAudioRuntime(h1);
    r1.dispose();
    expect(h1.contexts[0]!.closed).toBe(0);

    const h2 = harness();
    runtime = startAudioRuntime(h2);
    runtime.dispose({ closeContext: true });
    runtime.dispose({ closeContext: true }); // idempotent : une seule fermeture
    expect(h2.contexts[0]!.closed).toBe(1);
  });

  it("changement de qualité : nouveau contexte à la fréquence du mode, l'ANCIEN est fermé", async () => {
    const h = harness();
    runtime = startAudioRuntime(h);
    const old = h.contexts[0]!;
    playerStore.getState().setQualityMode("economy");
    await vi.waitFor(() => expect(old.closed).toBe(1));
    expect(h.createContext).toHaveBeenCalledTimes(2);
    expect(h.createContext).toHaveBeenLastCalledWith({ sampleRate: 44100 });
    expect(runtime.engine.getContext()).toBe(h.contexts[1]);
    expect(h.contexts[1]!.closed).toBe(0); // un seul contexte vivant
    expect(h.createDecoder).toHaveBeenLastCalledWith(h.contexts[1]);

    runtime.dispose();
    playerStore.getState().setQualityMode("balanced"); // gestionnaire détaché : aucune recréation
    expect(h.createContext).toHaveBeenCalledTimes(2);
  });

  it("pas de window.__benten hors dev", () => {
    vi.stubEnv("DEV", false);
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    runtime = startAudioRuntime(harness());
    expect(win.__benten).toBeUndefined();
  });

  it("lie navigator.mediaSession (touches média) et la libère au dispose", () => {
    const handlers = new Map<string, unknown>();
    const ms = {
      metadata: null as unknown,
      playbackState: "none",
      setActionHandler(a: string, h: unknown): void {
        handlers.set(a, h);
      },
    };
    vi.stubGlobal("navigator", { mediaSession: ms });
    runtime = startAudioRuntime(harness());
    expect(typeof handlers.get("nexttrack")).toBe("function");
    const next = vi.spyOn(runtime.controls, "next");
    (handlers.get("nexttrack") as () => void)();
    expect(next).toHaveBeenCalledTimes(1);
    runtime.dispose();
    expect(handlers.get("nexttrack")).toBeNull();
    expect(ms.metadata).toBeNull();
  });

  it("sans mediaSession (navigator de node) : le runtime démarre normalement", () => {
    vi.stubGlobal("navigator", {});
    expect(() => {
      runtime = startAudioRuntime(harness());
    }).not.toThrow();
  });

  it("en dev, le pont expose engine/store/persist/library et est retiré au dispose", () => {
    vi.stubEnv("DEV", true);
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    runtime = startAudioRuntime(harness());
    const bridge = win.__benten as Record<string, unknown>;
    expect(bridge.engine).toBe(runtime.engine);
    expect(bridge.store).toBe(playerStore);
    expect(bridge.library).toBe(libraryStore);
    expect(bridge.persist).toBeDefined();
    runtime.dispose();
    expect(win.__benten).toBeUndefined();
  });
});
