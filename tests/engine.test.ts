import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine, qualitySampleRate } from "../src/renderer/audio/engine";
import type { Decoder } from "../src/renderer/audio/decoder";
import type { TrackRow } from "../src/shared/types";

/**
 * Web Audio mocke (environnement Node, aucun vrai AudioContext).
 * `currentTime` est pilotable : on l'avance a la main pour simuler l'ecoulement du temps.
 * On compte les BufferSource crees pour prouver qu'un track en erreur n'en cree aucun.
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
/**
 * Parametre de gain mocke : enregistre les rampes planifiees (anti-clic) pour les tests, et tient
 * `.value` a jour sur `setValueAtTime`/`linearRampToValueAtTime` (le moteur emprunte alors le chemin
 * AudioParam reel au lieu du repli `value =`).
 */
class FakeGainParam {
  value = 1;
  ramps: { to: number; at: number }[] = [];
  cancelScheduledValues(_at: number): void {}
  setValueAtTime(v: number, _at: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number, at: number): void {
    this.ramps.push({ to: v, at });
    this.value = v;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeGainParam();
}
class FakeAnalyser extends FakeNode {}
class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
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
/** Filtre passe-bande/biquad simulé : les tests vérifient type, fréquence et gain de chaque bande. */
class FakeBiquadFilter extends FakeNode {
  type = "peaking";
  frequency = { value: 1000 };
  Q = { value: 1 };
  gain = new FakeGainParam();
}
class FakeAudioContext {
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = new FakeNode();
  sources: FakeBufferSource[] = [];
  createdSources = 0;
  gainCount = 0;
  analyserCount = 0;
  resumeCount = 0;
  decodeImpl: (b: ArrayBuffer) => Promise<FakeAudioBuffer> = async () => new FakeAudioBuffer(1);
  createGain(): FakeGain {
    this.gainCount++;
    return new FakeGain();
  }
  createAnalyser(): FakeAnalyser {
    this.analyserCount++;
    return new FakeAnalyser();
  }
  eqFilters: FakeBiquadFilter[] = [];
  createBiquadFilter(): FakeBiquadFilter {
    const filter = new FakeBiquadFilter();
    this.eqFilters.push(filter);
    return filter;
  }
  createBufferSource(): FakeBufferSource {
    this.createdSources++;
    return new FakeBufferSource(this);
  }
  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = "running";
  }
  decodeAudioData(b: ArrayBuffer): Promise<FakeAudioBuffer> {
    return this.decodeImpl(b);
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

const okDecoder = (buffer: FakeAudioBuffer, spy?: () => void): Decoder => ({
  canDecode: () => true,
  decode: async () => {
    spy?.();
    return buffer as unknown as AudioBuffer;
  },
});
const rejectingDecoder = (spy?: () => void): Decoder => ({
  canDecode: () => true,
  decode: async () => {
    spy?.();
    throw new Error("decode failed");
  },
});
const unsupportedDecoder = (spy?: () => void): Decoder => ({
  canDecode: () => false,
  decode: async () => {
    spy?.();
    throw new Error("must not be called");
  },
});

const readBytes = async (): Promise<ArrayBuffer> => new ArrayBuffer(8);

function makeEngine(ctx: FakeAudioContext, decoder: Decoder): AudioEngine {
  return new AudioEngine(ctx as unknown as AudioContext, decoder, readBytes);
}

describe("AudioEngine", () => {
  let ctx: FakeAudioContext;
  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it("load puis play -> status 'playing', durationSec issu de l'AudioBuffer", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(173)));
    await engine.load(track({ id: 7, durationSec: 999 }));
    expect(engine.getState()).toMatchObject({ status: "ready", durationSec: 173, trackId: 7 });

    engine.play();
    const s = engine.getState();
    expect(s.status).toBe("playing");
    expect(s.durationSec).toBe(173); // vient de l'AudioBuffer decode, pas des tags
    expect(ctx.resumeCount).toBeGreaterThan(0);
  });

  it("cable le graphe source -> gain -> analyser -> volumeGain -> destination (noeuds reutilises)", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    await engine.load(track());
    engine.play();
    expect(ctx.createdSources).toBe(1);
    // Trois GainNode : `gain` (anti-clic), `volumeGain` (volume utilisateur), et le gain PROPRE à
    // la source — celui qu'on abaisse pendant un fondu. Il existe toujours, même fondu coupé :
    // sinon l'activer en cours de lecture ne pourrait plus baisser la piste en cours.
    expect(ctx.gainCount).toBe(3);
    expect(ctx.analyserCount).toBe(1);
    const src = ctx.sources[0]!;
    // La source entre dans SON gain, qui entre dans le gain anti-clic, puis l'analyseur.
    const sourceGain = src.connectedTo as FakeGain;
    expect(sourceGain).toBeInstanceOf(FakeGain);
    const gain = sourceGain.connectedTo as FakeGain;
    expect(gain).toBeInstanceOf(FakeGain);
    const analyser = gain.connectedTo as FakeAnalyser;
    expect(analyser).toBeInstanceOf(FakeAnalyser);
    const volume = analyser.connectedTo as FakeGain;
    expect(volume).toBeInstanceOf(FakeGain);

    // T17B : entre le volume et la destination, dix filtres chaînés (égaliseur). Aucun chemin
    // parallèle — sinon le signal non égalisé reviendrait et doublerait le son.
    expect(ctx.eqFilters).toHaveLength(10);
    expect(volume.connectedTo).toBe(ctx.eqFilters[0]);
    for (let i = 0; i < ctx.eqFilters.length - 1; i += 1) {
      expect(ctx.eqFilters[i]!.connectedTo).toBe(ctx.eqFilters[i + 1]);
    }
    expect(ctx.eqFilters[9]!.connectedTo).toBe(ctx.destination);
  });

  it("l'égaliseur borne les gains à ±12 dB et laisse le nœud anti-clic intact", () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(10)));
    engine.setEqGains([6, -3, 99, -99, 0, 0, 0, 0, 0, 0]);
    const gains = engine.getEqGains();
    expect(gains[0]).toBe(6);
    expect(gains[1]).toBe(-3);
    expect(gains[2]).toBe(12);
    expect(gains[3]).toBe(-12);
    const antiClick = (engine as unknown as { gain: FakeGain }).gain;
    expect(antiClick.gain.ramps).toHaveLength(0);
    expect(antiClick.gain.value).toBe(1);
  });

  it("la position derive de currentTime puis se fige au pause", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    ctx.currentTime = 100; // le temps a deja avance avant play
    engine.play();
    ctx.currentTime = 105;
    expect(engine.getState().positionSec).toBeCloseTo(5, 5);

    engine.pause();
    expect(engine.getState().status).toBe("paused");
    ctx.currentTime = 999; // le temps continue, la position reste figee
    expect(engine.getState().positionSec).toBeCloseTo(5, 5);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it("reprend depuis la position figee apres pause (nouvelle source au bon offset)", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    engine.play();
    ctx.currentTime = 12;
    engine.pause();
    expect(engine.getState().positionSec).toBeCloseTo(12, 5);
    engine.play();
    expect(ctx.createdSources).toBe(2);
    expect(ctx.sources[1]!.startOffset).toBeCloseTo(12, 5);
    ctx.currentTime = 15;
    expect(engine.getState().positionSec).toBeCloseTo(15, 5);
  });

  it("seek(30) -> position = 30, et avance ensuite depuis 30 en lecture", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    engine.play();
    ctx.currentTime = 10;
    engine.seek(30);
    expect(engine.getState().positionSec).toBe(30);
    expect(engine.getState().status).toBe("playing");
    ctx.currentTime = 12;
    expect(engine.getState().positionSec).toBeCloseTo(32, 5);
  });

  it("seek a l'arret fige la position sans demarrer de source", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
    await engine.load(track());
    engine.seek(42);
    expect(ctx.createdSources).toBe(0);
    expect(engine.getState().positionSec).toBe(42);
    engine.play();
    expect(ctx.sources[0]!.startOffset).toBeCloseTo(42, 5);
  });

  it("borne la position a la duree", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(50)));
    await engine.load(track());
    engine.play();
    ctx.currentTime = 10_000;
    expect(engine.getState().positionSec).toBe(50);
    engine.seek(10_000);
    expect(engine.getState().positionSec).toBe(50);
    engine.seek(-5);
    expect(engine.getState().positionSec).toBe(0);
  });

  it("emet 'ended' et passe en 'ended' quand la source se termine naturellement", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    const ended = vi.fn();
    engine.on("ended", ended);
    await engine.load(track({ id: 9 }));
    engine.play();
    ctx.sources[0]!.onended?.();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]![0]).toMatchObject({ trackId: 9 });
    expect(engine.getState().status).toBe("ended");
    expect(engine.getState().positionSec).toBe(100);
  });

  it("un stop volontaire (pause) ne declenche pas l'evenement 'ended'", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    const ended = vi.fn();
    engine.on("ended", ended);
    await engine.load(track());
    engine.play();
    const src = ctx.sources[0]!;
    engine.pause();
    src.onended?.(); // le vrai Web Audio appelle onended apres stop()
    expect(ended).not.toHaveBeenCalled();
  });

  describe("fichier non lisible", () => {
    it("track.playable === false -> status 'error', evenement 'unplayable', decode jamais appele", async () => {
      const decodeSpy = vi.fn();
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100), decodeSpy));
      const unplayable = vi.fn();
      engine.on("unplayable", unplayable);

      await expect(engine.load(track({ id: 3, playable: false }))).resolves.toBeUndefined();

      expect(engine.getState()).toMatchObject({ status: "error", trackId: 3 });
      expect(unplayable).toHaveBeenCalledTimes(1);
      expect(unplayable.mock.calls[0]![0]).toMatchObject({ trackId: 3 });
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(ctx.createdSources).toBe(0);

      engine.play(); // ne doit produire aucun son
      expect(ctx.createdSources).toBe(0);
      expect(engine.getState().status).toBe("error");
    });

    it("decodeur qui rejette -> status 'error', 'unplayable', aucune exception, play() sans source", async () => {
      const engine = makeEngine(ctx, rejectingDecoder());
      const unplayable = vi.fn();
      engine.on("unplayable", unplayable);

      await expect(engine.load(track())).resolves.toBeUndefined();

      expect(engine.getState().status).toBe("error");
      expect(unplayable).toHaveBeenCalledTimes(1);
      expect(ctx.createdSources).toBe(0);

      engine.play();
      expect(ctx.createdSources).toBe(0);
      expect(engine.getState().status).toBe("error");
    });

    it("decodeur qui refuse le format (canDecode=false) -> 'error' + 'unplayable', decode jamais appele", async () => {
      const decodeSpy = vi.fn();
      const engine = makeEngine(ctx, unsupportedDecoder(decodeSpy));
      const unplayable = vi.fn();
      engine.on("unplayable", unplayable);

      await expect(engine.load(track({ path: "C:\\music\\drm.m4p" }))).resolves.toBeUndefined();

      expect(engine.getState().status).toBe("error");
      expect(unplayable).toHaveBeenCalledTimes(1);
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(ctx.createdSources).toBe(0);
    });
  });

  it("on() renvoie une fonction de desabonnement", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(10)));
    const cb = vi.fn();
    const off = engine.on("unplayable", cb);
    off();
    await engine.load(track({ playable: false }));
    expect(cb).not.toHaveBeenCalled();
  });

  it("play() en cours de lecture est idempotent (pas de source en double)", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    await engine.load(track());
    engine.play();
    engine.play();
    expect(ctx.createdSources).toBe(1);
  });

  it("charger un nouveau track remplace l'etat et stoppe la source precedente", async () => {
    const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
    await engine.load(track({ id: 1 }));
    engine.play();
    const first = ctx.sources[0]!;
    await engine.load(track({ id: 2, durationSec: 50 }));
    expect(first.stopped).toBe(true);
    expect(engine.getState()).toMatchObject({ status: "ready", trackId: 2, positionSec: 0 });
  });

  // === Task 13 : volume, qualite, recreation de contexte =====================================

  describe("qualitySampleRate (pur)", () => {
    it("economy -> 44100 quelle que soit la sortie", () => {
      expect(qualitySampleRate("economy", 48000)).toBe(44100);
      expect(qualitySampleRate("economy", 96000)).toBe(44100);
      expect(qualitySampleRate("economy", undefined)).toBe(44100);
    });
    it("max / balanced suivent la frequence de la sortie", () => {
      expect(qualitySampleRate("max", 96000)).toBe(96000);
      expect(qualitySampleRate("max", 44100)).toBe(44100);
      expect(qualitySampleRate("balanced", 48000)).toBe(48000);
    });
    it("max / balanced retombent sur 48000 quand la sortie est inconnue ou aberrante", () => {
      expect(qualitySampleRate("balanced", undefined)).toBe(48000);
      expect(qualitySampleRate("max", undefined)).toBe(48000);
      expect(qualitySampleRate("max", 0)).toBe(48000);
      expect(qualitySampleRate("balanced", -1)).toBe(48000);
      expect(qualitySampleRate("max", Number.NaN)).toBe(48000);
    });
  });

  describe("setVolume", () => {
    it("regle le gain de volume dedie (≈0.5) independamment des fondus anti-clic", async () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      await engine.setQueue([track({ id: 1 }), track({ id: 2 })], 0);
      engine.play();
      engine.setVolume(0.5);
      expect(engine.getVolume()).toBeCloseTo(0.5, 5);

      // Un changement manuel de piste declenche un fondu anti-clic sur `gain` : il ne doit PAS
      // ecraser le volume (noeud dedie). Le volume reste a 0.5.
      await engine.next();
      expect(engine.getVolume()).toBeCloseTo(0.5, 5);
    });

    it("rampVolume programme une rampe sur le noeud de volume uniquement", () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      const volumeNode = (engine as unknown as { volumeGain: FakeGain }).volumeGain;
      const antiClick = (engine as unknown as { gain: FakeGain }).gain;
      volumeNode.gain.ramps.length = 0;
      antiClick.gain.ramps.length = 0;

      engine.rampVolume(0.2, 8);

      // Une seule rampe, sur `volumeGain`, vers la cible.
      expect(volumeNode.gain.ramps).toHaveLength(1);
      expect(volumeNode.gain.ramps[0]!.to).toBeCloseTo(0.2, 5);
      // Le nœud des fondus anti-clic n'est pas touché.
      expect(antiClick.gain.ramps).toHaveLength(0);
      // La valeur mémorisée suit la cible (pas de saut au réglage suivant).
      expect(engine.getVolume()).toBeCloseTo(0.2, 5);
    });
    it("borne le volume dans [0,1]", () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      engine.setVolume(2);
      expect(engine.getVolume()).toBe(1);
      engine.setVolume(-1);
      expect(engine.getVolume()).toBe(0);
    });
  });

  describe("fondu enchainé (T-17 fondu)", () => {
    it("à 0 : la suivante démarre exactement à la fin (gapless inchangé)", () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      expect(engine.getCrossfade()).toBe(0);
    });

    it("accepte une durée, la borne, et revient à 0", () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      engine.setCrossfade(6);
      expect(engine.getCrossfade()).toBe(6);
      engine.setCrossfade(60);
      expect(engine.getCrossfade()).toBe(12);
      engine.setCrossfade(0);
      expect(engine.getCrossfade()).toBe(0);
    });

    it("ne crée aucun gain supplémentaire quand le fondu est désactivé", async () => {
      const local = new FakeAudioContext();
      const engine = makeEngine(local, okDecoder(new FakeAudioBuffer(20)));
      await engine.setQueue([track({ id: 1 }), track({ id: 2 })], 0);
      engine.play();
      // `gain` + `volumeGain`, créés au constructeur : le gapless n''en ajoute aucun.
      expect(local.gainCount).toBe(3);

      // Fondu actif : chaque source reçoit son gain dédié, donc le compte monte.
      engine.setCrossfade(6);
      await engine.next();
      expect(local.gainCount).toBeGreaterThan(2);
    });
  });

  describe("rebuildContext (contextes mockes)", () => {
    it("conserve trackId et se repositionne EN PAUSE a la position memorisee", async () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
      await engine.load(track({ id: 42, durationSec: 200 }));
      engine.play();
      ctx.currentTime = 37;
      expect(engine.getState().positionSec).toBeCloseTo(37, 5);

      const ctx2 = new FakeAudioContext();
      const dec2 = okDecoder(new FakeAudioBuffer(200));
      await engine.rebuildContext(ctx2 as unknown as AudioContext, dec2);

      const s = engine.getState();
      expect(s.trackId).toBe(42); // piste conservee
      expect(s.status).toBe("paused"); // JAMAIS en lecture (pas de clic)
      expect(s.positionSec).toBeCloseTo(37, 5); // repositionne a la position d'avant
      // Le graphe est reconstruit sur le NOUVEAU contexte (un seul contexte vivant a la fois).
      // Aucune source n'est encore créée : seulement `gain` + `volumeGain` sur le nouveau contexte.
      expect(ctx2.gainCount).toBe(2);
      expect(ctx2.analyserCount).toBe(1);
    });

    it("EN LECTURE, rampe le gain vers ~0 (anti-clic) PUIS stoppe, et finit en pause", async () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(200)));
      await engine.load(track({ id: 42, durationSec: 200 }));
      engine.play();
      ctx.currentTime = 37;
      const oldSource = ctx.sources[0]!;
      // La source entre dans son gain, qui entre dans le gain partagé : les fondus anti-clic
      // vivent sur CE dernier.
      const oldGain = (oldSource.connectedTo as unknown as { connectedTo: FakeGain }).connectedTo;

      const ctx2 = new FakeAudioContext();
      await engine.rebuildContext(
        ctx2 as unknown as AudioContext,
        okDecoder(new FakeAudioBuffer(200)),
      );

      // Anti-clic : le gain SHARED a ete rampe vers ~0 avant l'arret de la source.
      expect(oldGain.gain.ramps.length).toBeGreaterThan(0);
      const lastRamp = oldGain.gain.ramps.at(-1)!;
      expect(lastRamp.to).toBeLessThanOrEqual(0.01); // cible quasi silencieuse
      // La source a ete stoppee APRES la rampe (a la fin du fondu, pas a l'instant courant).
      expect(oldSource.stopped).toBe(true);
      expect(oldSource.stopWhen).toBeGreaterThan(ctx.currentTime);

      // Etat final INCHANGE : pause a la position memorisee, piste conservee.
      const s = engine.getState();
      expect(s.status).toBe("paused");
      expect(s.trackId).toBe(42);
      expect(s.positionSec).toBeCloseTo(37, 5);
    });

    it("reapplique le volume utilisateur sur le nouveau contexte", async () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      await engine.load(track({ id: 1 }));
      engine.setVolume(0.25);
      const ctx2 = new FakeAudioContext();
      await engine.rebuildContext(ctx2 as unknown as AudioContext, okDecoder(new FakeAudioBuffer(100)));
      expect(engine.getVolume()).toBeCloseTo(0.25, 5);
    });

    it("sans piste chargee, swap propre sans jeter", async () => {
      const engine = makeEngine(ctx, okDecoder(new FakeAudioBuffer(100)));
      const ctx2 = new FakeAudioContext();
      await expect(
        engine.rebuildContext(ctx2 as unknown as AudioContext, okDecoder(new FakeAudioBuffer(100))),
      ).resolves.toBeUndefined();
      // Sans piste chargée : `gain` + `volumeGain` seulement.
      expect(ctx2.gainCount).toBe(2);
    });
  });
});












