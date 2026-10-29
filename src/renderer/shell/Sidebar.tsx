import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import { hasDragTracks, readDragTracks } from "../lib/dnd";
import { playlistsByCreation } from "../lib/viewModels";
import { playlistsStore, usePlaylists } from "../state/playlists";
import { navSectionOf, uiStore, useUi, type NavSection, type Route } from "../state/ui";
import { dur, ease } from "../theme/ds/motion";
import { BentenMark } from "../ui/BentenMark";
import { CoverArt } from "../ui/CoverArt";
import { IconButton, ICON_STROKE } from "../ui/IconButton";
import { playlistFx, usePlaylistFx } from "../ui/playlistFx";
import { RollingCount } from "../ui/RollingCount";
import { useMotion } from "../ui/useMotion";
import { addToPlaylist, openNewPlaylist, tracksFromIds } from "../views/playlistActions";

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

/** Le glisser en cours quitte-t-il vraiment l'élément (et pas seulement vers un enfant) ? */
const leaves = (e: React.DragEvent<HTMLElement>): boolean =>
  !e.currentTarget.contains(e.relatedTarget as Node | null);

/**
 * Barre latérale : mark Benten, navigation principale (icônes lucide), indicateur actif animé
 * (`layoutId`), section « Playlists » (store des playlists : à jour dès chaque création / renommage
 * / suppression / ajout) et Réglages en pied.
 *
 * Chaque playlist est une CIBLE DE DÉPÔT de titres : contour à l'accent au survol, ajout au dépôt
 * (doublons écartés, toast « Ajouté à … »), la pochette s'y pose, l'entrée fait « pop » et son
 * compteur roule (`playlistFx`). Sans playlist, l'invitation crée la première (y déposer des titres
 * les y met).
 */
export function Sidebar(): JSX.Element {
  const route = useUi((s) => s.route);
  const rows = usePlaylists((s) => s.rows);
  const loaded = usePlaylists((s) => s.loaded);
  const playlists = useMemo(() => playlistsByCreation(rows), [rows]);
  const section = navSectionOf(route);
  // Une playlist ouverte présente dans la liste porte l'indicateur ; sinon l'entrée « Playlists ».
  const activePlaylistId =
    route.name === "playlist" && playlists.some((p) => p.id === route.id) ? route.id : null;
  const isActive = (key: NavSection): boolean => activePlaylistId === null && section === key;

  useEffect(() => {
    void playlistsStore.getState().refresh();
    // Un glisser annulé (Échap, dépôt hors cible) n'éteint pas toujours la cible : on l'éteint ici.
    const clear = (): void => playlistFx.getState().setDropTarget(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, []);

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
            onClick={() => openNewPlaylist()}
          />
        </div>
        {/* `layoutScroll` : l'indicateur partagé tient compte du défilement de cette liste. */}
        <motion.ul className="sb-pl-list" layoutScroll>
          {loaded && playlists.length === 0 ? (
            <li>
              <EmptyInvite />
            </li>
          ) : (
            <AnimatePresence initial={false}>
              {playlists.map((p) => (
                <PlaylistEntry key={p.id} playlist={p} active={p.id === activePlaylistId} />
              ))}
            </AnimatePresence>
          )}
        </motion.ul>
      </section>

      <div className="sb-foot">
        <NavItem entry={SETTINGS} active={isActive("settings")} />
      </div>
    </aside>
  );
}

/** Entrée de playlist : navigation, cible de dépôt, vignette (pochette), compteur roulant. */
function PlaylistEntry({ playlist: p, active }: { playlist: PlaylistRow; active: boolean }): JSX.Element {
  const m = useMotion();
  const cover = usePlaylists((s) => s.art.get(p.id)?.[0] ?? null);
  const dropping = usePlaylistFx((s) => s.dropTarget === p.id);
  const held = usePlaylistFx((s) => s.held.get(p.id));
  const pop = usePlaylistFx((s) => s.pops.get(p.id) ?? 0);
  const tileRef = useRef<HTMLSpanElement>(null);
  const flashRef = useRef<HTMLSpanElement>(null);
  const firstPop = useRef(pop);

  // « Pop » à l'atterrissage d'une pochette (ou à un ajout sans vol) : la vignette rebondit, un
  // éclat à l'accent traverse l'entrée. WAAPI, transform/opacity seulement.
  useEffect(() => {
    if (pop === firstPop.current || !m.enabled) return;
    const ms = Math.round(m.d(dur.slow) * 1000);
    tileRef.current?.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.22)", offset: 0.35 }, { transform: "scale(1)" }],
      { duration: ms, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    flashRef.current?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], {
      duration: ms + 250,
      easing: "ease-out",
    });
  }, [pop, m]);

  const onDragOver = (e: React.DragEvent<HTMLLIElement>): void => {
    if (!hasDragTracks(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    playlistFx.getState().setDropTarget(p.id);
  };
  const onDrop = (e: React.DragEvent<HTMLLIElement>): void => {
    if (!hasDragTracks(e.dataTransfer)) return;
    e.preventDefault();
    playlistFx.getState().setDropTarget(null);
    const ids = readDragTracks(e.dataTransfer);
    const tracks = ids ? tracksFromIds(ids) : [];
    if (tracks.length > 0) {
      void addToPlaylist({ id: p.id, name: p.name }, tracks, { origin: { x: e.clientX, y: e.clientY } });
    }
  };

  return (
    <motion.li
      layout={m.enabled ? "position" : false}
      initial={m.enabled ? { opacity: 0, x: -10 } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={m.enabled ? { opacity: 0, x: -10, transition: { duration: m.d(dur.fast) } } : { opacity: 0 }}
      transition={{ duration: m.d(dur.base), ease: ease.out }}
      data-drop="playlist"
      data-playlist-id={p.id}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (leaves(e) && playlistFx.getState().dropTarget === p.id) playlistFx.getState().setDropTarget(null);
      }}
      onDrop={onDrop}
    >
      <button
        type="button"
        className={"sb-item sb-pl-item" + (active ? " is-active" : "") + (dropping ? " is-drop" : "")}
        aria-current={active ? "page" : undefined}
        title={p.name}
        onClick={() => uiStore.getState().navigate({ name: "playlist", id: p.id })}
      >
        {active && <ActiveIndicator />}
        <span ref={flashRef} className="sb-pl-flash" aria-hidden="true" />
        <span ref={tileRef} className="sb-pl-tile" data-playlist-target={p.id} aria-hidden="true">
          {cover ? (
            <CoverArt artKey={cover} seed={`playlist:${p.id}`} />
          ) : (
            <ListMusic size={14} strokeWidth={ICON_STROKE} />
          )}
        </span>
        <span className="sb-label">{p.name}</span>
        <RollingCount value={held ?? p.trackCount} className="sb-pl-count num" />
      </button>
    </motion.li>
  );
}

/**
 * Aucune playlist : invitation à créer la première. Cible de dépôt elle aussi — y déposer des
 * titres ouvre le dialogue « Nouvelle playlist » avec ces titres.
 */
function EmptyInvite(): JSX.Element {
  const dropping = usePlaylistFx((s) => s.dropTarget === 0);
  return (
    <button
      type="button"
      className={"sb-pl-invite" + (dropping ? " is-drop" : "")}
      onClick={() => openNewPlaylist()}
      onDragEnter={(e) => {
        if (!hasDragTracks(e.dataTransfer)) return;
        e.preventDefault();
        playlistFx.getState().setDropTarget(0);
      }}
      onDragOver={(e) => {
        if (!hasDragTracks(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        playlistFx.getState().setDropTarget(0);
      }}
      onDragLeave={(e) => {
        if (leaves(e)) playlistFx.getState().setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!hasDragTracks(e.dataTransfer)) return;
        e.preventDefault();
        playlistFx.getState().setDropTarget(null);
        const ids = readDragTracks(e.dataTransfer);
        openNewPlaylist(ids ? tracksFromIds(ids) : [], { x: e.clientX, y: e.clientY });
      }}
    >
      <span className="sb-pl-invite__icon" aria-hidden="true">
        <Plus size={15} strokeWidth={ICON_STROKE} />
      </span>
      <span className="sb-pl-invite__text">
        <b>Crée ta première playlist</b>
        <small>ou glisse des titres ici</small>
      </span>
    </button>
  );
}
