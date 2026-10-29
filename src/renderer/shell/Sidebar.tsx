import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Disc3,
  Download,
  Heart,
  House,
  ListMusic,
  MicVocal,
  Music,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { PlaylistRow } from "../../shared/types";
import { navSectionOf, uiStore, useUi, type NavSection, type Route } from "../state/ui";
import { BentenMark } from "../ui/BentenMark";
import { IconButton, ICON_STROKE } from "../ui/IconButton";
import { useMotion } from "../ui/useMotion";

interface NavEntry {
  key: NavSection;
  label: string;
  icon: LucideIcon;
  route: Route;
}

const HOME: NavEntry = { key: "home", label: "Accueil", icon: House, route: { name: "home" } };
const LIBRARY: readonly NavEntry[] = [
  { key: "tracks", label: "Titres", icon: Music, route: { name: "tracks" } },
  { key: "albums", label: "Albums", icon: Disc3, route: { name: "albums" } },
  { key: "artists", label: "Artistes", icon: MicVocal, route: { name: "artists" } },
  { key: "playlists", label: "Playlists", icon: ListMusic, route: { name: "playlists" } },
  { key: "favorites", label: "Favoris", icon: Heart, route: { name: "favorites" } },
  { key: "downloads", label: "Téléchargements", icon: Download, route: { name: "downloads" } },
];
const SETTINGS: NavEntry = {
  key: "settings",
  label: "Réglages",
  icon: Settings,
  route: { name: "settings" },
};

/** API playlists du preload, ou `undefined` hors fenêtre Electron. */
function playlistsApi(): typeof window.benten.playlists | undefined {
  return typeof window !== "undefined" ? window.benten?.playlists : undefined;
}

/**
 * Liste des playlists de la barre latérale. Pas encore de canal push : rechargée à chaque
 * navigation (la vue Playlists crée/renomme/supprime) et au retour de focus de la fenêtre.
 */
function useSidebarPlaylists(): PlaylistRow[] {
  const route = useUi((s) => s.route);
  const [rows, setRows] = useState<PlaylistRow[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    const api = playlistsApi();
    if (!api) return;
    try {
      setRows(await api.list());
    } catch {
      /* best-effort : la barre latérale reste utilisable sans la liste. */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [route, reload]);
  useEffect(() => {
    const onFocus = (): void => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  return rows;
}

/** Fond de l'entrée active : UN seul élément partagé (`layoutId`) qui glisse d'une entrée à l'autre. */
function ActiveIndicator(): JSX.Element {
  const m = useMotion();
  return (
    <motion.span
      layoutId="sidebar-active"
      className="sb-active"
      aria-hidden="true"
      transition={m.enabled ? m.spring : { duration: 0 }}
    />
  );
}

function NavItem({ entry, active }: { entry: NavEntry; active: boolean }): JSX.Element {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      className={"sb-item" + (active ? " is-active" : "")}
      aria-current={active ? "page" : undefined}
      onClick={() => uiStore.getState().navigate(entry.route)}
    >
      {active && <ActiveIndicator />}
      <Icon className="sb-icon" size={19} strokeWidth={ICON_STROKE} aria-hidden />
      <span className="sb-label">{entry.label}</span>
    </button>
  );
}

/**
 * Barre latérale : mark Benten, navigation principale (icônes lucide), indicateur actif animé
 * (`layoutId`), section « Playlists » (liste ; future cible de dépôt, Tâche 9) et Réglages en pied.
 */
export function Sidebar(): JSX.Element {
  const route = useUi((s) => s.route);
  const playlists = useSidebarPlaylists();
  const section = navSectionOf(route);
  // Une playlist ouverte présente dans la liste porte l'indicateur ; sinon l'entrée « Playlists ».
  const activePlaylistId =
    route.name === "playlist" && playlists.some((p) => p.id === route.id) ? route.id : null;
  const isActive = (key: NavSection): boolean => activePlaylistId === null && section === key;

  return (
    <aside className="shell-side" aria-label="Navigation principale">
      <div className="sb-brand">
        <BentenMark size={36} className="sb-mark" />
        <div className="sb-brand-text">
          <b>Benten</b>
          <small>弁天 · lecture locale</small>
        </div>
      </div>

      <nav className="sb-nav" aria-label="Sections">
        <NavItem entry={HOME} active={isActive("home")} />
        <div className="sb-group">Bibliothèque</div>
        {LIBRARY.map((e) => (
          <NavItem key={e.key} entry={e} active={isActive(e.key)} />
        ))}
      </nav>

      <section className="sb-playlists" aria-label="Tes playlists">
        <div className="sb-group sb-group--row">
          <span>Playlists</span>
          <IconButton
            label="Nouvelle playlist"
            icon={Plus}
            size={26}
            className="sb-add"
            onClick={() => uiStore.getState().navigate({ name: "playlists" })}
          />
        </div>
        <ul className="sb-pl-list">
          {playlists.length === 0 ? (
            <li className="sb-pl-empty">Aucune playlist</li>
          ) : (
            playlists.map((p) => {
              const active = p.id === activePlaylistId;
              return (
                <li key={p.id} data-drop="playlist" data-playlist-id={p.id}>
                  <button
                    type="button"
                    className={"sb-item sb-pl-item" + (active ? " is-active" : "")}
                    aria-current={active ? "page" : undefined}
                    title={p.name}
                    onClick={() => uiStore.getState().navigate({ name: "playlist", id: p.id })}
                  >
                    {active && <ActiveIndicator />}
                    <span className="sb-pl-tile" aria-hidden="true">
                      <ListMusic size={14} strokeWidth={ICON_STROKE} />
                    </span>
                    <span className="sb-label">{p.name}</span>
                    <span className="sb-pl-count num">{p.trackCount}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <div className="sb-foot">
        <NavItem entry={SETTINGS} active={isActive("settings")} />
      </div>
    </aside>
  );
}
