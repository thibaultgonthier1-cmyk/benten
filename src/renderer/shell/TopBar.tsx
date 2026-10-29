import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { uiStore, useUi } from "../state/ui";
import { libraryStore, useLibrary } from "../state/library";
import { IconButton, ICON_STROKE } from "../ui/IconButton";

export interface TopBarProps {
  /** Vrai quand le contenu a défilé : un filet sépare alors la barre du contenu. */
  scrolled?: boolean;
  /** Emplacement d'actions (à droite). */
  actions?: ReactNode;
  /** Ref du champ de recherche (le raccourci Ctrl+F du Shell le focalise). */
  searchRef?: RefObject<HTMLInputElement>;
}

/**
 * Barre du haut : précédent / suivant (désactivés selon l'historique), champ de recherche (un clic
 * ou une saisie ouvre la page Recherche ; la frappe alimente la recherche anti-rebondée du store
 * bibliothèque) et emplacement d'actions.
 *
 * Pas de navigation sur `focus` : quand la fenêtre reprend le focus avec le champ encore focalisé,
 * le navigateur rejoue `focus` et l'on sauterait en silence vers la Recherche.
 */
export function TopBar({ scrolled = false, actions, searchRef }: TopBarProps): JSX.Element {
  const canBack = useUi((s) => s.past.length > 0);
  const canForward = useUi((s) => s.future.length > 0);
  const query = useLibrary((s) => s.query);
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? localRef;

  // Quitter la page Recherche vide le terme : le champ ne garde pas un texte périmé au-dessus d'une
  // grille non filtrée.
  useEffect(
    () =>
      uiStore.subscribe((next, prev) => {
        if (prev.route.name === "search" && next.route.name !== "search") {
          libraryStore.getState().setQuery("");
        }
      }),
    [],
  );

  const openSearch = (): void => {
    const ui = uiStore.getState();
    // Déjà sur la page Recherche : on n'empile pas une nouvelle entrée d'historique.
    if (ui.route.name !== "search") ui.navigate({ name: "search", q: libraryStore.getState().query });
  };

  return (
    <header className={"shell-top" + (scrolled ? " is-scrolled" : "")}>
      <div className="tb-history">
        <IconButton
          label="Précédent"
          icon={ChevronLeft}
          variant="solid"
          size={32}
          disabled={!canBack}
          onClick={() => uiStore.getState().back()}
        />
        <IconButton
          label="Suivant"
          icon={ChevronRight}
          variant="solid"
          size={32}
          disabled={!canForward}
          onClick={() => uiStore.getState().forward()}
        />
      </div>

      <label className="tb-search">
        <Search className="tb-search-icon" size={17} strokeWidth={ICON_STROKE} aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Rechercher un titre, un artiste, un album"
          aria-label="Recherche"
          spellCheck={false}
          autoComplete="off"
          onPointerDown={openSearch}
          onChange={(e) => {
            libraryStore.getState().setQuery(e.target.value);
            openSearch();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Échap est consommée ici (vider + quitter le champ) : le raccourci global « fermer »
              // ne s'y ajoute pas (une touche, un effet).
              e.preventDefault();
              libraryStore.getState().setQuery("");
              inputRef.current?.blur();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              openSearch();
            }
          }}
        />
        {query.length > 0 && (
          <IconButton
            label="Effacer la recherche"
            icon={X}
            size={24}
            className="tb-search-clear"
            onClick={() => {
              libraryStore.getState().setQuery("");
              inputRef.current?.focus();
            }}
          />
        )}
      </label>

      <div className="tb-actions">{actions}</div>
    </header>
  );
}
