import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { RouteView, type RouteViewActions } from "./RouteView";
import { ViewBackdrop } from "./ViewBackdrop";
import { createShellShortcuts } from "./shellShortcuts";
import type { PlayerControls } from "../components/controls";
import { useGlobalShortcuts } from "../lib/shortcuts";
import { ContextMenuHost } from "../ui/ContextMenu";
import { ToastHost } from "../ui/Toast";
import { ShortcutsHelp } from "../ui/ShortcutsHelp";
import { FlyLayer } from "../ui/FlyLayer";
import { PlaylistDialogs } from "../views/PlaylistDialogs";
import { libraryStore } from "../state/library";
import { bindSearchQuery } from "../state/searchSync";
import { bindErrorToasts } from "../state/errorToasts";
import { playlistsStore } from "../state/playlists";
import { toast } from "../ui/toastStore";
import { CircleAlert } from "lucide-react";
import { uiStore } from "../state/ui";
import "./shell.css";

export interface ShellProps {
  /** Actions de lecture / bibliothèque consommées par les vues (fournies par l'App). */
  views: RouteViewActions;
  /** Commandes de transport (raccourcis clavier). Sans elles, seuls les raccourcis d'interface agissent. */
  controls?: PlayerControls;
  /** Barre de lecteur (bas, pleine largeur). */
  player?: ReactNode;
  /** Emplacement d'actions de la barre du haut. */
  topActions?: ReactNode;
}

/**
 * Coquille de l'app : grille barre latérale 248 px / contenu / barre de lecteur 88 px, fond noir
 * uni. Le contenu défile dans `.shell-scroll` (conteneur de défilement des listes virtualisées) ;
 * la barre du haut reste fixe au-dessus et gagne un filet dès que le contenu a défilé.
 *
 * Monte aussi les hôtes d'interaction (menu contextuel, toasts, aide des raccourcis, dialogues de
 * playlist, pochettes en vol — rendus dans `document.body`), la synchronisation terme de recherche
 * ↔ route (`bindSearchQuery`) et les raccourcis clavier globaux (`createShellShortcuts`), câblés sur
 * `controls` / le store lecteur / le routeur.
 */
export function Shell({ views, controls, player, topActions }: ShellProps): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrolled, setScrolled] = useState(false);

  const onScroll = useCallback((): void => {
    const next = (scrollRef.current?.scrollTop ?? 0) > 2;
    setScrolled((prev) => (prev === next ? prev : next));
  }, []);

  const shortcuts = useMemo(
    () =>
      createShellShortcuts({
        controls,
        focusSearch: () => {
          const el = searchRef.current;
          if (!el) return;
          el.focus();
          el.select();
        },
      }),
    [controls],
  );
  useGlobalShortcuts(shortcuts);

  // Terme de recherche ↔ route `search` (précédent / suivant rendent le terme ; quitter vide le champ).
  useEffect(() => bindSearchQuery(uiStore, libraryStore), []);
  // Échecs de lecture (bibliothèque, playlists) : un toast ; les pages montrent un état d'erreur.
  useEffect(
    () =>
      bindErrorToasts({
        library: libraryStore,
        playlists: playlistsStore,
        toast: (message) => void toast(message, { icon: CircleAlert }),
      }),
    [],
  );

  return (
    <div className="shell">
      <Sidebar />
      <ViewBackdrop />
      <div className="shell-main">
        <TopBar scrolled={scrolled} actions={topActions} searchRef={searchRef} />
        <main className="shell-scroll" ref={scrollRef} onScroll={onScroll}>
          <RouteView scrollRef={scrollRef} actions={views} />
        </main>
      </div>
      <div className="shell-player">{player}</div>

      <ContextMenuHost />
      <ToastHost />
      <ShortcutsHelp />
      <PlaylistDialogs />
      <FlyLayer />
    </div>
  );
}

