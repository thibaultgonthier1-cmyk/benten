import type { UiStore } from "./ui";

/**
 * Terme de recherche ↔ route `search` (carry-forward g). La route porte le terme (`route.q`) :
 * précédent / suivant rendent au champ le terme de la page Recherche qu'ils rouvrent ; la frappe
 * met la route à jour par REMPLACEMENT (aucune entrée d'historique par touche).
 */

/** Ce que la synchronisation lit / écrit dans le store bibliothèque (testable sans IPC). */
export interface SearchQueryHost {
  getState(): { query: string; setQuery(q: string): void };
}

/**
 * Synchronise le store bibliothèque sur la route : arriver sur (ou revenir à) une page Recherche
 * pose son terme ; la quitter vide le champ (pas de texte périmé au-dessus d'une autre page).
 * Renvoie le désabonnement.
 */
export function bindSearchQuery(ui: UiStore, library: SearchQueryHost): () => void {
  return ui.subscribe((next, prev) => {
    if (next.route === prev.route) return;
    const lib = library.getState();
    if (next.route.name === "search") {
      if (lib.query !== next.route.q) lib.setQuery(next.route.q);
    } else if (prev.route.name === "search" && lib.query !== "") {
      lib.setQuery("");
    }
  });
}

/**
 * Frappe dans la barre du haut : met à jour le terme, puis ouvre la page Recherche (UNE entrée
 * d'historique) ou, déjà dessus, remplace sa route.
 */
export function typeSearch(q: string, ui: UiStore, library: SearchQueryHost): void {
  library.getState().setQuery(q);
  const s = ui.getState();
  if (s.route.name === "search") s.replace({ name: "search", q });
  else s.navigate({ name: "search", q });
}

/**
 * Échap / bouton « effacer » : vide le terme ; sur la page Recherche, sa route suit (remplacement,
 * aucune entrée d'historique).
 */
export function clearSearch(ui: UiStore, library: SearchQueryHost): void {
  library.getState().setQuery("");
  const s = ui.getState();
  if (s.route.name === "search") s.replace({ name: "search", q: "" });
}
