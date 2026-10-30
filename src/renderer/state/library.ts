import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { groupTracksToAlbums, type Album } from "../lib/library";
import { searchLibrary } from "../lib/viewModels";
import type { BentenApi, SourceRow, TrackRow } from "../../shared/types";

/**
 * Données de bibliothèque (Phase 3, Tâche 2) — extraites d'`App.tsx` SANS changement de logique :
 * chargement paginé de toutes les pistes (liste plate `tracks` + regroupement `albums`), racines
 * persistées (`sources`), indexation (`scan` / `pickFolderAndScan`), veille de dossiers
 * (`subscribeLibraryChanged`) et recherche anti-rebondée (`setQuery`).
 *
 * Store vanilla (testable hors React) + hook `useLibrary(sel)` pour les composants. L'API IPC est
 * résolue à chaque usage (`window.benten` par défaut) ; rien n'est lu au chargement du module.
 */

const PAGE = 1000;
/** Anti-rebond de la barre de recherche (ms) : une frappe rapide ne lance qu'une requete. */
const SEARCH_DEBOUNCE_MS = 150;

export interface LibraryState {
  /** Toutes les pistes (liste plate, ordre de la requête « tracks »). */
  tracks: TrackRow[];
  /** Les mêmes pistes regroupées en albums. */
  albums: Album[];
  loading: boolean;
  /** Le dernier chargement des pistes a échoué (état d'erreur, jamais une bibliothèque « vide »). */
  loadError: boolean;
  /** Racines persistées (Task 5) : raccourcis de ré-indexation sur l'écran d'accueil. */
  sources: SourceRow[];
  scanning: boolean;
  scanMsg: string | null;
  /** Terme de recherche tel que saisi. */
  query: string;
  results: TrackRow[];
  /**
   * `true` seulement quand une recherche a abouti pour le terme courant : empeche le clignotement
   * de « aucun resultat » pendant l'anti-rebond, avant que la premiere reponse ne soit arrivee.
   */
  searched: boolean;
  /** Terme (nettoyé) auquel correspondent `results` ; `""` quand il n'y en a pas. */
  resultsFor: string;

  /** Charge TOUTES les pistes (pagine) puis les regroupe en albums. */
  reload(): Promise<void>;
  /** Racines persistées : chargées au démarrage et après chaque scan (une source peut s'ajouter). */
  refreshSources(): Promise<void>;
  /** Indexe `path` (ignoré si vide ou si un scan est en cours), recharge, rafraîchit les sources. */
  scan(path: string): Promise<void>;
  /**
   * Selecteur de dossier natif (process Main) puis indexation. `onPicked` reçoit le chemin choisi
   * AVANT le scan (l'App le reporte dans son champ de saisie).
   */
  pickFolderAndScan(onPicked?: (path: string) => void): Promise<void>;
  /**
   * Recherche avec anti-rebond (150 ms), LOCALE sur `tracks` (`searchLibrary` : accents et casse
   * Unicode repliés, classement puis limite). Un terme remplacé avant l'échéance est ignoré ; tant
   * que les pistes ne sont pas chargées (ou si leur chargement a échoué), rien n'est conclu.
   */
  setQuery(q: string): void;
  /** Abonnement au push « library:changed » (recharge la grille). Renvoie le désabonnement. */
  subscribeLibraryChanged(): () => void;
}

/** Pont IPC par défaut : `window.benten` (absent hors fenêtre — tests node). */
function windowApi(): BentenApi | undefined {
  return typeof window !== "undefined" ? window.benten : undefined;
}

export type LibraryStore = StoreApi<LibraryState>;

export function createLibraryStore(
  getApi: () => BentenApi | undefined = windowApi,
): LibraryStore {
  /** Accès direct (même sémantique que `window.benten.*` dans l'ancien App). */
  const api = (): BentenApi => getApi() as BentenApi;

  /** Charge TOUTES les pistes (pagine). */
  async function fetchAllTracks(): Promise<TrackRow[]> {
    const all: TrackRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await api().library.query({ view: "tracks", limit: PAGE, offset });
      const rows = res.rows as TrackRow[];
      all.push(...rows);
      if (rows.length < PAGE) break;
    }
    return all;
  }

  // Annule la recherche en attente / en vol (équivalent du cleanup de l'ancien effet `[query]`).
  let cancelSearch: (() => void) | null = null;
  // Dernière réponse reçue : revenir à ce terme (« Précédent » vers la Recherche) la rend aussitôt.
  let lastSearch: { q: string; rows: TrackRow[] } | null = null;
  // Une recherche attend son échéance (anti-rebond) : le rechargement la laisse faire.
  let searchPending = false;

  // Assigné à la création du store (a besoin de `get` / `set`).
  let runSearch: (q: string) => void = () => {};

  return createStore<LibraryState>((set, get) => {
    runSearch = (q) => {
      const { tracks, loading, loadError } = get();
      // Pistes pas encore là, ou chargement en échec : on ne conclut rien (ni « aucun résultat »).
      if (loadError || (loading && tracks.length === 0)) return;
      const rows = searchLibrary(tracks, q);
      lastSearch = { q, rows };
      set({ results: rows, searched: true, resultsFor: q });
    };
    return {
      tracks: [],
      albums: [],
      loading: true,
      loadError: false,
      sources: [],
      scanning: false,
      scanMsg: null,
      query: "",
      results: [],
      searched: false,
      resultsFor: "",

      async reload() {
        set({ loading: true });
        try {
          const tracks = await fetchAllTracks();
          set({ tracks, albums: groupTracksToAlbums(tracks), loadError: false, loading: false });
        } catch {
          // Erreur signalée (état + toast via `bindErrorToasts`), jamais une bibliothèque vide.
          set({ loadError: true, loading: false });
          return;
        }
        // Recherche en cours sur des pistes qui viennent d'arriver (ou de changer) : on la (re)fait.
        const q = get().query.trim();
        if (q && !searchPending) runSearch(q);
      },

      async refreshSources() {
        try {
          set({ sources: await api().sources.list() });
        } catch {
          /* best-effort : l'absence de sources ne bloque pas l'écran d'accueil. */
        }
      },

      async scan(pathArg) {
        const path = pathArg.trim();
        if (!path || get().scanning) return;
        set({ scanning: true, scanMsg: "Analyse en cours…" });
        try {
          const summary = await api().library.scan([path]);
          set({ scanMsg: `Indexation : ${summary.added} ajoutes, ${summary.skipped} ignores.` });
          await get().reload();
          // La racine scannée devient une source persistée : on rafraîchit la liste des raccourcis.
          try {
            set({ sources: await api().sources.list() });
          } catch {
            /* best-effort */
          }
        } catch (err) {
          set({ scanMsg: `Echec : ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          set({ scanning: false });
        }
      },

      async pickFolderAndScan(onPicked) {
        if (get().scanning) return;
        try {
          const path = await api().dialog.pickFolder();
          if (path) {
            onPicked?.(path);
            await get().scan(path);
          }
        } catch (err) {
          set({ scanMsg: `Echec : ${err instanceof Error ? err.message : String(err)}` });
        }
      },

      // Recherche avec anti-rebond : terme vide -> on vide les resultats sans interroger. Un drapeau
      // `cancelled` ignore une reponse qui arrive apres un nouveau terme (course de frappe rapide).
      setQuery(query) {
        if (query === get().query) return; // même terme : rien ne change (comme l'effet `[query]`)
        cancelSearch?.();
        cancelSearch = null;
        const q = query.trim();
        if (!q) {
          set({ query, results: [], searched: false, resultsFor: "" });
          return;
        }
        if (lastSearch && lastSearch.q === q) {
          // Terme déjà résolu : résultats rendus tout de suite (aucun squelette), puis rafraîchis.
          set({ query, results: lastSearch.rows, searched: true, resultsFor: q });
        } else {
          // Nouveau terme : la recherche n'a pas encore abouti -> on masque la note « aucun resultat »
          // jusqu'a la reponse (pas de clignotement du vide pendant l'anti-rebond).
          set({ query, searched: false });
        }
        let cancelled = false;
        searchPending = true;
        const id = setTimeout(() => {
          searchPending = false;
          if (cancelled) return;
          runSearch(q);
        }, SEARCH_DEBOUNCE_MS);
        cancelSearch = () => {
          cancelled = true;
          searchPending = false;
          clearTimeout(id);
        };
      },

      // Veille de dossiers (Task 14B) : à chaque lot de re-scan incrémental côté Main, on re-interroge
      // la DB pour rafraîchir la grille. CRUCIAL : on ne touche PAS au moteur/à la file — la lecture
      // continue sans interruption ; seule la liste d'albums est re-fetchée.
      subscribeLibraryChanged() {
        const subscribe = getApi()?.onLibraryChanged;
        if (!subscribe) return () => {}; // hors fenêtre (tests) : no-op.
        return subscribe(() => {
          void get().reload();
        });
      },
    };
  });
}

/** Store singleton de l'application. */
export const libraryStore: LibraryStore = createLibraryStore();

/** Hook React sélecteur sur le store singleton. */
export function useLibrary<T>(selector: (state: LibraryState) => T): T {
  return useStore(libraryStore, selector);
}
