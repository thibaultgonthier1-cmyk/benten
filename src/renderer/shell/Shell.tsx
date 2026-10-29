import { useCallback, useRef, useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { RouteView, type RouteViewActions } from "./RouteView";
import "./shell.css";

export interface ShellProps {
  /** Actions de lecture / bibliothèque consommées par les vues (fournies par l'App). */
  views: RouteViewActions;
  /** Barre de lecteur (bas, pleine largeur). */
  player?: ReactNode;
  /** Emplacement d'actions de la barre du haut. */
  topActions?: ReactNode;
}

/**
 * Coquille de l'app : grille barre latérale 248 px / contenu / barre de lecteur 88 px, fond noir
 * uni. Le contenu défile dans `.shell-scroll` (conteneur de défilement des listes virtualisées) ;
 * la barre du haut reste fixe au-dessus et gagne un filet dès que le contenu a défilé.
 */
export function Shell({ views, player, topActions }: ShellProps): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);

  const onScroll = useCallback((): void => {
    const next = (scrollRef.current?.scrollTop ?? 0) > 2;
    setScrolled((prev) => (prev === next ? prev : next));
  }, []);

  return (
    <div className="shell">
      <Sidebar />
      <div className="shell-main">
        <TopBar scrolled={scrolled} actions={topActions} />
        <main className="shell-scroll" ref={scrollRef} onScroll={onScroll}>
          <RouteView scrollRef={scrollRef} actions={views} />
        </main>
      </div>
      <div className="shell-player">{player}</div>
    </div>
  );
}
