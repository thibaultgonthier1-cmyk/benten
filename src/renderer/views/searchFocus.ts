/**
 * Passage clavier champ de recherche ↔ résultats (module sans composant : le champ de la barre du
 * haut l'importe sans casser le Fast Refresh de la page Recherche).
 */

/**
 * ↓ dans le champ de recherche : focus sur le premier résultat (le meilleur résultat). Faux s'il n'y
 * en a pas (le champ garde le focus).
 */
export function focusFirstSearchResult(): boolean {
  const el = document.querySelector<HTMLElement>("[data-search-first]");
  if (!el) return false;
  el.focus();
  return true;
}

/** Retour au champ (↑ depuis le meilleur résultat). */
export function focusSearchField(): void {
  document.querySelector<HTMLInputElement>(".shell-top input[type='search']")?.focus();
}
