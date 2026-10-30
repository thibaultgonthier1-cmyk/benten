import type { StoreApi } from "zustand/vanilla";

/**
 * Échecs de LECTURE signalés à l'utilisateur (revue Tâche 9) : quand la bibliothèque ou la liste
 * des playlists passe en erreur, un toast l'annonce — une fois par série d'échecs (pas à chaque
 * nouvel essai). Les vues, elles, affichent un état d'erreur (jamais un « vide » trompeur).
 */

export interface ErrorToastDeps {
  library: StoreApi<{ loadError: boolean }>;
  playlists: StoreApi<{ error: boolean }>;
  toast(message: string): void;
}

/** Branche les toasts d'erreur ; renvoie le désabonnement. */
export function bindErrorToasts({ library, playlists, toast }: ErrorToastDeps): () => void {
  const offLibrary = library.subscribe((next, prev) => {
    if (next.loadError && !prev.loadError) toast("Impossible de charger la bibliothèque");
  });
  const offPlaylists = playlists.subscribe((next, prev) => {
    if (next.error && !prev.error) toast("Impossible de charger les playlists");
  });
  return () => {
    offLibrary();
    offPlaylists();
  };
}
