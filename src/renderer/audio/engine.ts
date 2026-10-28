import type { TrackRow } from "../../shared/types";
import type { Decoder } from "./decoder";

/**
 * Moteur audio — graphe Web Audio, decodage, transport (load / play / pause / seek).
 *
 * Chantier n°1 du projet : « zero bug audio ». Le moteur est volontairement minimal et
 * defensif. Il ne gere qu'UNE piste a la fois ; la file d'attente, le gapless et le
 * next/prev appartiennent a la Tache 8 et s'appuient sur `load` + l'evenement `ended`.
 *
 * Graphe : `source -> gain -> analyser -> destination`. Un seul `AudioContext`, reutilise.
 * `gain` et `analyser` sont crees une fois et reutilises ; seul le `BufferSource` est jetable
 * (c'est l'API Web Audio : un BufferSource ne se joue qu'une fois).
 *
 * Position : derivee de `AudioContext.currentTime`. En lecture,
 *   position = offset_de_depart + (currentTime - currentTime_au_demarrage),
 * bornee a [0, duree]. A l'arret (pause / ready / ended), la position est figee.
 */

export type PlaybackStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

export interface PlaybackState {
  status: PlaybackStatus;
  /** Position de lecture en secondes, bornee a [0, durationSec]. */
  positionSec: number;
  /** Duree de la piste decodee (depuis l'`AudioBuffer`), 0 si rien n'est charge. */
  durationSec: number;
  /** `id` de la piste courante, `null` si aucune. */
  trackId: number | null;
}

/** Charge utile de chaque evenement emis par le moteur. */
export interface EngineEventMap {
  /** Emis a chaque changement d'etat (utile pour l'UI). */
  statechange: PlaybackState;
  /** Fin naturelle de la piste (NON emis sur un stop volontaire pause/seek/load). */
  ended: { trackId: number | null };
  /** Piste non lisible (non decodable / rejetee / `playable:false`). Aucun son produit. */
  unplayable: { trackId: number | null; path: string; reason: string };
  /** Erreur inattendue hors decodage (rare ; le moteur reste utilisable). */
  error: { trackId: number | null; error: unknown };
}
export type EngineEvent = keyof EngineEventMap;
type Listener<E extends EngineEvent> = (payload: EngineEventMap[E]) => void;

/** Lecture des octets bruts d'un fichier pour le decodage (injectable → testable). */
export type ReadBytes = (path: string) => Promise<ArrayBuffer>;

/** Repli par defaut : passe par le pont `window.benten` (IPC validee cote Main). */
const defaultReadBytes: ReadBytes = (path) => window.benten.audio.readFile(path);

const EPS = 1e-6;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export class AudioEngine {
  private readonly context: AudioContext;
  private readonly decoder: Decoder;
  private readonly readBytes: ReadBytes;

  // Graphe reutilise : gain -> analyser -> destination (cable une seule fois).
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;

  private readonly listeners: { [E in EngineEvent]: Set<Listener<E>> } = {
    statechange: new Set(),
    ended: new Set(),
    unplayable: new Set(),
    error: new Set(),
  };

  private status: PlaybackStatus = "idle";
  private trackId: number | null = null;
  private buffer: AudioBuffer | null = null;
  private durationSec = 0;

  /** Source en cours ; `null` hors lecture. */
  private source: AudioBufferSourceNode | null = null;
  /** Offset (s) auquel la source courante a demarre. */
  private startOffsetSec = 0;
  /** `currentTime` du contexte au demarrage de la source courante. */
  private startedAtCtxTime = 0;
  /** Position figee (s) quand on n'est pas en lecture. */
  private pausedPositionSec = 0;
  /**
   * Jeton d'execution : incremente a chaque `load`. Un decodage qui se termine apres qu'une
   * autre piste a ete demandee est ignore (pas de course entre deux `load` rapides).
   */
  private loadToken = 0;

  /**
   * @param context  `AudioContext` partage (injectable → mockable).
   * @param decoder  Strategie de decodage (injectable → mockable).
   * @param readBytes Lecture des octets du fichier ; defaut : `window.benten.audio.readFile`.
   */
  constructor(context: AudioContext, decoder: Decoder, readBytes: ReadBytes = defaultReadBytes) {
    this.context = context;
    this.decoder = decoder;
    this.readBytes = readBytes;
    this.gain = context.createGain();
    this.analyser = context.createAnalyser();
    this.gain.connect(this.analyser);
    this.analyser.connect(context.destination);
  }

  /** Nœud d'analyse (spectre / VU-metre), pour l'UI. */
  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  on<E extends EngineEvent>(event: E, cb: Listener<E>): () => void {
    this.listeners[event].add(cb);
    return () => {
      this.listeners[event].delete(cb);
    };
  }

  private emit<E extends EngineEvent>(event: E, payload: EngineEventMap[E]): void {
    for (const cb of [...this.listeners[event]]) {
      try {
        cb(payload);
      } catch {
        /* un abonne defaillant ne doit jamais casser le moteur */
      }
    }
  }

  private setStatus(status: PlaybackStatus): void {
    this.status = status;
    this.emit("statechange", this.getState());
  }

  /**
   * Charge une piste : lit les octets, decode, et se met en `ready` (sans jouer).
   * Ne LEVE JAMAIS : une piste non lisible (`playable:false`, format refuse, decodage en
   * echec) passe en `error` et emet `unplayable`, sans produire de son.
   */
  async load(track: TrackRow): Promise<void> {
    const token = ++this.loadToken;
    this.teardownSource();
    this.buffer = null;
    this.durationSec = 0;
    this.pausedPositionSec = 0;
    this.startOffsetSec = 0;
    this.trackId = track.id;

    const fail = (reason: string): void => {
      if (token !== this.loadToken) return; // une autre piste a ete demandee entre-temps
      this.buffer = null;
      this.setStatus("error");
      this.emit("unplayable", { trackId: track.id, path: track.path, reason });
    };

    if (!track.playable) return fail("track marked unplayable");
    if (!this.decoder.canDecode(track.path)) return fail("unsupported format");

    this.setStatus("loading");
    let buffer: AudioBuffer;
    try {
      const bytes = await this.readBytes(track.path);
      buffer = await this.decoder.decode(bytes);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "decode error");
    }
    if (token !== this.loadToken) return; // piste obsolete : on jette ce decodage

    this.buffer = buffer;
    this.durationSec = Number.isFinite(buffer.duration) ? buffer.duration : 0;
    this.setStatus("ready");
  }

  /** Demarre / reprend la lecture depuis la position courante. Sans effet si rien de jouable. */
  play(): void {
    if (this.status === "playing") return; // idempotent : pas de source en double
    if (!this.buffer) return; // error / idle : AUCUN nœud source cree, aucun son
    this.startSourceAt(this.pausedPositionSec);
    this.setStatus("playing");
    // Autoplay : le contexte peut etre suspendu ; on le reveille (no-op si deja actif).
    void this.context.resume?.();
  }

  /** Met en pause et fige la position. Sans effet hors lecture. */
  pause(): void {
    if (this.status !== "playing") return;
    this.pausedPositionSec = this.computePosition();
    this.teardownSource();
    this.setStatus("paused");
  }

  /** Positionne la tete de lecture (s). Reste en lecture si on jouait, sinon fige la position. */
  seek(sec: number): void {
    const target = clamp(Number.isFinite(sec) ? sec : 0, 0, this.durationSec);
    this.pausedPositionSec = target;
    if (this.status === "playing" && this.buffer) {
      this.startSourceAt(target); // remplace la source (un BufferSource ne se rejoue pas)
    }
  }

  getState(): PlaybackState {
    return {
      status: this.status,
      positionSec: this.status === "playing" ? this.computePosition() : this.pausedPositionSec,
      durationSec: this.durationSec,
      trackId: this.trackId,
    };
  }

  /** Position derivee de l'horloge du contexte, bornee a [0, duree]. */
  private computePosition(): number {
    const elapsed = this.context.currentTime - this.startedAtCtxTime;
    return clamp(this.startOffsetSec + elapsed, 0, this.durationSec);
  }

  /** Cree une source depuis le buffer, la cable au graphe et la demarre a `offsetSec`. */
  private startSourceAt(offsetSec: number): void {
    const buffer = this.buffer;
    if (!buffer) return;
    this.teardownSource();
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const token = this.loadToken;
    source.onended = (): void => {
      // N'agit que si c'est bien LA source courante qui se termine d'elle-meme (pas un stop
      // volontaire : teardownSource() detache onended avant d'appeler stop()).
      if (token !== this.loadToken || this.source !== source) return;
      this.handleNaturalEnd();
    };
    const start = clamp(offsetSec, 0, this.durationSec);
    this.startOffsetSec = start;
    this.startedAtCtxTime = this.context.currentTime;
    this.source = source;
    source.start(0, start);
  }

  /** Detache et stoppe la source courante sans declencher `ended` (stop volontaire). */
  private teardownSource(): void {
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* deja stoppee / jamais demarree */
    }
    try {
      source.disconnect();
    } catch {
      /* deja detachee */
    }
  }

  private handleNaturalEnd(): void {
    this.teardownSource();
    this.pausedPositionSec = this.durationSec;
    this.setStatus("ended");
    this.emit("ended", { trackId: this.trackId });
  }
}
