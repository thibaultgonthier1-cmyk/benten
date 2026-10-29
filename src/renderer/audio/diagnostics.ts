import type { DiagEntry, RendererDiagKind } from "../../shared/diagnostics";
import { DIAG_MAX_BATCH } from "../../shared/diagnostics";
import type { PlaybackState, PlaybackStatus } from "./engine";

/**
 * Journal audio — diagnostic des micro-coupures EN PRODUCTION (pur + injectable).
 *
 * Le journal OBSERVE seulement : il lit l'horloge de sortie du contexte, l'etat du moteur et
 * quelques evenements systeme, et produit des entrees `{ t, kind, ...details }` via `append`. Il
 * n'appelle JAMAIS un mutateur du moteur (play/pause/seek/tick/...), ne cree aucun noeud audio et
 * aucune de ses exceptions ne peut atteindre le moteur ni l'appelant (tout est sous try/catch).
 *
 * Detecteur de coupure (valide par le controleur sur la meme machine Electron 45) : toutes les
 * 20 ms, `ctx.getOutputTimestamp()` ; entre deux echantillons,
 *   jump = Δ(performanceTime) − Δ(contextTime) × 1000
 * Si le thread audio a manque des quanta, l'horloge du contexte « prend du retard » sur l'horloge
 * murale : `jump > 5 ms` → glitch. Les glitchs a moins d'1 s d'ecart sont coalesces.
 */

/** Pas d'echantillonnage du detecteur (ms). */
const SAMPLE_INTERVAL_MS = 20;
/** Seuil de detection d'une coupure (ms perdues entre deux echantillons). */
const GLITCH_THRESHOLD_MS = 5;
/** Fenetre de coalescence des glitchs (ms) : plus proches que ca → une seule entree. */
const GLITCH_COALESCE_MS = 1000;
/** Retard de l'intervalle au-dela duquel on journalise un blocage du thread principal (ms). */
const STALL_THRESHOLD_MS = 250;
/** Ecart a la position attendue au-dela duquel on journalise un saut de position (s). */
const POSITION_JUMP_SEC = 1.5;

/** Ce que le journal lit d'un `AudioContext` (sous-ensemble ; tout l'optionnel est garde). */
export interface DiagContextLike {
  readonly state: AudioContextState | string;
  readonly sampleRate: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  getOutputTimestamp?: () => AudioTimestamp;
  addEventListener?(type: "statechange", cb: () => void): void;
  removeEventListener?(type: "statechange", cb: () => void): void;
}

/** Ce que le journal lit du moteur : abonnement `statechange` + `getState()` (lecture seule). */
export interface DiagEngineLike {
  on(event: "statechange", cb: (s: PlaybackState) => void): () => void;
  getState(): PlaybackState;
}

/** Cible d'evenements minimale (window, document, mediaDevices). */
export interface DiagEventTarget {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

export interface AudioDiagnosticsDeps {
  /** Contexte COURANT (getter : la reconstruction de qualite remplace le contexte). */
  getContext: () => DiagContextLike | null | undefined;
  engine: DiagEngineLike;
  /** Recoit chaque entree (le regroupement IPC est fait par `createDiagnosticsSink`). */
  append: (entry: DiagEntry) => void;
  /** Horloge monotone en ms (defaut `performance.now`). */
  now?: () => number;
  /** Horodatage ISO des entrees (defaut `new Date().toISOString()`). */
  isoNow?: () => string;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** `latencyHint` demande a la creation du contexte (consigne dans l'entree `session`). */
  latencyHint?: string;
  mediaDevices?: (DiagEventTarget & { enumerateDevices(): Promise<{ kind: string }[]> }) | null;
  win?: DiagEventTarget | null;
  doc?: (DiagEventTarget & { visibilityState?: string }) | null;
}

export interface AudioDiagnosticsHandle {
  stop(): void;
}

/** Nombre fini, sinon `null` (les latences sont absentes sur certaines plateformes). */
const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

function latencies(ctx: DiagContextLike): {
  sampleRate: number | null;
  baseLatency: number | null;
  outputLatency: number | null;
} {
  return {
    sampleRate: finiteOrNull(ctx.sampleRate),
    baseLatency: finiteOrNull(ctx.baseLatency),
    outputLatency: finiteOrNull(ctx.outputLatency),
  };
}

/** Demarre le journal. Ne leve jamais ; `stop()` est idempotent et emet un glitch en attente. */
export function startAudioDiagnostics(deps: AudioDiagnosticsDeps): AudioDiagnosticsHandle {
  const now = deps.now ?? ((): number => performance.now());
  const isoNow = deps.isoNow ?? ((): string => new Date().toISOString());
  const setIntervalFn =
    deps.setInterval ?? ((fn: () => void, ms: number): unknown => globalThis.setInterval(fn, ms));
  const clearIntervalFn =
    deps.clearInterval ??
    ((h: unknown): void => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
  const { engine } = deps;

  let stopped = false;

  /** Ecrit une entree ; toute exception (append, horloge) est avalee. */
  const emit = (kind: RendererDiagKind, details: Record<string, unknown>, t?: string): void => {
    if (stopped) return;
    try {
      deps.append({ t: t ?? isoNow(), kind, ...details });
    } catch {
      /* le journal ne doit jamais casser quoi que ce soit */
    }
  };

  // --- Etat du moteur, suivi par `statechange` -------------------------------------------------
  let status: PlaybackStatus = "idle";
  let trackId: number | null = null;
  try {
    const s = engine.getState();
    status = s.status;
    trackId = s.trackId;
  } catch {
    /* etat initial inconnu : on part de idle */
  }

  // --- Echantillons du detecteur (nombres seulement : aucune allocation par echantillon) -------
  let lastTickAt: number | null = null;
  let prevPerf: number | null = null;
  let prevCtxTime = 0;
  let prevPos: number | null = null;
  let prevPosAt = 0;
  let prevPosTrack: number | null = null;
  const resetSamples = (): void => {
    prevPerf = null;
    prevPos = null;
  };

  // --- Glitch en cours de coalescence ----------------------------------------------------------
  let pending: {
    t: string;
    firstAt: number;
    lastAt: number;
    count: number;
    lostMs: number;
    details: Record<string, unknown>;
  } | null = null;
  const flushGlitch = (): void => {
    const g = pending;
    pending = null;
    if (!g) return;
    emit(
      "glitch",
      { lostMs: round(g.lostMs, 1), count: g.count, spanMs: Math.round(g.lastAt - g.firstAt), ...g.details },
      g.t,
    );
  };
  const recordGlitch = (lostMs: number, at: number, ctx: DiagContextLike): void => {
    if (pending && at - pending.lastAt < GLITCH_COALESCE_MS) {
      pending.count += 1;
      pending.lostMs += lostMs;
      pending.lastAt = at;
      return;
    }
    flushGlitch();
    let positionSec: number | null = null;
    try {
      positionSec = round(engine.getState().positionSec, 3);
    } catch {
      /* position inconnue */
    }
    let t: string;
    try {
      t = isoNow();
    } catch {
      t = "";
    }
    const { baseLatency, outputLatency } = latencies(ctx);
    pending = {
      t,
      firstAt: at,
      lastAt: at,
      count: 1,
      lostMs,
      details: { trackId, positionSec, ctxState: ctx.state, baseLatency, outputLatency },
    };
  };

  // --- Contexte courant + son `statechange` ----------------------------------------------------
  let currentCtx: DiagContextLike | null = null;
  let ctxListener: (() => void) | null = null;
  const detachCtx = (): void => {
    const ctx = currentCtx;
    const cb = ctxListener;
    ctxListener = null;
    if (ctx && cb) {
      try {
        ctx.removeEventListener?.("statechange", cb);
      } catch {
        /* ignore */
      }
    }
  };
  const attachCtx = (ctx: DiagContextLike | null): void => {
    detachCtx();
    currentCtx = ctx;
    if (!ctx) return;
    const cb = (): void => {
      try {
        emit("ctx", { event: "statechange", state: ctx.state, ...latencies(ctx) });
      } catch {
        /* ignore */
      }
    };
    try {
      if (typeof ctx.addEventListener === "function") {
        ctx.addEventListener("statechange", cb);
        ctxListener = cb;
      }
    } catch {
      /* contexte sans evenements : on se contente de l'echantillonnage */
    }
  };
  const readContext = (): DiagContextLike | null => {
    try {
      return deps.getContext() ?? null;
    } catch {
      return null;
    }
  };

  // --- Entree `session` -------------------------------------------------------------------------
  try {
    const ctx = readContext();
    attachCtx(ctx);
    emit("session", {
      ...(ctx ? latencies(ctx) : { sampleRate: null, baseLatency: null, outputLatency: null }),
      latencyHint: deps.latencyHint ?? null,
      ctxState: ctx ? ctx.state : null,
    });
  } catch {
    /* ignore */
  }

  // --- Echantillonnage (20 ms) ------------------------------------------------------------------
  const sample = (): void => {
    const at = now();
    if (lastTickAt !== null) {
      const late = at - lastTickAt - SAMPLE_INTERVAL_MS;
      if (late > STALL_THRESHOLD_MS) emit("stall", { ms: Math.round(late) });
    }
    lastTickAt = at;

    if (pending && at - pending.lastAt >= GLITCH_COALESCE_MS) flushGlitch();

    const ctx = readContext();
    if (ctx !== currentCtx) {
      attachCtx(ctx);
      resetSamples();
      if (ctx) emit("ctx", { event: "replaced", ...latencies(ctx) });
    }
    if (!ctx || status !== "playing") {
      resetSamples();
      return;
    }

    // Saut de position inattendu (meme piste, en lecture).
    const st = engine.getState();
    if (st.status !== "playing") {
      resetSamples();
      return;
    }
    if (prevPos !== null && prevPosTrack === st.trackId) {
      const expected = prevPos + (at - prevPosAt) / 1000;
      const delta = st.positionSec - expected;
      if (Math.abs(delta) > POSITION_JUMP_SEC) {
        emit("engine", {
          event: "position-jump",
          deltaSec: round(delta, 3),
          trackId: st.trackId,
          positionSec: round(st.positionSec, 3),
        });
      }
    }
    prevPos = st.positionSec;
    prevPosAt = at;
    prevPosTrack = st.trackId;

    // Detecteur de coupure.
    if (ctx.state !== "running" || typeof ctx.getOutputTimestamp !== "function") {
      prevPerf = null;
      return;
    }
    let perf: number;
    let ctxTime: number;
    try {
      const ts = ctx.getOutputTimestamp();
      perf = ts.performanceTime ?? 0;
      ctxTime = ts.contextTime ?? 0;
    } catch {
      prevPerf = null;
      return;
    }
    if (!(perf > 0) || !Number.isFinite(perf) || !Number.isFinite(ctxTime)) {
      prevPerf = null; // echantillon invalide : on re-cale au suivant
      return;
    }
    if (prevPerf !== null) {
      const jump = perf - prevPerf - (ctxTime - prevCtxTime) * 1000;
      if (jump > GLITCH_THRESHOLD_MS) recordGlitch(jump, at, ctx);
    }
    prevPerf = perf;
    prevCtxTime = ctxTime;
  };
  const onTick = (): void => {
    if (stopped) return;
    try {
      sample();
    } catch {
      resetSamples(); // jamais propage au minuteur (ni, a fortiori, au moteur)
    }
  };
  let intervalHandle: unknown = null;
  try {
    intervalHandle = setIntervalFn(onTick, SAMPLE_INTERVAL_MS);
  } catch {
    intervalHandle = null;
  }

  // --- Transitions du moteur --------------------------------------------------------------------
  let unsubscribeEngine: (() => void) | null = null;
  try {
    unsubscribeEngine = engine.on("statechange", (s) => {
      try {
        if (s.status !== status || s.trackId !== trackId) {
          emit("engine", {
            from: status,
            to: s.status,
            trackId: s.trackId,
            positionSec: round(s.positionSec, 3),
          });
        }
        status = s.status;
        trackId = s.trackId;
        if (s.status !== "playing") resetSamples();
      } catch {
        /* ignore */
      }
    });
  } catch {
    unsubscribeEngine = null;
  }

  // --- Peripheriques et fenetre -------------------------------------------------------------------
  const removers: (() => void)[] = [];
  const listen = (target: DiagEventTarget | null | undefined, type: string, cb: () => void): void => {
    if (!target) return;
    const safe = (): void => {
      try {
        cb();
      } catch {
        /* ignore */
      }
    };
    try {
      target.addEventListener(type, safe);
      removers.push(() => target.removeEventListener(type, safe));
    } catch {
      /* cible indisponible */
    }
  };
  const md = deps.mediaDevices;
  listen(md, "devicechange", () => {
    if (!md || typeof md.enumerateDevices !== "function") return;
    md.enumerateDevices().then(
      (list) => {
        // Nombre de sorties audio uniquement : jamais de libelle ni d'identifiant.
        emit("device", {
          event: "devicechange",
          audioOutputs: list.filter((d) => d.kind === "audiooutput").length,
        });
      },
      () => emit("device", { event: "devicechange", audioOutputs: null }),
    );
  });
  listen(deps.win, "focus", () => emit("window", { event: "focus" }));
  listen(deps.win, "blur", () => emit("window", { event: "blur" }));
  const doc = deps.doc;
  listen(doc, "visibilitychange", () =>
    emit("window", { event: "visibility", state: doc?.visibilityState ?? null }),
  );

  return {
    stop(): void {
      if (stopped) return;
      flushGlitch(); // un glitch en attente de coalescence n'est pas perdu
      stopped = true;
      try {
        if (intervalHandle !== null) clearIntervalFn(intervalHandle);
      } catch {
        /* ignore */
      }
      try {
        unsubscribeEngine?.();
      } catch {
        /* ignore */
      }
      detachCtx();
      for (const remove of removers.splice(0)) {
        try {
          remove();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// === Regroupement des envois IPC ==================================================================

export interface DiagnosticsSinkDeps {
  /** Envoi d'un lot au Main (`window.benten.diagnostics.append`). */
  send: (entries: DiagEntry[]) => unknown;
  /** Cadence max des envois (ms) ; un `glitch` part immediatement. */
  flushMs?: number;
  maxBatch?: number;
  /** Au-dela, les nouvelles entrees sont abandonnees (IPC bloquee) : memoire bornee. */
  maxBuffered?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface DiagnosticsSink {
  append(entry: DiagEntry): void;
  flush(): void;
  stop(): void;
}

/**
 * Tampon d'envoi : regroupe les entrees et les envoie au plus toutes les `flushMs` (2 s), en lots
 * de `maxBatch` (200) au plus ; un `glitch` declenche un envoi immediat. Un echec d'envoi (levee ou
 * rejet) est avale : le journal est best-effort.
 */
export function createDiagnosticsSink(deps: DiagnosticsSinkDeps): DiagnosticsSink {
  const flushMs = deps.flushMs ?? 2000;
  const maxBatch = deps.maxBatch ?? DIAG_MAX_BATCH;
  const maxBuffered = deps.maxBuffered ?? 2000;
  const setTimeoutFn =
    deps.setTimeout ?? ((fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms));
  const clearTimeoutFn =
    deps.clearTimeout ??
    ((h: unknown): void => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));

  let buffer: DiagEntry[] = [];
  let timer: unknown = null;
  let stopped = false;

  const flush = (): void => {
    if (timer !== null) {
      try {
        clearTimeoutFn(timer);
      } catch {
        /* ignore */
      }
      timer = null;
    }
    while (buffer.length > 0) {
      const batch = buffer.slice(0, maxBatch);
      buffer = buffer.slice(maxBatch);
      try {
        const r = deps.send(batch);
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).then(undefined, () => {
            /* best-effort */
          });
        }
      } catch {
        /* best-effort */
      }
    }
  };

  return {
    append(entry: DiagEntry): void {
      if (stopped) return;
      if (buffer.length >= maxBuffered) return;
      buffer.push(entry);
      if (entry.kind === "glitch") {
        flush();
        return;
      }
      if (timer === null) {
        try {
          timer = setTimeoutFn(() => {
            timer = null;
            flush();
          }, flushMs);
        } catch {
          flush();
        }
      }
    },
    flush,
    stop(): void {
      if (stopped) return;
      flush();
      stopped = true;
    },
  };
}
