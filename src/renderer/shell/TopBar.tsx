import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { uiStore, useUi } from "../state/ui";
import { libraryStore, useLibrary } from "../state/library";
import { IconButton, ICON_STROKE } from "../ui/IconButton";

export interface TopBarProps {
  /** Vrai quand le contenu a défilé : un filet sépare alors la barre du contenu. */
  scrolled?: boolean;
  /** Emplacement d'actions (à droite). */
  actions?: ReactNode;
}

/**
 * Barre du haut : précédent / suivant (désactivés selon l'historique), champ de recherche (le focus
 * ouvre la page Recherche ; la frappe alimente la recherche anti-rebondée du store bibliothèque)
 * et emplacement d'actions.
 */
export function TopBar({ scrolled = false, actions }: TopBarProps): JSX.Element {
  const canBack = useUi((s) => s.past.length > 0);
  const canForward = useUi((s) => s.future.length > 0);
  const query = useLibrary((s) => s.query);
  const inputRef = useRef<HTMLInputElement>(null);

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
          onFocus={openSearch}
          onChange={(e) => {
            libraryStore.getState().setQuery(e.target.value);
            openSearch();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              libraryStore.getState().setQuery("");
              inputRef.current?.blur();
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
