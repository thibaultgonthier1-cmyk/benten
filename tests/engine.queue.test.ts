import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";
import type { TrackRow } from "../src/shared/types";
import { nextStartTime } from "../src/renderer/audio/schedule";

/**
 * File d'attente + gapless + anti-clic — Web Audio mocke (environnement Node).
 *
 * `currentTime` est pilotable a la main. On compte les sources VIVANTES (demarrees et non
 * stoppees) pour prouver l'invariant n°1 : au plus UNE source vivante a tout instant, et
 * exactement une apres une rafale de `next()`. `gain` porte des espions de rampe pour verifier
 * le fondu anti-clic.
 */
class FakeNode {
  connectedTo: FakeNode | null = null;
  connect(dest: FakeNode): FakeNode {
    this.connectedTo = dest;
    return dest;
  }
  disconnect(): void {
    this.connectedTo = null;
  }
}
class FakeAudioParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  linearRampToValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
}
class FakeGain extends FakeNode {
  gain = new FakeAudioParam();
}
class FakeAnalyser extends FakeNode {}
class FakeBufferSource extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  startWhen?: number;
  startOffset?: number;
  stopWhen?: number;
  constructor(private readonly ctx: FakeAudioContext) {
    super();
  }
  start(when = 0, offset = 0): void {
    this.started = true;
    this.startWhen = when;
    this.startOffset = offset;
    this.ctx.sources.push(this);
  }
  stop(when?: number): void {
    this.stopped = true;
    this.stopWhen = when;
  }
}
class FakeAudioBuffer {
  constructor(
    public duration: number,
    public sampleRate = 44100,
    public numberOfChannels = 2,
  ) {}
  get length(): number {
    return Math.round(this.duration * this.sampleRate);
  }
}
class FakeAudioContext {
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = new FakeNode();
  sources: FakeBufferSource[] = [];
  createdSources = 0;
  resumeCount = 0;
  createGain(): FakeGain {
    return new FakeGain();
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createBufferSource(): FakeBufferSource {
    this.createdSources++;
    return new FakeBufferSource(this);
  }
  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = "running";
  }
  /** Sources vivantes = demarrees et non stoppees. L'invariant : <= 1 a tout instant. */
  liveSources(): FakeBufferSource[] {
    return this.sources.filter((s) => s.started && !s.stopped);
  }
}

const track = (over: Partial<TrackRow> = {}): TrackRow => ({
  id: 1,
  path: "C:\\music\\a.flac",
  title: "A",
  artist: "X",
  album: "Y",
  albumId: 1,
  trackNo: 1,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 24,
  playable: true,
  artKey: null,
  ...over,
});

/** Decodeur qui rend un AudioBuffer dont la duree vient du chemin encode `dur=<n>`. */
function makeDecoder(durations: Map<string, number>, onDecode?: (path: string) => void): Decoder {
  // decode() ne recoit que des octets ; on encode donc la duree via readBytes/path indirectement.
  // Ici on resout par ordre d'appel grace a une file, suffisant pour des pistes distinctes.
  return {
    canDecode: (p: string) => !p.endsWith(".xxx"),
    decode: async (bytes: ArrayBuffer): Promise<AudioBuffer> => {
      const path = decodePath(bytes);
      onDecode?.(path);
      const d = durations.get(path) ?? 100;
      return new FakeAudioBuffer(d) as unknown as AudioBuffer;
    },
  };
}

// readBytes encode le chemin dans les octets pour que le decodeur mocke retrouve la bonne duree.
const enc = new TextEncoder();
const dec = new TextDecoder();
const readBytes = async (path: string): Promise<ArrayBuffer> => {
  const u8 = enc.encode(path);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
};
function decodePath(bytes: ArrayBuffer): string {
  return dec.decode(bytes);
}

function makeEngine(ctx: FakeAudioContext, decoder: Decoder): AudioEngine {
  return new AudioEngine(ctx as unknown as AudioContext, decoder, readBytes);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("AudioEngine — file d'attente / gapless / anti-clic", () => {
  let ctx: FakeAudioContext;
  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it("setQueue charge la piste a l'index et expose son etat", async () => {
    const t0 = track({ id: 10, path: "C:\\m\\0.flac" });
    const t1 = track({ id: 11, path: "C:\\m\\1.flac" });
    const engine = makeEngine(ctx, makeDecoder(new Map([["C:\\m\\0.flac", 30]])));
    await engine.setQueue([t0, t1], 0);
    expect(engine.getState()).toMatchObject({ status: "ready", trackId: 10, durationSec: 30 });
    expect(engine.getQueueIndex()).toBe(0);
  });

  it("precharge la suivante seulement quand shouldPreload passe true", async () => {
    const decoded: string[] = [];
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const engine = makeEngine(
      ctx,
      makeDecoder(durs, (p) => decoded.push(p)),
    );
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      0,
    );
    decoded.length = 0; // oublie le decode de la piste courante
    engine.play();

    // Trop tot : reste 19 s (> lead 10) -> aucun prechargement.
    ctx.currentTime = 1;
    engine.tick();
    await flush();
    expect(decoded).not.toContain("C:\\m\\1.flac");

    // Dans la fenetre : reste 9 s (< lead 10) -> la suivante est decodee.
    ctx.currentTime = 11;
    engine.tick();
    await flush();
    expect(decoded).toContain("C:\\m\\1.flac");
  });

  it("programme la suivante EXACTEMENT a la fin de la courante (zero trou)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      0,
    );
    engine.play(); // demarre a currentTime=0, offset 0
    ctx.currentTime = 11; // reste 9 < 10
    engine.tick();
    await flush();

    expect(ctx.sources.length).toBe(2);
    const current = ctx.sources[0]!;
    const scheduled = ctx.sources[1]!;
    const prevStart = current.startWhen! - current.startOffset!; // 0
    const expected = nextStartTime(prevStart, 20); // 20
    expect(scheduled.startWhen).toBeCloseTo(expected, 10);
    // La jointure tombe pile a la fin de la courante : zero trou.
    expect(scheduled.startWhen).toBeCloseTo(current.startWhen! - current.startOffset! + 20, 10);
    expect(ctx.liveSources().length).toBe(2); // courante + programmee (demarrage futur)
  });

  it("fin naturelle -> promeut la source pre-decodee en lecture, sans nouveau decode ni trou", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const ended = vi.fn();
    const engine = makeEngine(ctx, makeDecoder(durs));
    engine.on("ended", ended);
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      0,
    );
    engine.play();
    ctx.currentTime = 11;
    engine.tick();
    await flush();
    expect(ctx.sources.length).toBe(2);
    const scheduled = ctx.sources[1]!;

    // La courante se termine naturellement a t=20.
    ctx.currentTime = 20;
    ctx.sources[0]!.onended?.();

    // Promotion : la piste 11 devient courante, PAS d'evenement 'ended', la source programmee vit.
    expect(ended).not.toHaveBeenCalled();
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 11, durationSec: 15 });
    expect(engine.getQueueIndex()).toBe(1);
    expect(scheduled.stopped).toBe(false);
    expect(ctx.liveSources().length).toBe(1); // la courante a fini, seule la promue vit
    expect(engine.getState().positionSec).toBeCloseTo(0, 5);
  });

  it("REVIEW FOCUS : 10 next() en rafale -> exactement UNE source vivante, aucune superposition", async () => {
    const durs = new Map<string, number>();
    const q: TrackRow[] = [];
    for (let i = 0; i < 12; i++) {
      const p = `C:\\m\\${i}.flac`;
      durs.set(p, 100 + i);
      q.push(track({ id: 100 + i, path: p }));
    }
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(q, 0);
    engine.play();
    expect(ctx.liveSources().length).toBe(1);

    // Rafale : 10 appels synchrones sans attendre (simulateur de martelage du bouton).
    for (let i = 0; i < 10; i++) void engine.next();
    await flush();
    await flush();

    // Invariant n°1 : au plus une source vivante ; toutes les precedentes stoppees.
    expect(ctx.liveSources().length).toBe(1);
    const live = ctx.liveSources()[0]!;
    expect(live.started).toBe(true);
    expect(live.stopped).toBe(false);
    // On a bien avance dans la file (derniere cible = index 10).
    expect(engine.getQueueIndex()).toBe(10);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 110 });
    // Fondu anti-clic : la rampe de gain a ete utilisee.
    const gain = (live.connectedTo as FakeGain).gain;
    expect(gain.linearRampToValueAtTime).toHaveBeenCalled();
  });

  it("next() applique un fondu anti-clic et stoppe la source precedente", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 50],
      ["C:\\m\\1.flac", 50],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      0,
    );
    engine.play();
    const first = ctx.sources[0]!;
    const gain = (first.connectedTo as FakeGain).gain;
    await engine.next();
    await flush();
    expect(first.stopped).toBe(true);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalled(); // rampe de gain = anti-clic
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 11 });
    expect(ctx.liveSources().length).toBe(1);
  });

  it("prev() dans les 3 premieres secondes redemarre la piste courante (seek 0)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 50],
      ["C:\\m\\1.flac", 50],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      1,
    );
    engine.play();
    ctx.currentTime = 2; // position 2 s (< 3) sur la piste d'index 1
    await engine.prev();
    await flush();
    // Reste sur la meme piste, redemarree au debut.
    expect(engine.getQueueIndex()).toBe(1);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 11 });
    expect(engine.getState().positionSec).toBeCloseTo(0, 1);
    expect(ctx.liveSources().length).toBe(1);
  });

  it("prev() au-dela de 3 s va a la piste precedente", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 50],
      ["C:\\m\\1.flac", 50],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      1,
    );
    engine.play();
    ctx.currentTime = 5; // position 5 s (> 3)
    await engine.prev();
    await flush();
    expect(engine.getQueueIndex()).toBe(0);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(ctx.liveSources().length).toBe(1);
  });

  it("une suivante non lisible n'est ni programmee ni bruitee, et est sautee a la fin naturelle", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\2.flac", 15],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    const unplayable = vi.fn();
    engine.on("unplayable", unplayable);
    await engine.setQueue(
      [
        track({ id: 10, path: "C:\\m\\0.flac" }),
        track({ id: 11, path: "C:\\m\\1.flac", playable: false }), // non lisible
        track({ id: 12, path: "C:\\m\\2.flac" }),
      ],
      0,
    );
    engine.play();
    ctx.currentTime = 15; // reste 5 < 10
    engine.tick();
    await flush();
    // Rien n'est programme pour la suivante non lisible : une seule source (la courante).
    expect(ctx.sources.length).toBe(1);
    expect(ctx.liveSources().length).toBe(1);

    // Fin naturelle de la courante -> saute la non lisible, passe a l'index 2.
    ctx.currentTime = 20;
    ctx.sources[0]!.onended?.();
    await flush();
    expect(engine.getQueueIndex()).toBe(2);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 12 });
    expect(ctx.liveSources().length).toBe(1);
  });

  it("pause annule la source programmee (pas de lecture fantome apres pause)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      0,
    );
    engine.play();
    ctx.currentTime = 11;
    engine.tick();
    await flush();
    expect(ctx.sources.length).toBe(2); // courante + programmee
    engine.pause();
    // La source programmee doit etre stoppee : aucune source vivante apres pause.
    expect(ctx.liveSources().length).toBe(0);
  });
});
