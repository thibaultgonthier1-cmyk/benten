import { createStore, type StoreApi } from "zustand/vanilla";
import type { LucideIcon } from "lucide-react";

/**
 * Store des toasts (Phase 3, Tâche 4) — pur, sans React, testable aux faux minuteurs. L'hôte
 * `<ToastHost>` (Toast.tsx) le rend en pile animée en bas à droite.
 *
 * Au plus `TOAST_MAX` toasts : le plus récent l'emporte, le plus ancien sort (et son minuteur est
 * annulé). Chaque toast expire après `durationMs` (défaut 2600 ms) ; le survol le met en pause et
 * la sortie du survol repart du temps restant (lecture confortable d'un toast à action).
 */

export const TOAST_DEFAULT_MS = 2600;
export const TOAST_MAX = 3;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  icon?: LucideIcon;
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  icon?: LucideIcon;
  action?: ToastAction;
  durationMs: number;
}

export interface ToastState {
  toasts: ToastItem[];
  push(message: string, opts?: ToastOptions): number;
  dismiss(id: number): void;
  /** Suspend l'expiration (survol / focus). */
  pause(id: number): void;
  /** Reprend l'expiration avec le temps restant. */
  resume(id: number): void;
  clear(): void;
}

export type ToastStore = StoreApi<ToastState>;

interface TimerEntry {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

export function createToastStore(): ToastStore {
  let nextId = 1;
  const timers = new Map<number, TimerEntry>();

  const stopTimer = (id: number): void => {
    const t = timers.get(id);
    if (t?.handle) clearTimeout(t.handle);
    timers.delete(id);
  };

  return createStore<ToastState>((set, get) => {
    const arm = (id: number, ms: number): void => {
      const handle = setTimeout(() => get().dismiss(id), ms);
      timers.set(id, { handle, remaining: ms, startedAt: Date.now() });
    };

    return {
      toasts: [],

      push(message, opts = {}) {
        const id = nextId++;
        const durationMs =
          typeof opts.durationMs === "number" && opts.durationMs > 0 ? opts.durationMs : TOAST_DEFAULT_MS;
        const item: ToastItem = { id, message, icon: opts.icon, action: opts.action, durationMs };
        const next = [...get().toasts, item];
        while (next.length > TOAST_MAX) {
          const evicted = next.shift()!;
          stopTimer(evicted.id);
        }
        set({ toasts: next });
        arm(id, durationMs);
        return id;
      },

      dismiss(id) {
        stopTimer(id);
        const { toasts } = get();
        if (!toasts.some((t) => t.id === id)) return;
        set({ toasts: toasts.filter((t) => t.id !== id) });
      },

      pause(id) {
        const t = timers.get(id);
        if (!t || t.handle === null) return;
        clearTimeout(t.handle);
        t.handle = null;
        t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
      },

      resume(id) {
        const t = timers.get(id);
        if (!t || t.handle !== null) return;
        arm(id, t.remaining);
      },

      clear() {
        for (const id of [...timers.keys()]) stopTimer(id);
        set({ toasts: [] });
      },
    };
  });
}

/** Store singleton de l'application. */
export const toastStore: ToastStore = createToastStore();

/** Longueur max (caractères) d'un nom cité dans un toast. */
export const TOAST_NAME_MAX = 30;

/**
 * Nom cité dans un toast (« … »), raccourci au besoin : c'est le NOM qui s'ellipse, jamais le verbe
 * qui suit (« … sera lu ensuite » reste lisible même pour un titre d'album à rallonge).
 */
export function quoted(name: string, max = TOAST_NAME_MAX): string {
  const n = name.trim();
  const short = n.length > max ? `${n.slice(0, max - 1).trimEnd()}…` : n;
  return `« ${short} »`;
}

/** Affiche un toast de confirmation ; renvoie son id (pour `toastStore.getState().dismiss`). */
export function toast(message: string, opts?: ToastOptions): number {
  return toastStore.getState().push(message, opts);
}
