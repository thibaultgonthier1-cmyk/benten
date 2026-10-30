import { AudioEngine, qualitySampleRate } from "../audio/engine";
import { NativeDecoder, type Decoder } from "../audio/decoder";
import { AUDIO_LATENCY_HINT, createAudioContext } from "../audio/context";
import {
  createDiagnosticsSink,
  startAudioDiagnostics,
  type AudioDiagnosticsDeps,
  type AudioDiagnosticsHandle,
} from "../audio/diagnostics";
import { bindEngine, playerStore, type PlayerState } from "../state/player";
import { libraryStore } from "../state/library";
import { createControls, type PlayerControls } from "../components/controls";
import { bindMediaSession } from "./mediaSession";
import { makeThrottle } from "../lib/throttle";
import { restoreState, serializeState } from "../lib/persist";
import type { QualityMode } from "../../shared/types";
import type { DiagEntry } from "../../shared/diagnostics";
import { isCommandJournal, setCommandJournal, withOrigin } from "./transportJournal";

/** Clé `app_state` sous laquelle l'état de lecture est persisté. */
export const PLAYER_STATE_KEY = "player";
/** Anti-rebond de la sauvegarde d'état (ms) : les changements structurels sont coalescés. */
const SAVE_DEBOUNCE_MS = 1000;
/** Throttle de sauvegarde de la position de lecture (ms) : on ne persiste pas chaque frame rAF. */
const SAVE_POSITION_THROTTLE_MS = 5000;

/** Fabriques injectables (tests node : aucun vrai Web Audio ni rAF). */
export interface AudioRuntimeDeps {
  createContext?: (opts?: AudioContextOptions) => AudioContext;
  createDecoder?: (ctx: AudioContext) => Decoder;
  raf?: typeof requestAnimationFrame;
  caf?: typeof cancelAnimationFrame;
  /** Demarrage du journal audio (defaut `startAudioDiagnostics`). */
  startDiagnostics?: (deps: AudioDiagnosticsDeps) => AudioDiagnosticsHandle;
}

export interface AudioRuntime {
  engine: AudioEngine;
  controls: PlayerControls;
  /**
   * Arrête la boucle, détache le store, sauvegarde une dernière fois. Idempotent. `closeContext`
   * ferme aussi l'`AudioContext` courant (remplacement du runtime au HMR : jamais deux contextes
   * vivants) ; sans lui, le contexte reste ouvert comme dans l'ancien nettoyage de l'App.
   */
  dispose(opts?: { closeContext?: boolean }): void;
}

/**
 * Fabrique par defaut : TOUJOURS `createAudioContext` (`latencyHint: "playback"`), au demarrage
 * comme a la reconstruction de qualite (`sampleRate` du mode ; frequence refusee : repli au
 * defaut, toujours en "playback").
 */
const defaultCreateContext = (opts?: AudioContextOptions): AudioContext =>
  createAudioContext(opts?.sampleRate);
const defaultCreateDecoder = (ctx: AudioContext): Decoder => new NativeDecoder(ctx);
const defaultRaf: typeof requestAnimationFrame = (cb) => requestAnimationFrame(cb);
const defaultCaf: typeof cancelAnimationFrame = (id) => cancelAnimationFrame(id);

/** `window` si présent (absent en tests node). */
const win = (): (Window & { __benten?: unknown }) | undefined =>
  typeof window !== "undefined" ? (window as Window & { __benten?: unknown }) : undefined;

/**
 * Runtime audio de l'application : UN SEUL moteur (AudioContext reel + NativeDecoder), branche sur
 * le store de lecture, pompe par une boucle rAF unique. Logique deplacee telle quelle depuis
 * l'effet d'`App.tsx` (Phase 3, Tache 2) — l'App doit l'appeler UNE seule fois.
 *
 * Pourquoi pas un effet React : le demarrage cree l'`AudioContext`, or un effet est rejoue
 * (montage -> demontage -> montage) sous StrictMode, et le double rendu initial de React 18
 * re-cree les refs. L'App l'appelle donc pendant le rendu, derriere un singleton de module
 * (`ensureAudioRuntime`, qui gere aussi le HMR) : le runtime est cree exactement une fois et vit
 * aussi longtemps que la page.
 */
export function startAudioRuntime(deps: AudioRuntimeDeps = {}): AudioRuntime {
  const createContext = deps.createContext ?? defaultCreateContext;
  const createDecoder = deps.createDecoder ?? defaultCreateDecoder;
  const requestFrame = deps.raf ?? defaultRaf;
  const cancelFrame = deps.caf ?? defaultCaf;
  const startDiagnostics = deps.startDiagnostics ?? startAudioDiagnostics;

  // UN SEUL moteur (AudioContext reel + NativeDecoder), cree une fois.
  const ctx = createContext();
  const engine = new AudioEngine(ctx, createDecoder(ctx));
  const rawControls = createControls(engine, playerStore);
  // Commandes de l'interface (barre de lecture, en-têtes, lignes, menus) : consignées avec
  // l'origine « ui » dans le journal audio, puis déléguées à l'identique (observation seule). Les
  // raccourcis ré-étiquettent en « shortcut » ; la session média consigne elle-même (avec
  // l'action système) et neutralise l'entrée « ui » de ses appels (`alreadyJournaled`).
  const controls = withOrigin(rawControls, "ui", { getStatus: () => playerStore.getState().status });

  // Branche le store sur le moteur + boucle rAF (pompe tick() et anime la position).
  const unbind = bindEngine(playerStore, engine);
  // Rattache le moteur au store pour les mutations de file A CHAUD (updateQueue / jumpTo).
  playerStore.getState().attachEngine(engine);
  // Touches media + overlay Windows (Phase 3, Tache 4) : la session reflete le store et route les
  // commandes systeme vers `controls` (API de transport existante). No-op sans `navigator.mediaSession`.
  // DEV : la session est enveloppée pour retenir ses gestionnaires (pont `mediaSession.fire`, qui
  // rejoue une action système depuis CDP) ; en production, la vraie session telle quelle.
  const mediaHandlers = new Map<string, MediaSessionActionHandler | null>();
  const realSession =
    typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : undefined;
  const unbindMediaSession = bindMediaSession(
    playerStore,
    controls,
    import.meta.env.DEV && realSession ? recordingSession(realSession, mediaHandlers) : realSession,
  );

  // Recreation PROPRE du contexte au changement de mode (Task 13). Le runtime est le SEUL a creer
  // un `AudioContext` : le store appelle ce gestionnaire, qui fabrique le nouveau contexte a la
  // frequence du mode, demande au moteur de reconstruire son graphe dessus (hors-lecture, en
  // pause, sans clic), PUIS ferme l'ANCIEN contexte — il n'y a donc jamais plus d'UN contexte
  // vivant. L'instance du moteur ne change pas : `window.__benten.engine` reste valide.
  const rebuildForQuality = async (mode: QualityMode): Promise<void> => {
    const oldCtx = engine.getContext();
    const rate = qualitySampleRate(mode, oldCtx.sampleRate);
    let newCtx: AudioContext;
    try {
      newCtx = createContext({ sampleRate: rate });
    } catch {
      newCtx = createContext(); // frequence refusee par la plateforme : repli au defaut
    }
    await engine.rebuildContext(newCtx, createDecoder(newCtx));
    if (oldCtx !== newCtx) {
      void oldCtx.close?.(); // un seul contexte vivant : l'ancien est ferme (pas de fuite)
    }
  };
  playerStore.getState().attachQualityRebuild((mode) => {
    void rebuildForQuality(mode);
  });
  // Pont de verification DEV-ONLY : expose le VRAI moteur + les stores pour piloter/observer le
  // gapless/shuffle/repeat via CDP (Runtime.evaluate). `import.meta.env.DEV` est `false` dans un
  // build de production -> ce pont n'est JAMAIS attache en prod. Nettoye au dispose.
  // FUSION avec un pont existant : `state/ui.ts` y attache `ui` (DEV) indépendamment du runtime.
  const w = win();
  const BRIDGE_KEYS = ["engine", "store", "persist", "library", "mediaSession"] as const;
  if (import.meta.env.DEV && w) {
    w.__benten = {
      ...((w.__benten ?? {}) as Record<string, unknown>),
      engine,
      store: playerStore,
      persist: { serializeState, restoreState },
      library: libraryStore,
      // Rejoue une action de la session média (touche multimédia, overlay Windows) : même chemin
      // que le système, journal compris.
      mediaSession: {
        fire(action: string, details: Partial<MediaSessionActionDetails> = {}): boolean {
          const h = mediaHandlers.get(action);
          if (!h) return false;
          h({ action, ...details } as MediaSessionActionDetails);
          return true;
        },
      },
    };
  }
  // Journal audio (diagnostic des micro-coupures, actif en PRODUCTION) : demarre UNE fois avec le
  // runtime (singleton de page : ni StrictMode ni un HMR de l'App ne le relancent ; un HMR qui
  // remplace le runtime arrete l'ancien journal au dispose AVANT d'en demarrer un nouveau). Il
  // OBSERVE seulement le contexte COURANT (getter : la reconstruction de qualite le remplace) et
  // les transitions du moteur ; n'appelle aucun mutateur, ne cree aucun noeud audio, ses erreurs
  // restent chez lui. Les entrees partent par lots vers le Main (au plus toutes les 2 s,
  // immediatement sur glitch).
  const diagSink = createDiagnosticsSink({
    send: (entries) => win()?.benten?.diagnostics?.append(entries),
  });
  // Origine des commandes de transport → même puits que le reste du journal.
  const commandJournal = (entry: DiagEntry): void => diagSink.append(entry);
  setCommandJournal(commandJournal);
  const w0 = win();
  const diagnostics = startDiagnostics({
    getContext: () => engine.getContext(),
    engine,
    append: diagSink.append,
    latencyHint: AUDIO_LATENCY_HINT,
    mediaDevices: typeof navigator !== "undefined" ? (navigator.mediaDevices ?? null) : null,
    win: w0 && typeof w0.addEventListener === "function" ? w0 : null,
    doc: typeof document !== "undefined" ? document : null,
  });

  let raf = 0;
  // La boucle rAF tourne a la frequence ecran (~60 Hz) mais on ne pompe tick()+setPosition qu'a
  // ~15 Hz (66 ms) via une porte pure pilotee par le timestamp rAF : PRELOAD_LEAD_SEC = 10 s dans
  // le moteur, donc 15 Hz suffit largement aux decisions de preload gapless, sans reveiller React
  // 60x/s. Un seul AudioContext, une seule boucle tick() : on ne change QUE la cadence.
  const gate = makeThrottle(66);
  const loop = (ts: number): void => {
    if (gate(ts)) {
      engine.tick();
      const st = engine.getState();
      if (st.status === "playing") playerStore.getState().setPosition(st.positionSec, st.durationSec);
    }
    raf = requestFrame(loop);
  };
  raf = requestFrame(loop);

  // --- Persistance de l'état (Task 14A) : sauvegarde debouncée + throttle de position. --------
  const persistNow = (): void => {
    const api = win()?.benten?.state;
    if (!api) return; // hors fenêtre (tests) : no-op.
    const s = playerStore.getState();
    const payload = JSON.stringify(
      serializeState({
        queue: s.queue,
        currentIndex: s.currentIndex,
        positionSec: s.positionSec,
        shuffle: s.shuffle,
        repeat: s.repeat,
        volume: s.volume,
        qualityMode: s.qualityMode,
        nowPlayingOpen: s.nowPlayingOpen,
      }),
    );
    void api.set(PLAYER_STATE_KEY, payload).catch(() => {
      /* best-effort : un échec d'écriture ne doit jamais casser la lecture */
    });
  };
  // Signature STRUCTURELLE : tout sauf la position (qui bouge en continu). Un changement ici
  // (file, index, shuffle, repeat, volume, qualité, vue, statut) planifie une sauvegarde
  // debouncée (≥1 s) ; un trailing debounce suffit car ces changements sont discrets, pas rAF.
  const structuralKey = (s: PlayerState): string =>
    [
      s.queue.map((t) => t.id).join(","),
      s.currentIndex,
      s.shuffle,
      s.repeat,
      s.volume,
      s.qualityMode,
      s.nowPlayingOpen,
      s.status,
    ].join("|");
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = structuralKey(playerStore.getState());
  const unsubscribeSave = playerStore.subscribe((s) => {
    const key = structuralKey(s);
    if (key === lastKey) return; // changement de position pure : ignoré ici (voir le throttle).
    lastKey = key;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persistNow();
    }, SAVE_DEBOUNCE_MS);
  });
  // La position avance en continu en lecture : on la persiste à faible cadence (throttle), plutôt
  // qu'une écriture par frame — complète les sauvegardes sur pause / changement de piste ci-dessus.
  const positionSaver = setInterval(() => {
    if (playerStore.getState().status === "playing") persistNow();
  }, SAVE_POSITION_THROTTLE_MS);

  let disposed = false;
  const dispose = (opts?: { closeContext?: boolean }): void => {
    if (disposed) return;
    disposed = true;
    cancelFrame(raf);
    if (isCommandJournal(commandJournal)) setCommandJournal(null); // seulement le sien (HMR)
    diagnostics.stop(); // glitch en attente consigne, puis plus aucun echantillonnage
    diagSink.stop(); // dernier lot envoye au Main
    unbind();
    unbindMediaSession();
    unsubscribeSave();
    if (saveTimer) clearTimeout(saveTimer);
    clearInterval(positionSaver);
    persistNow(); // capture finale (best-effort) de la position
    playerStore.getState().attachEngine(null);
    playerStore.getState().attachQualityRebuild(null);
    // Retire seulement les clés du runtime (le `ui` de state/ui.ts reste) ; objet vide → supprimé.
    const wd = win();
    if (import.meta.env.DEV && wd && wd.__benten) {
      const bridge = wd.__benten as Record<string, unknown>;
      for (const k of BRIDGE_KEYS) delete bridge[k];
      if (Object.keys(bridge).length === 0) delete wd.__benten;
    }
    if (opts?.closeContext) {
      void engine.getContext().close?.(); // un seul contexte vivant : le remplaçant créera le sien
    }
  };

  return { engine, controls, dispose };
}

/**
 * Session média qui retient ses gestionnaires (DEV : pont de vérification) ; tout le reste
 * (métadonnées, état, position) est transmis tel quel à la vraie session.
 */
function recordingSession(
  session: MediaSession,
  handlers: Map<string, MediaSessionActionHandler | null>,
): MediaSession {
  return new Proxy(session, {
    get(target, key) {
      if (key === "setActionHandler") {
        return (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
          handlers.set(action, handler);
          target.setActionHandler(action, handler);
        };
      }
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });
}
