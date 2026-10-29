import { beforeEach, describe, expect, it } from "vitest";
import {
  createDiagnosticsSink,
  startAudioDiagnostics,
  type DiagContextLike,
  type DiagEngineLike,
} from "../src/renderer/audio/diagnostics";
import type { PlaybackState } from "../src/renderer/audio/engine";
import type { DiagEntry } from "../src/shared/diagnostics";

/**
 * Journal audio (renderer) — tests du detecteur et des autres sondes, entierement deterministes :
 * horloge, minuteur, contexte audio et moteur sont des faux injectes.
 */

/** Faux contexte : `getOutputTimestamp` pilote par le test. */
class FakeCtx implements DiagContextLike {
  state: AudioContextState = "running";
  sampleRate = 48000;
  baseLatency = 0.02;
  outputLatency = 0.04;
  contextTime = 1;
  performanceTime = 1000;
  throwOnTimestamp = false;
  private readonly listeners = new Set<() => void>();
  getOutputTimestamp(): AudioTimestamp {
    if (this.throwOnTimestamp) throw new Error("boom");
    return { contextTime: this.contextTime, performanceTime: this.performanceTime };
  }
  addEventListener(_type: "statechange", cb: () => void): void {
    this.listeners.add(cb);
  }
  removeEventListener(_type: "statechange", cb: () => void): void {
    this.listeners.delete(cb);
  }
  fireState(s: AudioContextState): void {
    this.state = s;
    for (const cb of [...this.listeners]) cb();
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

/** Faux moteur : etat pilote par le test, `statechange` emis a la demande. */
class FakeEngine implements DiagEngineLike {
  state: PlaybackState = {
    status: "playing",
    positionSec: 10,
    durationSec: 300,
    trackId: 7,
    queueIndex: 0,
  };
  private readonly cbs = new Set<(s: PlaybackState) => void>();
  private readonly seekCbs = new Set<(p: SeekPayload) => void>();
  on(e: "statechange", cb: (s: PlaybackState) => void): () => void;
  on(e: "seek", cb: (p: SeekPayload) => void): () => void;
  on(e: "statechange" | "seek", cb: ((s: PlaybackState) => void) | ((p: SeekPayload) => void)): () => void {
    const set = (e === "seek" ? this.seekCbs : this.cbs) as Set<unknown>;
    set.add(cb);
    return () => set.delete(cb);
  }
  getState(): PlaybackState {
    return { ...this.state };
  }
  set(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of [...this.cbs]) cb({ ...this.state });
  }
  /** Seek utilisateur : la position saute, le moteur emet `seek` (pas de statechange). */
  seek(sec: number): void {
    this.state = { ...this.state, positionSec: sec };
    for (const cb of [...this.seekCbs]) cb({ positionSec: sec, trackId: this.state.trackId });
  }
  listenerCount(): number {
    return this.cbs.size + this.seekCbs.size;
  }
}

type SeekPayload = { positionSec: number; trackId: number | null };

/** Banc de test : horloge + minuteur manuels, contexte et moteur faux. */
function bench(opts: { appendThrows?: boolean } = {}) {
  let now = 5000;
  let tickFn: (() => void) | null = null;
  const ctx = new FakeCtx();
  let currentCtx: FakeCtx = ctx;
  const engine = new FakeEngine();
  const entries: DiagEntry[] = [];
  const handle = startAudioDiagnostics({
    getContext: () => currentCtx,
    engine,
    append: (e) => {
      if (opts.appendThrows) throw new Error("append failed");
      entries.push(e);
    },
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    setInterval: (fn) => {
      tickFn = fn;
      return 1;
    },
    clearInterval: () => {
      tickFn = null;
    },
    latencyHint: "playback",
  });
  /** Un pas nominal de 20 ms : horloge murale, performanceTime et contextTime avancent ensemble. */
  const step = (ms = 20, ctxMs = ms): void => {
    now += ms;
    ctx.performanceTime += ms;
    ctx.contextTime += ctxMs / 1000;
    if (engine.state.status === "playing") {
      engine.state = { ...engine.state, positionSec: engine.state.positionSec + ctxMs / 1000 };
    }
    tickFn?.();
  };
  const steps = (n: number): void => {
    for (let i = 0; i < n; i++) step();
  };
  return {
    ctx,
    engine,
    entries,
    handle,
    step,
    steps,
    setCtx: (c: FakeCtx) => {
      currentCtx = c;
    },
    tickRaw: () => tickFn?.(),
    advanceWall: (ms: number) => {
      now += ms;
    },
    isTicking: () => tickFn !== null,
    of: (kind: string) => entries.filter((e) => e.kind === kind),
  };
}

describe("startAudioDiagnostics — session", () => {
  it("ecrit une entree session au demarrage (sampleRate, latences, latencyHint) horodatee ISO", () => {
    const b = bench();
    const s = b.of("session");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      kind: "session",
      sampleRate: 48000,
      baseLatency: 0.02,
      outputLatency: 0.04,
      latencyHint: "playback",
    });
    expect(typeof s[0]!.t).toBe("string");
    expect(new Date(s[0]!.t).toISOString()).toBe(s[0]!.t);
    b.handle.stop();
  });

  it("logSession:false n'ecrit pas d'entree session (remontage StrictMode) mais journalise le reste", () => {
    const entries: DiagEntry[] = [];
    const engine = new FakeEngine();
    const h = startAudioDiagnostics({
      getContext: () => new FakeCtx(),
      engine,
      append: (e) => entries.push(e),
      setInterval: () => 1,
      clearInterval: () => {},
      logSession: false,
    });
    engine.set({ status: "paused" });
    h.stop();
    expect(entries.filter((e) => e.kind === "session")).toHaveLength(0);
    expect(entries.filter((e) => e.kind === "engine")).toHaveLength(1);
  });
});

describe("startAudioDiagnostics — detecteur de coupures (glitch)", () => {
  let b: ReturnType<typeof bench>;
  beforeEach(() => {
    b = bench();
  });

  it("horloges qui avancent normalement : 0 glitch", () => {
    b.steps(200); // 4 s
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
    expect(b.of("glitch")).toHaveLength(0);
  });

  it("un retard de 30 ms du contextTime -> 1 glitch lostMs≈30 avec le contexte de lecture", () => {
    b.steps(10);
    b.step(50, 20); // performanceTime +50 ms, contextTime +20 ms : 30 ms perdus
    b.steps(80); // > 1 s : l'entree coalescee est emise
    const g = b.of("glitch");
    expect(g).toHaveLength(1);
    expect(g[0]!.lostMs as number).toBeCloseTo(30, 0);
    expect(g[0]).toMatchObject({
      kind: "glitch",
      count: 1,
      trackId: 7,
      ctxState: "running",
      baseLatency: 0.02,
      outputLatency: 0.04,
    });
    expect(typeof g[0]!.positionSec).toBe("number");
    b.handle.stop();
  });

  it("trois retards en 600 ms -> UNE entree coalescee count:3 (lostMs total)", () => {
    b.steps(10);
    b.step(50, 20);
    b.steps(10); // +200 ms
    b.step(50, 20);
    b.steps(10);
    b.step(50, 20);
    b.steps(80);
    const g = b.of("glitch");
    expect(g).toHaveLength(1);
    expect(g[0]!.count).toBe(3);
    expect(g[0]!.lostMs as number).toBeCloseTo(90, 0);
    b.handle.stop();
  });

  it("deux retards separes de plus d'1 s -> deux entrees distinctes", () => {
    b.steps(10);
    b.step(50, 20);
    b.steps(75); // 1,5 s
    b.step(50, 20);
    b.steps(80);
    expect(b.of("glitch")).toHaveLength(2);
    b.handle.stop();
  });

  it("un glitch en attente de coalescence est emis a stop()", () => {
    b.steps(10);
    b.step(50, 20);
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
    expect(b.of("glitch")).toHaveLength(1);
  });

  it("pas de glitch quand le moteur est en pause", () => {
    b.engine.set({ status: "paused" });
    b.steps(10);
    b.step(50, 20);
    b.steps(80);
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
  });

  it("les echantillons avec performanceTime = 0 sont ignores", () => {
    b.steps(10);
    const pt = b.ctx.performanceTime;
    b.ctx.performanceTime = 0;
    b.tickRaw(); // echantillon invalide : ignore
    b.ctx.performanceTime = pt + 400; // reprise : pas de faux saut compte a travers le trou
    b.ctx.contextTime += 0.02;
    b.tickRaw();
    b.steps(80);
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
  });
});

describe("startAudioDiagnostics — stall, engine, position-jump", () => {
  it("stall : l'intervalle de 20 ms arrive avec 400 ms de retard", () => {
    const b = bench();
    b.steps(5);
    b.step(420); // 400 ms de retard sur l'intervalle nominal
    const s = b.of("stall");
    expect(s).toHaveLength(1);
    expect(s[0]!.ms as number).toBeCloseTo(400, 0);
    // Les horloges audio ont avance ensemble : ce n'est PAS une coupure.
    b.steps(80);
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
  });

  it("un retard sous 250 ms n'est pas un stall", () => {
    const b = bench();
    b.step(200);
    expect(b.of("stall")).toHaveLength(0);
    b.handle.stop();
  });

  it("engine : journalise la transition playing -> loading (et le changement de piste)", () => {
    const b = bench();
    b.engine.set({ status: "loading", trackId: 8 });
    const e = b.of("engine");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "engine", from: "playing", to: "loading", trackId: 8 });
    expect(typeof e[0]!.positionSec).toBe("number");
    // Meme statut, piste differente (promotion gapless playing -> playing) : journalise aussi.
    b.engine.set({ status: "playing", trackId: 8 });
    b.engine.set({ status: "playing", trackId: 9 });
    expect(b.of("engine")).toHaveLength(3);
    // Rien ne change : rien n'est journalise.
    b.engine.set({ status: "playing", trackId: 9 });
    expect(b.of("engine")).toHaveLength(3);
    b.handle.stop();
  });

  it("position-jump : la position avance de 5 s d'un coup en lecture, meme piste", () => {
    const b = bench();
    b.steps(10);
    b.engine.state = { ...b.engine.state, positionSec: b.engine.state.positionSec + 5 };
    b.step();
    const j = b.of("engine").filter((e) => e.event === "position-jump");
    expect(j).toHaveLength(1);
    expect(j[0]!.deltaSec as number).toBeCloseTo(5, 1);
    b.steps(20);
    expect(b.of("engine").filter((e) => e.event === "position-jump")).toHaveLength(1);
    b.handle.stop();
  });

  it("un seek utilisateur (evenement `seek` du moteur) n'est PAS un position-jump", () => {
    const b = bench();
    b.steps(10);
    b.engine.seek(120); // +110 s d'un coup
    b.step();
    b.steps(10);
    b.engine.seek(3); // recul
    b.step();
    b.steps(10);
    expect(b.of("engine").filter((e) => e.event === "position-jump")).toHaveLength(0);
    b.handle.stop();
  });

  it("un statechange (ex. redemarrage de piste playing -> playing) re-cale la position attendue", () => {
    const b = bench();
    b.steps(10);
    b.engine.state = { ...b.engine.state, positionSec: 0 };
    b.engine.set({ status: "playing" }); // emis par restartCurrent / promotion gapless
    b.step();
    b.steps(5);
    expect(b.of("engine").filter((e) => e.event === "position-jump")).toHaveLength(0);
    b.handle.stop();
  });

  it("position-jump : un recul de position est detecte, un changement de piste ne l'est pas", () => {
    const b = bench();
    b.steps(10);
    b.engine.state = { ...b.engine.state, positionSec: 1 };
    b.step();
    expect(b.of("engine").filter((e) => e.event === "position-jump")).toHaveLength(1);
    // Nouvelle piste, position remise a 0 : attendu, pas de saut.
    b.engine.state = { ...b.engine.state, trackId: 99, positionSec: 0 };
    b.step();
    b.steps(5);
    expect(b.of("engine").filter((e) => e.event === "position-jump")).toHaveLength(1);
    b.handle.stop();
  });
});

describe("startAudioDiagnostics — contexte, robustesse, arret", () => {
  it("ctx : statechange du contexte et remplacement de contexte (reconstruction de qualite)", () => {
    const b = bench();
    b.ctx.fireState("suspended");
    expect(b.of("ctx")).toEqual([
      expect.objectContaining({ kind: "ctx", event: "statechange", state: "suspended" }),
    ]);
    const ctx2 = new FakeCtx();
    ctx2.sampleRate = 44100;
    b.setCtx(ctx2);
    b.step();
    const replaced = b.of("ctx").filter((e) => e.event === "replaced");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ sampleRate: 44100, baseLatency: 0.02, outputLatency: 0.04 });
    // L'ancien contexte n'est plus ecoute ; le nouveau l'est.
    expect(b.ctx.listenerCount()).toBe(0);
    expect(ctx2.listenerCount()).toBe(1);
    ctx2.fireState("closed");
    expect(b.of("ctx").filter((e) => e.state === "closed")).toHaveLength(1);
    b.handle.stop();
    expect(ctx2.listenerCount()).toBe(0);
  });

  it("une exception levee par append n'est jamais propagee (demarrage, tick, statechange)", () => {
    expect(() => {
      const b = bench({ appendThrows: true });
      b.engine.set({ status: "loading" });
      b.step(420);
      b.step(50, 20);
      b.steps(80);
      b.ctx.fireState("suspended");
      b.handle.stop();
    }).not.toThrow();
  });

  it("une exception levee par getOutputTimestamp n'est pas propagee", () => {
    const b = bench();
    b.ctx.throwOnTimestamp = true;
    expect(() => b.steps(5)).not.toThrow();
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
  });

  it("contexte sans getOutputTimestamp : garde, aucune erreur, aucun glitch", () => {
    const b = bench();
    (b.ctx as unknown as { getOutputTimestamp?: unknown }).getOutputTimestamp = undefined;
    expect(() => b.steps(10)).not.toThrow();
    expect(b.of("glitch")).toHaveLength(0);
    b.handle.stop();
  });

  it("stop() arrete le minuteur et se desabonne du moteur ; idempotent", () => {
    const b = bench();
    expect(b.isTicking()).toBe(true);
    expect(b.engine.listenerCount()).toBeGreaterThan(0);
    b.handle.stop();
    b.handle.stop();
    expect(b.isTicking()).toBe(false);
    expect(b.engine.listenerCount()).toBe(0);
  });

  it("le journal n'appelle aucun mutateur du moteur (observation seule)", () => {
    const b = bench();
    const engineAny = b.engine as unknown as Record<string, unknown>;
    for (const m of ["play", "pause", "seek", "setQueue", "tick", "load", "rebuildContext"]) {
      engineAny[m] = () => {
        throw new Error(`mutator ${m} called`);
      };
    }
    b.steps(10);
    b.step(50, 20);
    b.step(420);
    b.engine.set({ status: "paused" });
    expect(() => b.handle.stop()).not.toThrow();
  });
});

describe("startAudioDiagnostics — device et window", () => {
  /** Cible d'evenements minimale (EventTarget-like). */
  function target() {
    const map = new Map<string, Set<() => void>>();
    return {
      addEventListener: (t: string, cb: () => void) => {
        if (!map.has(t)) map.set(t, new Set());
        map.get(t)!.add(cb);
      },
      removeEventListener: (t: string, cb: () => void) => {
        map.get(t)?.delete(cb);
      },
      fire: (t: string) => {
        for (const cb of [...(map.get(t) ?? [])]) cb();
      },
      count: () => [...map.values()].reduce((n, s) => n + s.size, 0),
    };
  }

  it("device : devicechange journalise le nombre de sorties audio (sans libelles ni ids)", async () => {
    const md = Object.assign(target(), {
      enumerateDevices: async () => [
        { kind: "audiooutput", label: "Speakers", deviceId: "abc" },
        { kind: "audiooutput", label: "Headset", deviceId: "def" },
        { kind: "audioinput", label: "Mic", deviceId: "ghi" },
      ],
    });
    const win = target();
    const doc = Object.assign(target(), { visibilityState: "visible" });
    const entries: DiagEntry[] = [];
    const h = startAudioDiagnostics({
      getContext: () => new FakeCtx(),
      engine: new FakeEngine(),
      append: (e) => entries.push(e),
      setInterval: () => 1,
      clearInterval: () => {},
      mediaDevices: md as unknown as MediaDevices,
      win,
      doc,
    });
    md.fire("devicechange");
    await new Promise((r) => setTimeout(r, 0));
    const d = entries.filter((e) => e.kind === "device");
    expect(d).toHaveLength(1);
    expect(d[0]!.audioOutputs).toBe(2);
    expect(JSON.stringify(d[0])).not.toMatch(/Speakers|abc|Headset/);

    win.fire("blur");
    win.fire("focus");
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    const w = entries.filter((e) => e.kind === "window");
    expect(w.map((e) => e.event)).toEqual(["blur", "focus", "visibility"]);
    expect(w[2]!.state).toBe("hidden");

    h.stop();
    expect(md.count()).toBe(0);
    expect(win.count()).toBe(0);
    expect(doc.count()).toBe(0);
  });
});

describe("createDiagnosticsSink — regroupement des envois IPC", () => {
  function sinkBench(opts: { sendThrows?: boolean; sendRejects?: boolean } = {}) {
    const sent: DiagEntry[][] = [];
    let timer: (() => void) | null = null;
    let delay = -1;
    const sink = createDiagnosticsSink({
      send: (batch) => {
        if (opts.sendThrows) throw new Error("ipc down");
        sent.push(batch);
        return opts.sendRejects ? Promise.reject(new Error("rejected")) : Promise.resolve();
      },
      setTimeout: (fn, ms) => {
        timer = fn;
        delay = ms;
        return 1;
      },
      clearTimeout: () => {
        timer = null;
      },
    });
    return {
      sink,
      sent,
      fireTimer: () => {
        const t = timer;
        timer = null;
        t?.();
      },
      hasTimer: () => timer !== null,
      delay: () => delay,
    };
  }
  const e = (kind: DiagEntry["kind"], extra: Record<string, unknown> = {}): DiagEntry => ({
    t: "2026-01-01T00:00:00.000Z",
    kind,
    ...extra,
  });

  it("regroupe les entrees et les envoie au plus toutes les 2 s", () => {
    const s = sinkBench();
    s.sink.append(e("engine"));
    s.sink.append(e("window"));
    expect(s.sent).toHaveLength(0);
    expect(s.delay()).toBe(2000);
    s.fireTimer();
    expect(s.sent).toEqual([[e("engine"), e("window")]]);
  });

  it("un glitch est envoye immediatement (avec ce qui attendait)", () => {
    const s = sinkBench();
    s.sink.append(e("engine"));
    s.sink.append(e("glitch", { lostMs: 30 }));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.map((x) => x.kind)).toEqual(["engine", "glitch"]);
    expect(s.hasTimer()).toBe(false);
  });

  it("decoupe en lots de 200 entrees au plus", () => {
    const s = sinkBench();
    for (let i = 0; i < 450; i++) s.sink.append(e("engine", { i }));
    s.fireTimer();
    expect(s.sent.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  it("stop() vide le tampon ; un envoi qui leve ou rejette n'est jamais propage", async () => {
    const s = sinkBench();
    s.sink.append(e("engine"));
    s.sink.stop();
    expect(s.sent).toHaveLength(1);
    const t = sinkBench({ sendThrows: true });
    expect(() => {
      t.sink.append(e("glitch"));
      t.sink.stop();
    }).not.toThrow();
    const r = sinkBench({ sendRejects: true });
    r.sink.append(e("glitch"));
    await new Promise((res) => setTimeout(res, 0)); // pas de rejet non gere
  });
});
