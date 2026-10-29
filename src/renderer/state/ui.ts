import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * Store UI (Phase 3, Tâche 3) : routeur maison — route courante + historique précédent/suivant —
 * et petits états d'interface (mode compact, aide des raccourcis). Aucune dépendance de routage
 * externe : une route est une simple valeur discriminée par `name`.
 *
 * Store vanilla (testable hors React, exposé au pont dev `window.__benten.ui`) + hook `useUi(sel)`.
 */

export type Route =
  | { name: "home" }
  | { name: "tracks" }
  | { name: "albums" }
  | { name: "album"; id: number }
  | { name: "artists" }
  // Le paramètre ne peut pas s'appeler `name` : c'est déjà le discriminant de la route.
  | { name: "artist"; artist: string }
  | { name: "playlists" }
  | { name: "playlist"; id: number }
  | { name: "favorites" }
  | { name: "search"; q: string }
  | { name: "downloads" }
  | { name: "settings" };

export type RouteName = Route["name"];

/** Entrées de la barre latérale (une page de détail se rattache à sa liste). */
export type NavSection =
  | "home"
  | "tracks"
  | "albums"
  | "artists"
  | "playlists"
  | "favorites"
  | "downloads"
  | "settings";

/** Nombre max d'entrées conservées dans `past` (les plus anciennes sont abandonnées). */
export const HISTORY_LIMIT = 100;

export interface UiState {
  route: Route;
  past: Route[];
  future: Route[];
  compact: boolean;
  shortcutsHelpOpen: boolean;
  /** Pousse la route courante dans `past`, vide `future` ; ignore une route identique. */
  navigate(route: Route): void;
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
  setCompact(on: boolean): void;
  setShortcutsHelpOpen(on: boolean): void;
}

/** Égalité de routes : même nom ET mêmes paramètres. */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  switch (a.name) {
    case "album":
    case "playlist":
      return a.id === (b as typeof a).id;
    case "artist":
      return a.artist === (b as typeof a).artist;
    case "search":
      return a.q === (b as typeof a).q;
    default:
      return true;
  }
}

/**
 * Clé d'identité d'une page (clé React de la transition) : deux albums différents sont deux pages ;
 * la recherche reste UNE page quel que soit le terme (la frappe ne rejoue pas la transition).
 */
export function routeKey(route: Route): string {
  switch (route.name) {
    case "album":
    case "playlist":
      return `${route.name}:${route.id}`;
    case "artist":
      return `artist:${route.artist}`;
    default:
      return route.name;
  }
}

/** Entrée de barre latérale active pour une route (`null` : aucune, ex. la recherche). */
export function navSectionOf(route: Route): NavSection | null {
  switch (route.name) {
    case "album":
      return "albums";
    case "artist":
      return "artists";
    case "playlist":
      return "playlists";
    case "search":
      return null;
    default:
      return route.name;
  }
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(initial: Route = { name: "home" }): UiStore {
  return createStore<UiState>((set, get) => ({
    route: initial,
    past: [],
    future: [],
    compact: false,
    shortcutsHelpOpen: false,

    navigate(route) {
      const { route: current, past } = get();
      if (sameRoute(current, route)) return;
      const nextPast = [...past, current];
      if (nextPast.length > HISTORY_LIMIT) nextPast.splice(0, nextPast.length - HISTORY_LIMIT);
      set({ route, past: nextPast, future: [] });
    },

    back() {
      const { route, past, future } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1]!;
      set({ route: prev, past: past.slice(0, -1), future: [route, ...future] });
    },

    forward() {
      const { route, past, future } = get();
      if (future.length === 0) return;
      const [next, ...rest] = future;
      set({ route: next!, past: [...past, route], future: rest });
    },

    canBack() {
      return get().past.length > 0;
    },

    canForward() {
      return get().future.length > 0;
    },

    setCompact(on) {
      set({ compact: on === true });
    },

    setShortcutsHelpOpen(on) {
      set({ shortcutsHelpOpen: on === true });
    },
  }));
}

/** Store singleton de l'application. */
export const uiStore: UiStore = createUiStore();

/** Hook React sélecteur sur le store singleton. */
export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector);
}
