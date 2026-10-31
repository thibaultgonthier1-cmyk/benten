import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";
import type { TrackRow } from "../src/shared/types";
import { nextStartTime } from "../src/renderer/audio/schedule";
import { buildOrder } from "../src/renderer/audio/order";

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
  albumArtist: null,
  albumId: 1,
  trackNo: 1,
  discNo: null,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 24,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  addedAtMs: null,
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
    expect(engine.getState().queueIndex).toBe(0);
  });

  it("getState().queueIndex refflete l'index courant (ready, promotion gapless, switchTo)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
      ["C:\\m\\2.flac", 12],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [
        track({ id: 10, path: "C:\\m\\0.flac" }),
        track({ id: 11, path: "C:\\m\\1.flac" }),
        track({ id: 12, path: "C:\\m\\2.flac" }),
      ],
      1,
    );
    // Au chargement, l'index courant (1) est expose directement par getState().
    expect(engine.getState().queueIndex).toBe(1);

    engine.play();
    ctx.currentTime = 7; // sur t11 (dur 15), reste 8 < lead 10 -> programme la suivante (t12)
    engine.tick();
    await flush();

    // Promotion gapless : l'index courant devient 2, reflete DIRECTEMENT dans getState().queueIndex.
    ctx.currentTime = 15;
    ctx.sources[0]!.onended?.();
    expect(engine.getState().queueIndex).toBe(2);
    expect(engine.getState().trackId).toBe(12);

    // Saut manuel (switchTo) : l'index suit aussi.
    await engine.jumpTo(0);
    await flush();
    expect(engine.getState().queueIndex).toBe(0);
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
    // La source entre dans son propre gain, puis dans le gain anti-clic (les rampes vivent là).
    const gain = (live.connectedTo as unknown as { connectedTo: FakeGain }).connectedTo.gain;
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
    const gain = (first.connectedTo as unknown as { connectedTo: FakeGain }).connectedTo.gain;
    await engine.next();
    await flush();
    expect(first.stopped).toBe(true);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalled(); // rampe de gain = anti-clic
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 11 });
    expect(ctx.liveSources().length).toBe(1);
  });

  it("prev() dans les 3 premieres secondes va a la piste precedente", async () => {
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
    // Debut de piste : on recule vers la piste precedente.
    expect(engine.getQueueIndex()).toBe(0);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(ctx.liveSources().length).toBe(1);
  });

  it("prev() au-dela de 3 s redemarre la piste courante (seek 0)", async () => {
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
    // Bien engage dans la piste : on redemarre au debut sans changer de piste.
    expect(engine.getQueueIndex()).toBe(1);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 11 });
    expect(engine.getState().positionSec).toBeCloseTo(0, 1);
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

/**
 * `updateQueue` A CHAUD (Task 11) — mutation de file SANS couper le son.
 *
 * Invariant sacre : si l'id de la piste courante reste present, sa source (`AudioBufferSourceNode`)
 * N'EST NI stoppee NI recreee NI re-decodee (meme instance, meme `startedAtCtxTime`). On ne retouche
 * la source PROGRAMMEE (gapless) que si la piste SUIVANTE a reellement change ; sinon on la laisse
 * telle quelle (aucun re-decodage, aucun trou). Retirer la piste courante bascule proprement sur la
 * plus proche lisible (semantique `switchTo`, anti-clic). On ne laisse jamais > 1 source AUDIBLE.
 */
describe("AudioEngine — updateQueue a chaud (Task 11)", () => {
  let ctx: FakeAudioContext;
  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it("change seulement la SUIVANTE : source courante intacte, programmee obsolete annulee puis reprogrammee", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
      ["C:\\m\\2.flac", 12],
    ]);
    const decoded: string[] = [];
    const engine = makeEngine(ctx, makeDecoder(durs, (p) => decoded.push(p)));
    const A = track({ id: 10, path: "C:\\m\\0.flac" });
    const B = track({ id: 11, path: "C:\\m\\1.flac" });
    const C = track({ id: 12, path: "C:\\m\\2.flac" });
    await engine.setQueue([A, B, C], 0);
    engine.play();
    ctx.currentTime = 11; // reste 9 < 10 -> programme la suivante B
    engine.tick();
    await flush();
    expect(ctx.sources.length).toBe(2);
    const curSource = ctx.sources[0]!;
    const schedB = ctx.sources[1]!;
    expect(schedB.buffer!.duration).toBe(15); // B programmee
    decoded.length = 0;

    // Reordonne : la SUIVANTE devient C (id 12) au lieu de B.
    engine.updateQueue([A, C, B], { keepCurrent: true });
    await flush();

    // Source COURANTE intacte : meme instance, non stoppee, NON re-decodee.
    expect(ctx.sources[0]).toBe(curSource);
    expect(curSource.stopped).toBe(false);
    expect(curSource.started).toBe(true);
    expect(decoded).not.toContain("C:\\m\\0.flac");
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(engine.getQueueIndex()).toBe(0);

    // Ancienne programmee B annulee ; nouvelle programmee C en vol.
    expect(schedB.stopped).toBe(true);
    expect(ctx.sources.length).toBe(3);
    const schedC = ctx.sources[2]!;
    expect(schedC.buffer!.duration).toBe(12);
    expect(schedC.started).toBe(true);
    expect(schedC.stopped).toBe(false);
    // Une courante (audible) + une programmee (demarrage futur).
    expect(ctx.liveSources().length).toBe(2);
  });

  it("REVIEW FOCUS : reordonner deux pistes FUTURES ne touche ni la courante ni la suivante programmee", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
      ["C:\\m\\2.flac", 12],
      ["C:\\m\\3.flac", 11],
    ]);
    const decoded: string[] = [];
    const engine = makeEngine(ctx, makeDecoder(durs, (p) => decoded.push(p)));
    const A = track({ id: 10, path: "C:\\m\\0.flac" });
    const B = track({ id: 11, path: "C:\\m\\1.flac" });
    const C = track({ id: 12, path: "C:\\m\\2.flac" });
    const D = track({ id: 13, path: "C:\\m\\3.flac" });
    await engine.setQueue([A, B, C, D], 0);
    engine.play();
    ctx.currentTime = 11;
    engine.tick();
    await flush();
    const curSource = ctx.sources[0]!;
    const schedB = ctx.sources[1]!;
    expect(schedB.buffer!.duration).toBe(15);
    const createdBefore = ctx.createdSources;
    decoded.length = 0;

    // Echange C et D (toutes deux FUTURES, apres la suivante B). La suivante reste B.
    engine.updateQueue([A, B, D, C], { keepCurrent: true });
    await flush();

    // Courante ET suivante programmee intactes : memes instances, rien de stoppe, rien re-decode.
    expect(ctx.sources[0]).toBe(curSource);
    expect(curSource.stopped).toBe(false);
    expect(ctx.sources[1]).toBe(schedB);
    expect(schedB.stopped).toBe(false);
    expect(ctx.createdSources).toBe(createdBefore); // aucune nouvelle source
    expect(decoded).toEqual([]); // aucun re-decodage
    expect(ctx.liveSources().length).toBe(2);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(engine.getQueueIndex()).toBe(0);
  });

  it("retirer la piste COURANTE bascule sur la plus proche lisible (exactement une source vivante)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
      ["C:\\m\\2.flac", 12],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    const A = track({ id: 10, path: "C:\\m\\0.flac" });
    const B = track({ id: 11, path: "C:\\m\\1.flac" });
    const C = track({ id: 12, path: "C:\\m\\2.flac" });
    await engine.setQueue([A, B, C], 0);
    engine.play();
    const aSource = ctx.sources[0]!;

    // Retire la piste courante A : la file devient [B, C].
    engine.updateQueue([B, C], { keepCurrent: true });
    await flush();
    await flush();

    expect(aSource.stopped).toBe(true); // ancienne courante coupee (anti-clic)
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 11 });
    expect(engine.getQueueIndex()).toBe(0);
    expect(ctx.liveSources().length).toBe(1);
  });

  it("file vide : coupe le son proprement (idle, aucune source vivante)", async () => {
    const durs = new Map([["C:\\m\\0.flac", 20]]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue([track({ id: 10, path: "C:\\m\\0.flac" })], 0);
    engine.play();
    engine.updateQueue([], { keepCurrent: true });
    await flush();
    expect(ctx.liveSources().length).toBe(0);
    expect(engine.getState()).toMatchObject({ status: "idle", trackId: null });
  });

  it("jumpTo saute a l'index via le chemin anti-clic manuel (une source vivante)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 30],
      ["C:\\m\\1.flac", 25],
      ["C:\\m\\2.flac", 20],
    ]);
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(
      [
        track({ id: 10, path: "C:\\m\\0.flac" }),
        track({ id: 11, path: "C:\\m\\1.flac" }),
        track({ id: 12, path: "C:\\m\\2.flac" }),
      ],
      0,
    );
    engine.play();
    const first = ctx.sources[0]!;
    const gain = (first.connectedTo as unknown as { connectedTo: FakeGain }).connectedTo.gain;
    await engine.jumpTo(2);
    await flush();
    expect(first.stopped).toBe(true);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalled(); // fondu anti-clic
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 12 });
    expect(engine.getQueueIndex()).toBe(2);
    expect(ctx.liveSources().length).toBe(1);
  });
});

/**
 * Shuffle & repeat (Task 12) — le MEME chemin gapless (scheduleNext/promoteScheduled), rien de
 * parallele. On prouve : repeat:"all" boucle de la DERNIERE vers la PREMIERE via la source
 * programmee ; repeat:"one" reprogramme+promeut la MEME piste (loop sans trou) ; shuffle fait
 * suivre l'enchainement a `order` sans jamais couper la courante au toggle ; une piste non lisible
 * reste sautee silencieusement meme sous une rafale de `next()`, avec UNE seule source vivante.
 */
describe("AudioEngine — shuffle & repeat (Task 12)", () => {
  let ctx: FakeAudioContext;
  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it("repeat:all — la fin de la DERNIERE piste promeut la PREMIERE (gapless via scheduled)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const ended = vi.fn();
    const engine = makeEngine(ctx, makeDecoder(durs));
    engine.on("ended", ended);
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      1, // demarre sur la DERNIERE piste
    );
    engine.setRepeatMode("all");
    engine.play();
    ctx.currentTime = 11; // sur t11 (dur 15), reste 4 < lead 10
    engine.tick();
    await flush();

    // La PREMIERE piste (t10, dur 20) est programmee pour s'enchainer apres la derniere.
    expect(ctx.sources.length).toBe(2);
    const scheduled = ctx.sources[1]!;
    expect(scheduled.buffer!.duration).toBe(20);

    // Fin naturelle de la derniere -> promotion de la premiere (PAS d'evenement ended).
    ctx.currentTime = 15;
    ctx.sources[0]!.onended?.();
    expect(ended).not.toHaveBeenCalled();
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(engine.getQueueIndex()).toBe(0);
    expect(scheduled.stopped).toBe(false); // la source promue vit
    expect(ctx.liveSources().length).toBe(1);
    expect(engine.getState().positionSec).toBeCloseTo(0, 5);
  });

  it("repeat:off — la fin de la DERNIERE piste termine (aucune boucle)", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const ended = vi.fn();
    const engine = makeEngine(ctx, makeDecoder(durs));
    engine.on("ended", ended);
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      1,
    );
    engine.play();
    ctx.currentTime = 11;
    engine.tick();
    await flush();
    expect(ctx.sources.length).toBe(1); // rien de programme en fin de file (off)
    ctx.currentTime = 15;
    ctx.sources[0]!.onended?.();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(engine.getState().status).toBe("ended");
  });

  it("repeat:one — la fin reprogramme+promeut la MEME piste (loop sans trou)", async () => {
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
    engine.setRepeatMode("one");
    engine.play();
    ctx.currentTime = 11; // sur t10 (dur 20), reste 9 < 10
    engine.tick();
    await flush();

    // La MEME piste (t10, dur 20) est programmee comme suivante.
    expect(ctx.sources.length).toBe(2);
    const scheduled = ctx.sources[1]!;
    expect(scheduled.buffer!.duration).toBe(20);

    ctx.currentTime = 20;
    ctx.sources[0]!.onended?.();
    expect(ended).not.toHaveBeenCalled();
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 }); // meme piste
    expect(engine.getQueueIndex()).toBe(0);
    expect(scheduled.stopped).toBe(false);
    expect(ctx.liveSources().length).toBe(1);
    expect(engine.getState().positionSec).toBeCloseTo(0, 5);
  });

  it("repeat:one — reutilise le buffer courant (aucun readBytes/decode au bouclage), gapless preserve", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 20],
      ["C:\\m\\1.flac", 15],
    ]);
    const decoded: string[] = [];
    let reads = 0;
    // readBytes instrumente : on compte les relectures disque pour prouver la reutilisation.
    const countingRead = async (path: string): Promise<ArrayBuffer> => {
      reads++;
      return readBytes(path);
    };
    const engine = new AudioEngine(
      ctx as unknown as AudioContext,
      makeDecoder(durs, (p) => decoded.push(p)),
      countingRead,
    );
    await engine.setQueue(
      [track({ id: 10, path: "C:\\m\\0.flac" }), track({ id: 11, path: "C:\\m\\1.flac" })],
      0,
    );
    engine.setRepeatMode("one");
    engine.play();
    // La charge initiale a lu+decode UNE fois ; on remet les compteurs a zero pour isoler le bouclage.
    expect(reads).toBe(1);
    expect(decoded).toEqual(["C:\\m\\0.flac"]);
    reads = 0;
    decoded.length = 0;

    // 1er bouclage : la MEME piste est programmee comme suivante SANS relire ni redecoder.
    ctx.currentTime = 11; // sur t10 (dur 20), reste 9 < 10
    engine.tick();
    await flush();
    expect(reads).toBe(0);
    expect(decoded).toEqual([]);
    expect(ctx.sources.length).toBe(2);
    const scheduled1 = ctx.sources[1]!;
    expect(scheduled1.buffer!.duration).toBe(20); // meme piste : buffer courant reutilise
    expect(ctx.liveSources().length).toBe(2);

    // Fin naturelle -> promotion gapless de la meme piste (pas d'evenement ended).
    ctx.currentTime = 20;
    ctx.sources[0]!.onended?.();
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(engine.getQueueIndex()).toBe(0);
    expect(scheduled1.stopped).toBe(false); // source promue vivante
    expect(ctx.liveSources().length).toBe(1);
    expect(engine.getState().positionSec).toBeCloseTo(0, 5);

    // 2e bouclage : toujours aucune relecture/redecodage, la source promue sert de buffer reutilise.
    ctx.currentTime = 31; // demarree a 20, offset 0 -> position 11, reste 9 < 10
    engine.tick();
    await flush();
    expect(reads).toBe(0);
    expect(decoded).toEqual([]);
    expect(ctx.sources.length).toBe(3);
    const scheduled2 = ctx.sources[2]!;
    expect(scheduled2.buffer!.duration).toBe(20);

    ctx.currentTime = 40;
    ctx.sources[1]!.onended?.();
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });
    expect(engine.getQueueIndex()).toBe(0);
    expect(ctx.liveSources().length).toBe(1);
  });

  it("shuffle — l'enchainement suit `order` ; la courante est preservee au toggle (aucune coupure)", async () => {
    const q: TrackRow[] = [];
    const durs = new Map<string, number>();
    for (let i = 0; i < 4; i++) {
      const p = `C:\\m\\${i}.flac`;
      durs.set(p, 20 + i);
      q.push(track({ id: 10 + i, path: p }));
    }
    const engine = makeEngine(ctx, makeDecoder(durs));
    await engine.setQueue(q, 0);
    engine.play();
    const firstSource = ctx.sources[0]!;

    // Active le shuffle avec une graine fixe (deterministe) : la courante (id 10) reste en tete.
    engine.setShuffle(true, 777);
    const expected = buildOrder(4, { shuffle: true, seed: 777, current: 0 });
    expect(engine.getOrder()).toEqual(expected);
    expect(engine.getOrderPos()).toBe(0);
    expect(expected[0]).toBe(0);
    // Toggle shuffle ne coupe PAS la source courante : meme instance, non stoppee, meme piste.
    expect(ctx.sources[0]).toBe(firstSource);
    expect(firstSource.stopped).toBe(false);
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 10 });

    // Pres de la fin de la courante : programme la SUIVANTE DE L'ORDRE (= order[1]).
    const curDur = 20; // t10
    ctx.currentTime = curDur - 4; // reste 4 < 10
    engine.tick();
    await flush();
    const scheduled = ctx.sources.find((s) => s !== firstSource && s.started)!;
    const nextQi = expected[1]!;
    expect(scheduled.buffer!.duration).toBe(durs.get(`C:\\m\\${nextQi}.flac`));

    // Fin naturelle -> promotion de order[1].
    ctx.currentTime = curDur;
    firstSource.onended?.();
    expect(engine.getState().trackId).toBe(q[nextQi]!.id);
    expect(engine.getOrderPos()).toBe(1);
    expect(ctx.liveSources().length).toBe(1);

    // Desactiver le shuffle restaure l'ordre identite, orderPos sur l'index naturel courant.
    engine.setShuffle(false);
    expect(engine.getOrder()).toEqual([0, 1, 2, 3]);
    expect(engine.getOrderPos()).toBe(nextQi);
  });

  it("REVIEW FOCUS — un .m4p au milieu + rafale next() : saut silencieux, UNE source vivante, bornes correctes", async () => {
    const durs = new Map([
      ["C:\\m\\0.flac", 100],
      ["C:\\m\\2.flac", 100],
      ["C:\\m\\3.flac", 100],
    ]);
    const unplayable = vi.fn();
    const engine = makeEngine(ctx, makeDecoder(durs));
    engine.on("unplayable", unplayable);
    await engine.setQueue(
      [
        track({ id: 10, path: "C:\\m\\0.flac" }),
        track({ id: 11, path: "C:\\m\\1.m4p", playable: false }), // non lisible, au milieu
        track({ id: 12, path: "C:\\m\\2.flac" }),
        track({ id: 13, path: "C:\\m\\3.flac" }),
      ],
      0,
    );
    engine.play();
    expect(ctx.liveSources().length).toBe(1);

    // Rafale de 5 next() : saute le .m4p (idx1), avance 0 -> 2 -> 3, puis bute sur la fin (off).
    for (let i = 0; i < 5; i++) void engine.next();
    await flush();
    await flush();

    expect(ctx.liveSources().length).toBe(1); // invariant n°1 : une seule source vivante
    const live = ctx.liveSources()[0]!;
    expect(live.stopped).toBe(false);
    expect(engine.getQueueIndex()).toBe(3); // borne de fin atteinte, pas de depassement
    expect(engine.getState()).toMatchObject({ status: "playing", trackId: 13 });
    expect(engine.getState().trackId).not.toBe(11); // jamais la piste non lisible
    expect(unplayable).not.toHaveBeenCalled(); // sautee sans jamais tenter de la jouer
  });
});


