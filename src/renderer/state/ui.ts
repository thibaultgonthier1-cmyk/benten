import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { AlbumSort, SortDir, TrackSortKey } from "../lib/viewModels";

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

/** Préférences de la grille d'albums (tri + filtre « Sans perte »), conservées entre les pages. */
export interface AlbumsViewPrefs {
  sort: AlbumSort;
  losslessOnly: boolean;
}

export const DEFAULT_ALBUMS_VIEW: AlbumsViewPrefs = { sort: "added", losslessOnly: false };

/** Tri de la vue Titres, conservé entre les pages pendant la session. */
export interface TracksViewPrefs {
  sort: TrackSortKey;
  dir: SortDir;
}

/** Défaut : « Ajouté », du plus ancien au plus récent (ordre de la playlist Apple de l'utilisateur). */
export const DEFAULT_TRACKS_VIEW: TracksViewPrefs = { sort: "added", dir: "asc" };

/** Nombre max d'entrées conservées dans `past` (les plus anciennes sont abandonnées). */
export const HISTORY_LIMIT = 100;

export interface UiState {
  route: Route;
  past: Route[];
  future: Route[];
  compact: boolean;
  shortcutsHelpOpen: boolean;
  /**
   * Demande ponctuelle « créer une playlist » (bouton + de la barre latérale) : la vue Playlists
   * focalise son champ de création puis la consomme (`consumePlaylistCreate`).
   */
  playlistCreateRequested: boolean;
  /** Tri / filtre de la grille d'albums (le filtre Favoris, lui, est porté par la route). */
  albumsView: AlbumsViewPrefs;
  tracksView: TracksViewPrefs;
  /** Vue Titres regroupée : ids des leads dont les versions sont dépliées (mémoire de session). */
  tracksExpanded: ReadonlySet<number>;
  /** Pousse la route courante dans `past`, vide `future` ; ignore une route identique. */
  navigate(route: Route): void;
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
  setCompact(on: boolean): void;
  setShortcutsHelpOpen(on: boolean): void;
  /** Ouvre la page Playlists et demande le focus du champ de création. */
  requestPlaylistCreate(): void;
  /** Vrai (une seule fois) si une création était demandée ; remet la demande à zéro. */
  consumePlaylistCreate(): boolean;
  setAlbumsView(patch: Partial<AlbumsViewPrefs>): void;
  /**
   * Clic sur un en-tête de colonne : même colonne → inverse le sens ; autre colonne → tri
   * croissant sur celle-ci.
   */
  sortTracksBy(key: TrackSortKey): void;
  /** Déplie / replie les versions du groupe dont `leadId` est le lead. */
  toggleTracksExpanded(leadId: number): void;
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
    playlistCreateRequested: false,
    albumsView: DEFAULT_ALBUMS_VIEW,
    tracksView: DEFAULT_TRACKS_VIEW,
    tracksExpanded: new Set<number>(),

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

    requestPlaylistCreate() {
      get().navigate({ name: "playlists" });
      set({ playlistCreateRequested: true });
    },

    consumePlaylistCreate() {
      if (!get().playlistCreateRequested) return false;
      set({ playlistCreateRequested: false });
      return true;
    },

    setAlbumsView(patch) {
      set({ albumsView: { ...get().albumsView, ...patch } });
    },

    sortTracksBy(key) {
      const { sort, dir } = get().tracksView;
      set({ tracksView: sort === key ? { sort, dir: dir === "asc" ? "desc" : "asc" } : { sort: key, dir: "asc" } });
    },

    toggleTracksExpanded(leadId) {
      const next = new Set(get().tracksExpanded);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      set({ tracksExpanded: next });
    },
  }));
}

/** Store singleton de l'application. */
export const uiStore: UiStore = createUiStore();

/**
 * Pont de vérification DEV-ONLY : attache `ui` à `window.__benten` en FUSIONNANT avec l'objet
 * existant (le runtime audio y pose engine/store/… et fusionne lui aussi). Vit ici, et non dans
 * le runtime audio, pour qu'un rechargement HMR de ce module ne dispose jamais le runtime.
 */
export function attachUiDevBridge(
  target: { __benten?: unknown } | undefined,
  store: UiStore = uiStore,
): void {
  if (!target) return;
  const prev = (target.__benten ?? {}) as Record<string, unknown>;
  target.__benten = { ...prev, ui: store };
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  attachUiDevBridge(window as Window & { __benten?: unknown });
}

/** Hook React sélecteur sur le store singleton. */
export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector);
}
