import type { TrackRow } from "../../shared/types";
import type { Decoder } from "./decoder";
import { nextStartTime, shouldPreload } from "./schedule";

/**
 * Moteur audio — graphe Web Audio, decodage, transport (load / play / pause / seek).
 *
 * Chantier n°1 du projet : « zero bug audio ». Le moteur est volontairement minimal et
 * defensif.
 *
 * Graphe : `source -> gain -> analyser -> destination`. Un seul `AudioContext`, reutilise.
 * `gain` et `analyser` sont crees une fois et reutilises ; seul le `BufferSource` est jetable
 * (c'est l'API Web Audio : un BufferSource ne se joue qu'une fois).
 *
 * Position : derivee de `AudioContext.currentTime`. En lecture,
 *   position = offset_de_depart + (currentTime - currentTime_au_demarrage),
 * bornee a [0, duree]. A l'arret (pause / ready / ended), la position est figee.
 *
 * Tache 8 — file d'attente, gapless et next/prev :
 *  - `setQueue(tracks, index)` fixe la file et charge la piste courante.
 *  - Quand il reste moins de `PRELOAD_LEAD_SEC` sur la courante (voir `shouldPreload`), la
 *    suivante est PRE-DECODEE puis une source est PROGRAMMEE via `start(when)` pile a la fin de
 *    la courante (`nextStartTime` sur l'horloge partagee) : enchainement a ZERO silence.
 *  - A la fin naturelle, cette source deja en vol est PROMUE source courante (chemin gapless).
 *  - `next()`/`prev()` manuels annulent proprement toute source (en vol ET programmee) avec un
 *    fondu de gain de quelques ms (anti-clic), puis demarrent la cible — il ne reste JAMAIS
 *    qu'UNE source vivante. `prev()` au-dela de 3 s redemarre la piste courante, sinon recule.
 *  - Le prechargement est pompe par `tick()` (l'UI l'appelle a la cadence de sa barre de
 *    progression) ; aucun timer interne, donc teardown sans fuite et tests deterministes.
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

/** Avance de prechargement : on decode la suivante quand il reste moins de ca sur la courante. */
const PRELOAD_LEAD_SEC = 10;
/** En deca de ce temps ecoule, `prev()` redemarre la piste courante au lieu de reculer. */
const PREV_RESTART_SEC = 3;
/** Duree du fondu de gain anti-clic lors d'un changement manuel (next/prev/replay). */
const FADE_SEC = 0.005;

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

  // --- File d'attente / gapless (Tache 8) ------------------------------------------------------
  /** File courante (pistes a enchainer). Vide = aucune file. */
  private queue: readonly TrackRow[] = [];
  /** Index de la piste courante dans `queue`. */
  private queueIndex = 0;

  /** Jeton de prechargement : incremente a chaque annulation pour defuser un decode en vol. */
  private preloadToken = 0;
  /** Index pour lequel un prechargement a ete LANCE (evite de relancer en boucle). */
  private preloadStartedForIndex: number | null = null;
  /** Buffer de la suivante, deja decode et pret a programmer. */
  private preloadedBuffer: AudioBuffer | null = null;
  /** Index auquel `preloadedBuffer` correspond. */
  private preloadedForIndex: number | null = null;

  /** Source de la suivante, deja programmee a demarrer a la fin de la courante (gapless). */
  private scheduledSource: AudioBufferSourceNode | null = null;
  /** Index de la source programmee. */
  private scheduledForIndex: number | null = null;
  /** Buffer de la source programmee (pour la promotion). */
  private scheduledBuffer: AudioBuffer | null = null;
  /** Instant-contexte (s) auquel la source programmee demarre = fin de la courante. */
  private scheduledWhen = 0;

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
    this.teardownScheduled(); // toute source programmee devient caduque
    this.clearPreload(); // un decode en vol est defuse
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
    // Replay apres une fin naturelle : la position est figee a la duree -> on redemarre a 0,
    // sinon `start(duree)` serait instantanement termine (lecture silencieuse).
    if (this.status === "ended" && this.pausedPositionSec >= this.durationSec - EPS) {
      this.pausedPositionSec = 0;
    }
    this.startSourceAt(this.pausedPositionSec);
    this.setStatus("playing");
    // Autoplay : le contexte peut etre suspendu ; on le reveille (no-op si deja actif).
    void this.context.resume?.();
    this.pump(); // amorce la logique de prechargement/gapless
  }

  /** Met en pause et fige la position. Sans effet hors lecture. */
  pause(): void {
    if (this.status !== "playing") return;
    this.pausedPositionSec = this.computePosition();
    this.teardownSource();
    this.teardownScheduled(); // pas de lecture fantome : la source programmee est annulee
    this.clearPreload();
    this.setStatus("paused");
  }

  /** Positionne la tete de lecture (s). Reste en lecture si on jouait, sinon fige la position. */
  seek(sec: number): void {
    const target = clamp(Number.isFinite(sec) ? sec : 0, 0, this.durationSec);
    this.pausedPositionSec = target;
    // La jointure programmee reposait sur l'ancien offset : elle est caduque apres un seek.
    this.teardownScheduled();
    this.clearPreload();
    if (this.status === "playing" && this.buffer) {
      this.startSourceAt(target); // remplace la source (un BufferSource ne se rejoue pas)
      this.pump();
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

  /**
   * Cree une source depuis le buffer, la cable au graphe et la demarre a `offsetSec`.
   *
   * @param offsetSec       Offset dans le buffer ou commencer la lecture.
   * @param startAtCtxTime  Instant-contexte du `start()` (defaut : maintenant). Un changement
   *                        manuel le decale de `FADE_SEC` pour laisser le fondu anti-clic finir.
   * @param fadeIn          Remonte le gain de ~0 a 1 sur `FADE_SEC` au demarrage (anti-clic).
   */
  private startSourceAt(
    offsetSec: number,
    startAtCtxTime: number = this.context.currentTime,
    fadeIn = false,
  ): void {
    const buffer = this.buffer;
    if (!buffer) return;
    this.teardownSource();
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.attachEndedHandler(source);
    const start = clamp(offsetSec, 0, this.durationSec);
    this.startOffsetSec = start;
    this.startedAtCtxTime = startAtCtxTime;
    this.source = source;
    if (fadeIn) this.rampGainUp(startAtCtxTime);
    source.start(startAtCtxTime, start);
  }

  /**
   * Attache le gardien de fin naturelle a une source. Il ne declenche l'avancee de file que si
   * cette source est bien la source courante au moment ou `onended` se declenche (un stop
   * volontaire detache `onended` avant d'appeler `stop()`, et `loadToken` defuse les sources
   * d'un `load()` precedent).
   */
  private attachEndedHandler(source: AudioBufferSourceNode): void {
    const token = this.loadToken;
    source.onended = (): void => {
      if (token !== this.loadToken || this.source !== source) return;
      this.onCurrentSourceEnded();
    };
  }

  /**
   * Fin naturelle de la source courante. Si la suivante est deja programmee et en vol, on la
   * PROMEUT (chemin gapless, zero trou). Sinon on avance dans la file vers la prochaine piste
   * lisible (saut silencieux d'une piste non lisible), ou on passe en `ended` en fin de file.
   */
  private onCurrentSourceEnded(): void {
    const nextIndex = this.queueIndex + 1;
    if (this.scheduledSource && this.scheduledForIndex === nextIndex) {
      this.promoteScheduled();
      return;
    }
    const target = this.findPlayableFrom(nextIndex, +1);
    if (target === null) {
      this.handleNaturalEnd();
      return;
    }
    // Pas de source pre-decodee a temps (ou suivante non lisible) : on avance via load (petit
    // silence possible a CETTE jointure seulement), en sautant les pistes non lisibles.
    this.teardownSource();
    this.queueIndex = target;
    void this.loadAndPlay(this.queue[target]!);
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
    this.teardownScheduled();
    this.clearPreload();
    this.pausedPositionSec = this.durationSec;
    this.setStatus("ended");
    this.emit("ended", { trackId: this.trackId });
  }

  // === File d'attente / gapless / next-prev (Tache 8) =========================================

  /**
   * Fixe la file d'attente et charge la piste a `index` (sans la jouer : l'UI appelle `play()`).
   * `index` est borne a la file. Une file vide reinitialise l'etat de file.
   */
  async setQueue(tracks: readonly TrackRow[], index = 0): Promise<void> {
    this.queue = tracks.slice();
    this.teardownScheduled();
    this.clearPreload();
    if (this.queue.length === 0) {
      this.queueIndex = 0;
      return;
    }
    this.queueIndex = clamp(Math.floor(index), 0, this.queue.length - 1);
    await this.load(this.queue[this.queueIndex]!);
  }

  /** Index de la piste courante dans la file. */
  getQueueIndex(): number {
    return this.queueIndex;
  }

  /**
   * Point de pompe du prechargement/gapless. L'UI l'appelle a la cadence de sa barre de
   * progression (p.ex. a chaque frame d'animation). Idempotent et sans effet hors lecture.
   */
  tick(): void {
    this.pump();
  }

  /** Avance a la prochaine piste lisible (fondu anti-clic). Sans effet en fin de file. */
  async next(): Promise<void> {
    if (this.queue.length === 0) return;
    const target = this.findPlayableFrom(this.queueIndex + 1, +1);
    if (target === null) return; // fin de file : on ne touche a rien
    await this.switchTo(target);
  }

  /**
   * Recule (convention usuelle). Au-dela de `PREV_RESTART_SEC` secondes ecoulees, redemarre la
   * piste courante (seek 0) ; dans les premieres secondes, va a la piste lisible precedente.
   * Sans precedente (ou file vide) : redemarre la piste courante.
   */
  async prev(): Promise<void> {
    if (!this.buffer && this.queue.length === 0) return;
    const position = this.getState().positionSec;
    if (this.queue.length === 0 || position > PREV_RESTART_SEC) {
      this.restartCurrent();
      return;
    }
    const target = this.findPlayableFrom(this.queueIndex - 1, -1);
    if (target === null) {
      this.restartCurrent();
      return;
    }
    await this.switchTo(target);
  }

  /** Premiere piste lisible a partir de `start` dans la direction `dir` (±1), ou `null`. */
  private findPlayableFrom(start: number, dir: 1 | -1): number | null {
    for (let i = start; i >= 0 && i < this.queue.length; i += dir) {
      if (this.queue[i]!.playable) return i;
    }
    return null;
  }

  /**
   * Changement manuel vers `index` : annule proprement toute source (fondu anti-clic), charge la
   * cible, puis la demarre a 0 avec un fondu d'entree. Robuste a la rafale : chaque appel pose
   * `queueIndex` de maniere synchrone ; une continuation obsolete (supplantee par un appel plus
   * recent) se retire sans creer de source. Il ne reste donc jamais qu'UNE source vivante.
   */
  private async switchTo(index: number): Promise<void> {
    this.cancelAllSourcesAntiClick(); // stoppe courante + programmee avec fondu de sortie
    this.queueIndex = index;
    const target = this.queue[index]!;
    await this.load(target); // incremente loadToken ; les decodes obsoletes sont jetes
    if (this.queueIndex !== index) return; // supplante par un next/prev plus recent
    if (this.buffer && this.status === "ready") {
      this.pausedPositionSec = 0;
      this.startSourceAt(0, this.context.currentTime, /* fadeIn */ true);
      this.setStatus("playing");
      void this.context.resume?.();
      this.pump();
    } else {
      // Cible non lisible : on restaure le gain pour ne pas laisser le moteur muet.
      this.restoreGain();
    }
  }

  /** Redemarre la piste courante depuis 0 (replay / prev-at-start), fondu anti-clic. */
  private restartCurrent(): void {
    if (!this.buffer) return;
    const at = this.cancelAllSourcesAntiClick();
    this.clearPreload();
    this.pausedPositionSec = 0;
    this.startSourceAt(0, at, /* fadeIn */ true);
    this.setStatus("playing");
    void this.context.resume?.();
    this.pump();
  }

  /** Charge puis joue (depuis 0) — utilise par l'avancee de file sur fin naturelle. */
  private async loadAndPlay(track: TrackRow): Promise<void> {
    const index = this.queueIndex;
    await this.load(track);
    if (this.queueIndex !== index) return; // supplante entre-temps
    if (this.buffer && this.status === "ready") {
      this.pausedPositionSec = 0;
      this.startSourceAt(0);
      this.setStatus("playing");
      void this.context.resume?.();
      this.pump();
    }
  }

  /**
   * Pompe de prechargement/programmation. Quand il reste moins de `PRELOAD_LEAD_SEC` sur la
   * courante : (1) lance le decodage de la suivante ; (2) des que le buffer est pret, programme
   * sa source pour demarrer PILE a la fin de la courante. Idempotent et garde-fou si la piste du
   * moteur ne correspond plus a `queue[queueIndex]`.
   */
  private pump(): void {
    if (this.status !== "playing" || !this.buffer) return;
    const cur = this.queue[this.queueIndex];
    if (!cur || cur.id !== this.trackId) return; // moteur desynchronise de la file : on s'abstient
    const nextIndex = this.queueIndex + 1;
    if (nextIndex >= this.queue.length) return; // pas de suivante

    const position = this.computePosition();
    if (
      this.preloadStartedForIndex !== nextIndex &&
      this.preloadedForIndex !== nextIndex &&
      shouldPreload(position, this.durationSec, PRELOAD_LEAD_SEC)
    ) {
      void this.beginPreload(nextIndex);
    }
    if (
      this.preloadedForIndex === nextIndex &&
      this.preloadedBuffer &&
      this.scheduledForIndex !== nextIndex
    ) {
      this.scheduleNext(nextIndex);
    }
  }

  /** Decode la piste `index` en avance. Une piste non lisible reste simplement non programmee. */
  private async beginPreload(index: number): Promise<void> {
    const track = this.queue[index];
    if (!track) return;
    this.preloadStartedForIndex = index;
    const token = ++this.preloadToken;
    if (!track.playable || !this.decoder.canDecode(track.path)) return; // sautee a la fin naturelle
    let buffer: AudioBuffer;
    try {
      const bytes = await this.readBytes(track.path);
      buffer = await this.decoder.decode(bytes);
    } catch {
      return; // suivante non decodable : laissee non programmee, sautee sans bruit
    }
    if (token !== this.preloadToken) return; // prechargement annule / supplante
    this.preloadedBuffer = buffer;
    this.preloadedForIndex = index;
    this.pump(); // buffer pret -> on programme tout de suite
  }

  /**
   * Programme la source de la suivante pour demarrer exactement a la fin de la courante, sur
   * l'horloge partagee : `nextStartTime(prevStart, duree)` ou `prevStart` est l'instant-contexte
   * auquel la position 0 de la courante serait tombee. ZERO trou a la jointure.
   */
  private scheduleNext(index: number): void {
    const buffer = this.preloadedBuffer;
    if (!buffer || (this.scheduledForIndex === index && this.scheduledSource)) return;
    const prevStart = this.startedAtCtxTime - this.startOffsetSec;
    const when = nextStartTime(prevStart, this.durationSec);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    // `onended` reste nul jusqu'a la promotion : cette source ne doit pas avancer la file seule.
    this.scheduledSource = source;
    this.scheduledForIndex = index;
    this.scheduledBuffer = buffer;
    this.scheduledWhen = when;
    try {
      source.start(when, 0);
    } catch {
      try {
        source.start();
      } catch {
        /* source invalide : on abandonne la programmation (la fin naturelle fera un load) */
        this.teardownScheduled();
      }
    }
  }

  /**
   * Promeut la source programmee (deja en vol) en source courante, sans la stopper : c'est le
   * cœur du gapless. L'ancienne source (terminee) est detachee, l'etat bascule sur la suivante,
   * et on amorce le prechargement de la piste d'apres.
   */
  private promoteScheduled(): void {
    const next = this.scheduledSource;
    const when = this.scheduledWhen;
    const buffer = this.scheduledBuffer;
    const index = this.scheduledForIndex;
    if (!next || !buffer || index === null) {
      this.handleNaturalEnd();
      return;
    }
    // Detache l'ancienne source (elle vient de finir naturellement) : `stop()` dessus est un
    // no-op (deja terminee) mais garantit qu'il ne reste qu'UNE source vivante.
    const old = this.source;
    if (old) {
      old.onended = null;
      try {
        old.stop();
      } catch {
        /* deja terminee */
      }
      try {
        old.disconnect();
      } catch {
        /* deja detachee */
      }
    }
    // Libere les references de programmation SANS stopper la source promue.
    this.scheduledSource = null;
    this.scheduledForIndex = null;
    this.scheduledBuffer = null;
    this.scheduledWhen = 0;
    this.preloadedBuffer = null;
    this.preloadedForIndex = null;
    this.preloadStartedForIndex = null;
    // Bascule l'etat sur la piste promue.
    this.source = next;
    this.buffer = buffer;
    this.durationSec = Number.isFinite(buffer.duration) ? buffer.duration : 0;
    this.queueIndex = index;
    this.trackId = this.queue[index]?.id ?? this.trackId;
    this.startOffsetSec = 0;
    this.startedAtCtxTime = when;
    this.pausedPositionSec = 0;
    this.attachEndedHandler(next); // sa propre fin naturelle fera avancer la file
    this.setStatus("playing"); // emet statechange avec le nouveau trackId
    this.pump(); // precharge la piste d'apres
  }

  /** Detache et stoppe la source PROGRAMMEE (non courante) sans declencher d'avancee de file. */
  private teardownScheduled(): void {
    const source = this.scheduledSource;
    this.scheduledSource = null;
    this.scheduledForIndex = null;
    this.scheduledBuffer = null;
    this.scheduledWhen = 0;
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

  /** Invalide tout prechargement (en vol ou cache). */
  private clearPreload(): void {
    this.preloadToken++;
    this.preloadedBuffer = null;
    this.preloadedForIndex = null;
    this.preloadStartedForIndex = null;
  }

  /**
   * Annule proprement courante ET programmee pour un changement manuel : rampe le gain vers ~0
   * sur `FADE_SEC` (anti-clic) puis stoppe les sources a la fin de la rampe. Renvoie l'instant
   * (`now + FADE_SEC`) a partir duquel il est propre de demarrer la cible.
   */
  private cancelAllSourcesAntiClick(): number {
    const now = this.context.currentTime;
    const end = now + FADE_SEC;
    const gp = this.gain.gain;
    if (
      typeof gp.cancelScheduledValues === "function" &&
      typeof gp.setValueAtTime === "function" &&
      typeof gp.linearRampToValueAtTime === "function"
    ) {
      const cur = typeof gp.value === "number" ? gp.value : 1;
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(cur, now);
      gp.linearRampToValueAtTime(0.0001, end); // fondu de sortie court
    } else if (typeof gp.value === "number") {
      gp.value = 0.0001;
    }
    this.stopSourceAt(this.source, end);
    this.source = null;
    this.stopSourceAt(this.scheduledSource, end);
    this.scheduledSource = null;
    this.scheduledForIndex = null;
    this.scheduledBuffer = null;
    this.scheduledWhen = 0;
    return end;
  }

  /** Stoppe une source a `at` (apres le fondu) et la detache une fois terminee (pas de fuite). */
  private stopSourceAt(source: AudioBufferSourceNode | null, at: number): void {
    if (!source) return;
    // Detache apres l'arret effectif pour ne pas couper le signal avant la fin du fondu.
    source.onended = (): void => {
      try {
        source.disconnect();
      } catch {
        /* deja detachee */
      }
    };
    try {
      source.stop(at);
    } catch {
      try {
        source.stop();
      } catch {
        /* deja stoppee */
      }
    }
  }

  /** Remonte le gain de ~0 a 1 sur `FADE_SEC` a partir de `at` (fondu d'entree anti-clic). */
  private rampGainUp(at: number): void {
    const gp = this.gain.gain;
    if (
      typeof gp.setValueAtTime === "function" &&
      typeof gp.linearRampToValueAtTime === "function"
    ) {
      gp.setValueAtTime(0.0001, at);
      gp.linearRampToValueAtTime(1, at + FADE_SEC);
    } else if (typeof gp.value === "number") {
      gp.value = 1;
    }
  }

  /** Restaure le gain plein (apres un changement avorte) pour ne pas laisser le moteur muet. */
  private restoreGain(): void {
    const gp = this.gain.gain;
    const now = this.context.currentTime;
    if (
      typeof gp.cancelScheduledValues === "function" &&
      typeof gp.setValueAtTime === "function"
    ) {
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(1, now);
    } else if (typeof gp.value === "number") {
      gp.value = 1;
    }
  }
}
