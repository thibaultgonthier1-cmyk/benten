import type React from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CircleAlert, FileUp, ListEnd, ListMusic, ListStart, Pencil, Play, Plus, Shuffle, Trash2 } from "lucide-react";
import type { PlaylistRow, TrackRow } from "../../shared/types";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import { playlistsByCreation } from "../lib/viewModels";
import { playerStore } from "../state/player";
import { playlistsStore, usePlaylists } from "../state/playlists";
import { uiStore } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { dur, ease } from "../theme/ds/motion";
import { Button } from "../ui/Button";
import { ImportPlaylistDialog } from "./ImportPlaylistDialog";
import { ICON_STROKE } from "../ui/IconButton";
import { openMenu, type MenuItem } from "../ui/menuStore";
import { PlaylistMosaic } from "../ui/PlaylistMosaic";
import { quoted, toast } from "../ui/toastStore";
import { useMotion } from "../ui/useMotion";
import { ErrorState, GridSkeleton, PageHeader } from "./common";
import { anchorFromEvent } from "./menus";
import { askDeletePlaylist, openNewPlaylist, renamePlaylistInPlace } from "./playlistActions";
import { playPlaylist, shufflePlaylist } from "./playlistPlay";
import "./views.css";
import "./playlists.css";

export interface PlaylistsViewProps {
  actions: RouteViewActions;
}

/** Élément partagé mosaïque tuile → en-tête de la page playlist. */
export const playlistLayoutId = (id: number): string => `playlist-mosaic-${id}`;

/** Fenêtre (ms) pendant laquelle les tuiles jouent leur cascade d'entrée. */
const ENTER_WINDOW_MS = 900;

/** « 12 titres » (toujours la même unité). */
export function playlistCountLabel(n: number): string {
  return n === 0 ? "Vide" : `${n} ${n > 1 ? "titres" : "titre"}`;
}

/**
 * Grille Playlists : tuile « Nouvelle playlist » puis les playlists par date de création (ordre
 * d'ajout), chacune en mosaïque 2×2 de ses pochettes, nom et « n titres ». Mêmes gestes que les
 * albums : clic = page (la mosaïque y voyage), bouton = lecture, clic droit = menu (Lire, Aléatoire,
 * Lire ensuite, Ajouter à la file, Renommer, Supprimer…). Aucune playlist : invitation à créer la
 * première.
 */
export function PlaylistsView({ actions }: PlaylistsViewProps): JSX.Element {
  const rows = usePlaylists((s) => s.rows);
  const loaded = usePlaylists((s) => s.loaded);
  const error = usePlaylists((s) => s.error);
  const playlists = useMemo(() => playlistsByCreation(rows), [rows]);
  const [entering, setEntering] = useState(true);

  useEffect(() => {
    if (!loaded) void playlistsStore.getState().refresh();
    const id = setTimeout(() => setEntering(false), ENTER_WINDOW_MS);
    return () => clearTimeout(id);
  }, []);

  const sub = loaded && playlists.length > 0 ? `${playlists.length} ${playlists.length > 1 ? "playlists" : "playlist"}` : null;

  let body: JSX.Element;
  if (!loaded) body = <GridSkeleton count={6} />;
  else if (error && playlists.length === 0)
    body = (
      <ErrorState
        title="Impossible de charger les playlists"
        text="La lecture de tes playlists a échoué. Elles ne sont pas perdues : réessaie."
        onRetry={() => void playlistsStore.getState().refresh()}
      />
    );
  else if (playlists.length === 0) body = <PlaylistsEmpty />;
  else
    body = (
      <div className="plg-grid" role="list" aria-label="Playlists">
        <div role="listitem" className="album-grid__cell">
          <NewPlaylistTile />
        </div>
        {playlists.map((p, i) => (
          <div key={p.id} role="listitem" className="album-grid__cell">
            <PlaylistTile playlist={p} actions={actions} enterIndex={entering ? i + 1 : null} />
          </div>
        ))}
      </div>
    );

  return (
    <div className="playlists-view">
      <PageHeader title="Playlists" sub={sub} />
      {body}
    </div>
  );
}

/** Tuile de création : carré pointillé, « + » à l'accent. */
function NewPlaylistTile(): JSX.Element {
  return (
    <button type="button" className="plg-new" onClick={() => openNewPlaylist()}>
      <span className="plg-new__art">
        <span className="plg-new__plus" aria-hidden="true">
          <Plus size={26} strokeWidth={ICON_STROKE} />
        </span>
      </span>
      <span className="plg-new__label">Nouvelle playlist</span>
    </button>
  );
}

/** Agit sur les titres d'une playlist depuis la grille (relus à la demande). */
async function withTracks(p: PlaylistRow, run: (tracks: TrackRow[]) => void): Promise<void> {
  const res = await playlistsStore.getState().tracksOf(p.id);
  if (!res.ok) {
    toast(`Impossible de lire ${quoted(p.name)}`, { icon: CircleAlert });
    return;
  }
  const tracks = res.tracks;
  if (tracks.length === 0) {
    toast(`${quoted(p.name)} est vide`, { icon: ListMusic });
    return;
  }
  run(tracks);
}

/** Menu contextuel d'une playlist (tuile, page). */
export function playlistMenuItems(p: PlaylistRow, actions: RouteViewActions): MenuItem[] {
  const empty = p.trackCount === 0;
  const name = quoted(p.name);
  return [
    { label: "Lire", icon: Play, disabled: empty, onSelect: () => void withTracks(p, (t) => playPlaylist(p, t, actions)) },
    {
      label: "Aléatoire",
      icon: Shuffle,
      disabled: empty,
      onSelect: () => void withTracks(p, (t) => shufflePlaylist(p, t, actions)),
    },
    {
      label: "Lire ensuite",
      icon: ListStart,
      disabled: empty,
      onSelect: () =>
        void withTracks(p, (t) => {
          playerStore.getState().playNext(t);
          toast(`${name} sera lue ensuite`, { icon: ListStart });
        }),
    },
    {
      label: "Ajouter à la file",
      icon: ListEnd,
      disabled: empty,
      onSelect: () =>
        void withTracks(p, (t) => {
          playerStore.getState().addToQueue(t);
          toast(`${name} ajoutée à la file`, { icon: ListEnd });
        }),
    },
    "separator",
    { label: "Renommer", icon: Pencil, onSelect: () => renamePlaylistInPlace(p.id) },
    { label: "Supprimer la playlist…", icon: Trash2, danger: true, onSelect: () => askDeletePlaylist(p) },
  ];
}

export const PlaylistTile = memo(function PlaylistTile({
  playlist: p,
  actions,
  enterIndex,
}: {
  playlist: PlaylistRow;
  actions: RouteViewActions;
  enterIndex: number | null;
}): JSX.Element {
  const m = useMotion();
  const art = usePlaylists((s) => s.art.get(p.id) ?? EMPTY);
  const seed = `playlist:${p.id}`;
  // Abonnement : la tuile se re-rend quand la couleur de la 1re pochette est extraite.
  useCoverColors(art[0] ?? null, seed);
  const known = art[0] ? coverColorCache.peek(art[0]) : null;

  const open = useCallback((): void => uiStore.getState().navigate({ name: "playlist", id: p.id }), [p.id]);
  const play = (): void => void withTracks(p, (t) => playPlaylist(p, t, actions));

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) open();
    else play();
  };

  const style =
    enterIndex !== null && m.enabled
      ? ({ "--enter-delay": `${Math.min(enterIndex, 24) * 28}ms` } as React.CSSProperties)
      : undefined;

  return (
    <div
      className={`album-tile pl-tile${enterIndex !== null && m.enabled ? " is-entering" : ""}`}
      style={style}
      tabIndex={0}
      role="group"
      aria-label={`${p.name}, ${playlistCountLabel(p.trackCount)}`}
      aria-keyshortcuts="Enter Shift+Enter"
      onClick={open}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        const a = anchorFromEvent(e);
        openMenu(a.x, a.y, playlistMenuItems(p, actions), { focusFirst: a.focusFirst });
      }}
    >
      <div className="album-tile__lift">
        <span className="album-tile__glow" style={{ background: known?.vibrant ?? "color-mix(in srgb, var(--accent) 50%, transparent)" }} aria-hidden="true" />
        <motion.div
          className="album-tile__art"
          layoutId={m.enabled ? playlistLayoutId(p.id) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: 12 }}
        >
          <span className="album-tile__zoom">
            <PlaylistMosaic artKeys={art} seed={seed} />
          </span>
        </motion.div>
        <button
          type="button"
          tabIndex={-1}
          className="album-tile__play"
          aria-label={`Lire ${p.name}`}
          title="Lire"
          disabled={p.trackCount === 0}
          onClick={(e) => {
            e.stopPropagation();
            play();
          }}
        >
          <Play size={20} strokeWidth={0} fill="currentColor" aria-hidden />
        </button>
      </div>
      <div className="album-tile__meta">
        <div className="album-tile__title" title={p.name}>
          {p.name}
        </div>
        <div className="album-tile__artist pl-tile__count num">{playlistCountLabel(p.trackCount)}</div>
      </div>
    </div>
  );
});

const EMPTY: readonly string[] = [];

/** Aucune playlist : invitation illustrée (mosaïque fantôme) à créer la première. */
function PlaylistsEmpty(): JSX.Element {
  const m = useMotion();
  const [importing, setImporting] = useState(false);
  return (
    <motion.div
      className="plg-empty"
      initial={m.enabled ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: m.d(dur.slow), ease: ease.out }}
    >
      <div className="plg-empty__art" aria-hidden="true">
        <span className="plg-empty__card is-back" />
        <span className="plg-empty__card is-mid" />
        <span className="plg-empty__card is-front">
          <span className="plg-empty__grid">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="plg-empty__plus">
            <Plus size={22} strokeWidth={ICON_STROKE} />
          </span>
        </span>
      </div>
      <h2>Crée ta première playlist</h2>
      <p>
        Rassemble tes titres, dans l'ordre que tu veux. Ensuite, glisse des titres sur la playlist dans la barre
        latérale, ou fais un clic droit sur un titre › <b>Ajouter à une playlist</b>.
      </p>
      <div className="plg-empty__actions">
        <Button variant="primary" icon={Plus} onClick={() => openNewPlaylist()}>
          Nouvelle playlist
        </Button>
        <Button variant="ghost" icon={FileUp} onClick={() => setImporting(true)}>
          Importer une playlist
        </Button>
      </div>
      {importing && <ImportPlaylistDialog onClose={() => setImporting(false)} />}
    </motion.div>
  );
}


