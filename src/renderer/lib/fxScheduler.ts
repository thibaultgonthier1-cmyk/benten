import type { MotionLevel } from "./motionLevel";

/**
 * Ordonnanceur des effets superposés (onde de pincement, voile d'encre, éclats d'or, ondes) :
 * au plus `max` effets vivants (2 par défaut, spec §6). Plein, le PLUS ANCIEN est lâché et la
 * nouvelle demande acceptée — jamais de file d'attente : un spam de lecture/pause ne fait pas
 * rejouer une traîne d'effets en retard. Niveau « none » (Réduit) : `request` renvoie `null`.
 *
 * Store minimal compatible `useSyncExternalStore` : `active()` renvoie le même tableau tant que
 * rien ne change, `subscribe` notifie à chaque ajout/retrait.
 */

export type FxKind = "pluck" | "inkVeil" | "goldFlakes" | "ripple";

export interface FxTicket {
  id: number;
  kind: FxKind;
  /** Centre de l'effet, coordonnées viewport (px). */
  at: { x: number; y: number };
  /** Sobre : effet joué à opacité réduite. */
  dim: boolean;
  /** Taille d'affichage souhaitée (px, côté ou largeur selon l'effet) ; défaut propre à l'effet. */
  size?: number;
}

export interface FxScheduler {
  request(kind: FxKind, at: { x: number; y: number }, fx?: MotionLevel["fx"], size?: number): FxTicket | null;
  release(id: number): void;
  active(): FxTicket[];
  subscribe(listener: () => void): () => void;
}

export function createFxScheduler(max = 2): FxScheduler {
  const cap = Math.max(1, Math.floor(max));
  let tickets: FxTicket[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };

  return {
    request(kind, at, fx = "full", size) {
      if (fx === "none") return null;
      const ticket: FxTicket = { id: nextId++, kind, at: { x: at.x, y: at.y }, dim: fx === "dim" };
      if (size !== undefined && size > 0) ticket.size = size;
      const kept = tickets.length >= cap ? tickets.slice(tickets.length - cap + 1) : tickets;
      tickets = [...kept, ticket];
      emit();
      return ticket;
    },
    release(id) {
      if (!tickets.some((t) => t.id === id)) return;
      tickets = tickets.filter((t) => t.id !== id);
      emit();
    },
    active() {
      return tickets;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
