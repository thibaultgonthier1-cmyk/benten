import type { PlayerControls } from "../components/controls";
import type { DiagEntry } from "../../shared/diagnostics";

/**
 * Origine des commandes de transport (diagnostic « ça se met en pause tout seul ») : chaque
 * demande lecture / pause / bascule / suivant / précédent / saut est consignée dans le journal
 * audio (`{kind:"engine", event:"command", cmd, origin}`) AVANT d'être exécutée.
 *
 * OBSERVATION SEULE : l'enveloppe délègue chaque appel tel quel, ses erreurs de journal sont
 * avalées, et aucun comportement de lecture ne change. Le journal actif est celui du runtime audio
 * (`setCommandJournal`, branché sur `createDiagnosticsSink`).
 */

export type CommandOrigin = "ui" | "shortcut" | "media-session" | "system";
export type TransportCmd = "play" | "pause" | "toggle" | "next" | "prev" | "seek" | "jump";

type Journal = (entry: DiagEntry) => void;
let active: Journal | null = null;

/** Branche (ou retire, `null`) le journal des commandes ; renvoie le précédent. */
export function setCommandJournal(journal: Journal | null): Journal | null {
  const prev = active;
  active = journal;
  return prev;
}

/** Le journal actif est-il `journal` ? (le runtime ne retire que le sien). */
export function isCommandJournal(journal: Journal): boolean {
  return active === journal;
}

export function commandEntry(cmd: TransportCmd, origin: CommandOrigin, extra: Record<string, unknown> = {}): DiagEntry {
  return { t: new Date().toISOString(), kind: "engine", event: "command", cmd, origin, ...extra };
}

/** Consigne une commande (best-effort : sans journal, ou s'il lève, rien ne se passe). */
export function journalCommand(cmd: TransportCmd, origin: CommandOrigin, extra?: Record<string, unknown>): void {
  if (!active) return;
  try {
    active(commandEntry(cmd, origin, extra));
  } catch {
    /* journal best-effort : jamais d'effet sur la lecture */
  }
}

/** Saut vers la piste `index` de la file (panneau File d'attente), consigné puis exécuté tel quel. */
export function jumpWithOrigin(
  store: { getState(): { status: string; jumpTo(index: number): void } },
  index: number,
  origin: CommandOrigin,
): void {
  const s = store.getState();
  journalCommand("jump", origin, { status: s.status, index });
  s.jumpTo(index);
}

let quietDepth = 0;

/**
 * Exécute `fn` (synchrone) sans que les commandes étiquetées ne consignent : l'appelant a déjà
 * consigné la commande avec plus de détails (session média : `action`, `noop`).
 */
export function alreadyJournaled<T>(fn: () => T): T {
  quietDepth++;
  try {
    return fn();
  } finally {
    quietDepth--;
  }
}

/** Commandes d'origine des commandes étiquetées (une ré-étiquette n'empile pas deux entrées). */
const RAW = Symbol("rawControls");
type Tagged = PlayerControls & { [RAW]?: PlayerControls };

/** Intention d'une bascule selon le statut courant. */
const toggleIntent = (status: string | undefined): "pause" | "play" | undefined =>
  status === undefined ? undefined : status === "playing" ? "pause" : "play";

/**
 * Enveloppe `controls` : chaque appel est consigné avec `origin` (et le statut courant si
 * `getStatus` est fourni), puis délégué À L'IDENTIQUE aux commandes d'origine.
 */
export function withOrigin(
  controls: PlayerControls,
  origin: CommandOrigin,
  opts: { getStatus?: () => string } = {},
): PlayerControls {
  const raw = (controls as Tagged)[RAW] ?? controls;
  const status = (): Record<string, unknown> => {
    if (!opts.getStatus) return {};
    try {
      return { status: opts.getStatus() };
    } catch {
      return {};
    }
  };
  // Sous `alreadyJournaled` (la session média a consigné elle-même) : pas de seconde entrée.
  const log = (cmd: TransportCmd, extra: Record<string, unknown>): void => {
    if (quietDepth === 0) journalCommand(cmd, origin, extra);
  };
  const tagged: Tagged = {
    playAlbum(album, index) {
      log("play", { ...status(), albumId: album.id, index: index ?? 0, queueLen: album.tracks.length });
      raw.playAlbum(album, index);
    },
    playTracks(tracks, index) {
      // Aléatoire total / file arbitraire : même entrée de journal qu'un album, sans identifiant.
      log("play", { ...status(), albumId: null, index: index ?? 0, queueLen: tracks.length });
      raw.playTracks(tracks, index);
    },
    toggle() {
      const s = status();
      log("toggle", { ...s, intent: toggleIntent(s["status"] as string | undefined) });
      raw.toggle();
    },
    next() {
      log("next", status());
      raw.next();
    },
    prev() {
      log("prev", status());
      raw.prev();
    },
    seekFraction(fraction) {
      log("seek", { ...status(), fraction: Number.isFinite(fraction) ? Number(fraction.toFixed(4)) : null });
      raw.seekFraction(fraction);
    },
  };
  tagged[RAW] = raw;
  return tagged;
}

