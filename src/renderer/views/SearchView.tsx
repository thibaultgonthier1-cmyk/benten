import type React from "react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Disc3, ListMusic, MicVocal, Pause, Play, Search, SearchX } from "lucide-react";
import type { PlaylistRow, TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import { setDragTracks } from "../lib/dnd";
import { artistShowsPause, buildSearchSections, canResume, searchPhase, sameTrackList } from "../lib/viewModels";
import { useLibrary } from "../state/library";
import { playerStore, usePlayer } from "../state/player";
import { usePlaylists } from "../state/playlists";
import { useSettings } from "../state/settings";
import { uiStore } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { dur, ease } from "../theme/ds/motion";
import { AlbumTile } from "../ui/AlbumTile";
import { CoverArt } from "../ui/CoverArt";
import { ICON_STROKE } from "../ui/IconButton";
import { openMenu } from "../ui/menuStore";
import { Skeleton } from "../ui/Skeleton";
import { TrackRowItem } from "../ui/TrackRowItem";
import { useMotion } from "../ui/useMotion";
import { artistLayoutId, artistMenuItems, artistQueueOf, cachedArtistPage, playArtist } from "./artistPlay";
import { EmptyState, PageHeader } from "./common";
import { anchorFromEvent, useViewMenus } from "./menus";
import { PlaylistTile } from "./PlaylistsView";
import { focusSearchField } from "./searchFocus";
import "./views.css";
import "./artists.css";
import "./playlists.css";
import "./search.css";

export interface SearchViewProps {
  q: string;
  actions: RouteViewActions;
}

/** Album éphémère des titres trouvés (lecture d'un titre dans le contexte de la recherche). */
export const SEARCH_ALBUM_ID = -4;
/** Titres à côté du meilleur résultat ; au-delà, « Tous les titres » (replié). */
const TOP_TRACKS = 5;
/** Plafonds des sections (la recherche renvoie au plus 200 titres). */
const MAX_ALBUMS = 12;
const MAX_ARTISTS = 12;
const MAX_MORE_TRACKS = 95;

function searchAlbum(q: string, tracks: readonly TrackRow[]): Album {
  return { id: SEARCH_ALBUM_ID, title: `Recherche « ${q} »`, artist: "", artKey: tracks.find((t) => t.artKey)?.artKey ?? null, tracks };
}

/**
 * Page Recherche : meilleur résultat en grande carte (titre, artiste ou album), les premiers titres
 * à côté, puis Albums, Artistes, Playlists et le reste des titres (replié). Squelettes tant que la
 * première réponse n'est pas là ; « Aucun résultat » SEULEMENT quand la réponse du terme courant est
 * arrivée vide (`searched` + `resultsFor`). Pendant la frappe, les résultats précédents restent
 * affichés (atténués) jusqu'à la réponse suivante.
 *
 * Clavier : ↓ depuis le champ amène au meilleur résultat, ↓ à nouveau aux titres (↑/↓ entre eux),
 * ↑ depuis la carte rend le focus au champ.
 */
export function SearchView({ q, actions }: SearchViewProps): JSX.Element {
  const query = useLibrary((s) => s.query);
  const results = useLibrary((s) => s.results);
  const searched = useLibrary((s) => s.searched);
  const resultsFor = useLibrary((s) => s.resultsFor);
  const playlists = usePlaylists((s) => s.rows);
  // Le champ est la source pendant la frappe ; la route (précédent / suivant) au premier rendu.
  const term = (query || q).trim();

  const sections = useMemo(() => buildSearchSections(term, results, playlists), [term, results, playlists]);
  const hasAny =
    sections.tracks.length + sections.albums.length + sections.artists.length + sections.playlists.length > 0;
  const phase = searchPhase(term, { searched, resultsFor }, hasAny);
  const stale = phase === "results" && !(searched && resultsFor === term);

  let body: JSX.Element;
  if (phase === "idle") {
    body = (
      <EmptyState
        icon={Search}
        title="Que veux-tu écouter ?"
        text="Tape un titre, un artiste, un album ou une playlist. Ctrl+F t'amène ici depuis n'importe quelle page."
      />
    );
  } else if (phase === "loading") {
    body = <SearchSkeleton />;
  } else if (phase === "empty") {
    body = (
      <EmptyState
        icon={SearchX}
        title="Aucun résultat"
        text={`Rien ne correspond à « ${term} ». Vérifie l'orthographe, ou essaie un artiste ou un album.`}
      />
    );
  } else {
    body = <SearchResultsBody term={term} sections={sections} actions={actions} />;
  }

  return (
    <div className={`search-view${stale ? " is-stale" : ""}`}>
      <PageHeader title="Recherche" sub={term ? `Résultats pour « ${term} »` : null} />
      {body}
    </div>
  );
}

/* ------------------------------------------ Résultats ------------------------------------------ */

function SearchResultsBody({
  term,
  sections,
  actions,
}: {
  term: string;
  sections: ReturnType<typeof buildSearchSections>;
  actions: RouteViewActions;
}): JSX.Element {
  const m = useMotion();
  const menus = useViewMenus(actions);
  const libraryAlbums = useLibrary((s) => s.albums);
  const [showMore, setShowMore] = useState(false);
  const { top, tracks, albums, artists, playlists } = sections;

  // Une tuile d'album lit l'album COMPLET de la bibliothèque (la recherche n'en renvoie qu'une partie).
  const fullAlbums = useMemo(() => {
    const byId = new Map(libraryAlbums.map((a) => [a.id, a]));
    return albums.slice(0, MAX_ALBUMS).map((a) => byId.get(a.id) ?? a);
  }, [albums, libraryAlbums]);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const isThisQueue = usePlayer((s) => sameTrackList(s.queue, tracks));
  const playingIndex = usePlayer((s) => (isThisQueue ? s.currentIndex : -1));
  const currentId = usePlayer((s) => s.currentTrack?.id ?? null);

  const playTrackAt = useCallback(
    (track: TrackRow, index: number): void => {
      const p = playerStore.getState();
      const current = isThisQueue ? p.currentIndex === index : p.currentTrack?.id === track.id;
      if (current && canResume(p.status)) actions.togglePlay();
      else actions.playAlbum(searchAlbum(term, tracksRef.current), index);
    },
    [actions, isThisQueue, term],
  );
  const onTrackMenu = useCallback(
    (track: TrackRow, e: React.MouseEvent<HTMLElement>): void => {
      const index = tracksRef.current.indexOf(track);
      void menus.openTrackMenu(track, anchorFromEvent(e), (t) => playTrackAt(t, Math.max(0, index)));
    },
    [menus, playTrackAt],
  );

  const playAlbum = useCallback(
    (album: Album): void => {
      const p = playerStore.getState();
      if (p.currentTrack?.albumId === album.id && canResume(p.status)) actions.togglePlay();
      else actions.playAlbumInOrder(album);
    },
    [actions],
  );
  const onAlbumMenu = useCallback(
    (album: Album, e: React.MouseEvent<HTMLElement>): void => void menus.openAlbumMenu(album, anchorFromEvent(e)),
    [menus],
  );
  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);

  // Roving tabIndex des titres (une seule ligne dans l'ordre de tabulation).
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const onRowFocus = useCallback((t: TrackRow): void => setFocusedId(t.id), []);
  const firstRows = tracks.slice(0, TOP_TRACKS);
  const moreRows = tracks.slice(TOP_TRACKS, TOP_TRACKS + MAX_MORE_TRACKS);
  const visibleIds = showMore ? [...firstRows, ...moreRows] : firstRows;
  const tabStop = visibleIds.some((t) => t.id === focusedId) ? focusedId : (visibleIds[0]?.id ?? null);

  const renderRow = (t: TrackRow, i: number): JSX.Element => (
    <TrackRowItem
      key={`${t.id}:${i}`}
      track={t}
      index={i}
      playing={isThisQueue ? i === playingIndex : t.id === currentId}
      selected={false}
      tabbable={t.id === tabStop}
      showAlbum={false}
      onFocusRow={onRowFocus}
      onPlay={playTrackAt}
      onContextMenu={onTrackMenu}
    />
  );

  // ↓ depuis le meilleur résultat : premier titre ; ↑ : retour au champ.
  const onTopKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === "ArrowDown") {
      const row = document.querySelector<HTMLElement>(".search-top__tracks [data-track-row]");
      if (row) {
        e.preventDefault();
        row.focus();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusSearchField();
    }
  };

  const enter = (i: number): Record<string, unknown> =>
    m.enabled
      ? {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: m.d(dur.slow), ease: ease.out, delay: m.d(Math.min(i, 6) * 0.05) },
        }
      : {};

  const topTrack = top?.kind === "track" ? tracks.find((t) => String(t.id) === top.id) : undefined;
  const topAlbum = top?.kind === "album" ? fullAlbums.find((a) => String(a.id) === top.id) ?? albums.find((a) => String(a.id) === top.id) : undefined;

  return (
    <div className="search-results" data-search-results="">
      {(top || firstRows.length > 0) && (
        <motion.div className={`search-top${top ? "" : " no-card"}`} {...enter(0)}>
          {top && (
            <section className="search-top__best" aria-label="Meilleur résultat">
              <h2 className="search-h">Meilleur résultat</h2>
              {topTrack ? (
                <TopTrackCard
                  track={topTrack}
                  index={tracks.indexOf(topTrack)}
                  playing={isThisQueue ? tracks.indexOf(topTrack) === playingIndex : topTrack.id === currentId}
                  onPlay={playTrackAt}
                  onMenu={onTrackMenu}
                  onKeyDown={onTopKeyDown}
                />
              ) : topAlbum ? (
                <TopAlbumCard album={topAlbum} onPlay={playAlbum} onMenu={onAlbumMenu} onKeyDown={onTopKeyDown} />
              ) : top.kind === "artist" ? (
                <TopArtistCard name={top.id} actions={actions} onKeyDown={onTopKeyDown} />
              ) : null}
            </section>
          )}
          {firstRows.length > 0 && (
            <section className="search-top__tracks" aria-label="Titres">
              <h2 className="search-h">Titres</h2>
              <div className="track-list" role="list" data-track-list="" aria-label="Titres trouvés">
                {firstRows.map((t, i) => renderRow(t, i))}
                {showMore && moreRows.map((t, i) => renderRow(t, TOP_TRACKS + i))}
              </div>
              {moreRows.length > 0 && (
                <button
                  type="button"
                  className={`search-more${showMore ? " is-open" : ""}`}
                  aria-expanded={showMore}
                  onClick={() => setShowMore((v) => !v)}
                >
                  {showMore ? "Moins de titres" : `${moreRows.length} autres titres`}
                  <ChevronDown size={15} strokeWidth={ICON_STROKE} aria-hidden />
                </button>
              )}
            </section>
          )}
        </motion.div>
      )}

      {fullAlbums.length > 0 && (
        <motion.section className="search-section" aria-label="Albums" {...enter(1)}>
          <h2 className="search-h">
            <Disc3 size={16} strokeWidth={ICON_STROKE} aria-hidden /> Albums
            <span className="search-h__count num">{albums.length}</span>
          </h2>
          <div className="search-grid" role="list">
            {fullAlbums.map((a) => (
              <div key={a.id} role="listitem" className="album-grid__cell">
                <AlbumTile album={a} playing={a.id === currentAlbumId} onPlay={playAlbum} onContextMenu={onAlbumMenu} />
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {artists.length > 0 && (
        <motion.section className="search-section" aria-label="Artistes" {...enter(2)}>
          <h2 className="search-h">
            <MicVocal size={16} strokeWidth={ICON_STROKE} aria-hidden /> Artistes
            <span className="search-h__count num">{artists.length}</span>
          </h2>
          <div className="search-grid is-artists" role="list">
            {artists.slice(0, MAX_ARTISTS).map((name) => (
              <div key={name} role="listitem" className="album-grid__cell">
                <SearchArtistTile name={name} actions={actions} />
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {playlists.length > 0 && (
        <motion.section className="search-section" aria-label="Playlists" {...enter(3)}>
          <h2 className="search-h">
            <ListMusic size={16} strokeWidth={ICON_STROKE} aria-hidden /> Playlists
            <span className="search-h__count num">{playlists.length}</span>
          </h2>
          <div className="search-grid" role="list">
            {playlists.map((p: PlaylistRow) => (
              <div key={p.id} role="listitem" className="album-grid__cell">
                <PlaylistTile playlist={p} actions={actions} enterIndex={null} />
              </div>
            ))}
          </div>
        </motion.section>
      )}
    </div>
  );
}

/* ---------------------------------------- Cartes « meilleur » ---------------------------------------- */

interface CardShellProps {
  kind: string;
  title: string;
  sub: React.ReactNode;
  artKey: string | null;
  seed: string;
  round?: boolean;
  playing: boolean;
  disabled?: boolean;
  label: string;
  onOpen(): void;
  onPlay(): void;
  onContextMenu(e: React.MouseEvent<HTMLElement>): void;
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void;
  onDragStart?(e: React.DragEvent<HTMLElement>): void;
}

/** Grande carte du meilleur résultat : pochette, nom mincho, type, bouton lecture (accent). */
function TopCard({
  kind,
  title,
  sub,
  artKey,
  seed,
  round = false,
  playing,
  disabled,
  label,
  onOpen,
  onPlay,
  onContextMenu,
  onKeyDown,
  onDragStart,
}: CardShellProps): JSX.Element {
  const colors = useCoverColors(artKey, seed);
  const known = artKey ? coverColorCache.peek(artKey) : colors;
  const Icon = playing ? Pause : Play;
  return (
    <div
      className="search-card"
      style={{ "--card-tint": known?.vibrant ?? "var(--accent)" } as React.CSSProperties}
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-keyshortcuts="Enter Shift+Enter"
      data-search-first=""
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) onOpen();
          else onPlay();
          return;
        }
        onKeyDown(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    >
      <span className="search-card__bg" aria-hidden="true" />
      <span className={`search-card__art${round ? " is-round" : ""}`}>
        <CoverArt artKey={artKey} seed={seed} placeholder={known?.dominant} />
      </span>
      <span className="search-card__title" title={title}>
        {title}
      </span>
      <span className="search-card__sub">
        <span className="search-card__kind">{kind}</span>
        {sub}
      </span>
      <button
        type="button"
        tabIndex={-1}
        className={`search-card__play${playing ? " is-current" : ""}`}
        aria-label={playing ? `Mettre en pause ${title}` : `Lire ${title}`}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
      >
        <Icon size={22} strokeWidth={0} fill="currentColor" aria-hidden />
      </button>
    </div>
  );
}

function TopTrackCard({
  track,
  index,
  playing,
  onPlay,
  onMenu,
  onKeyDown,
}: {
  track: TrackRow;
  index: number;
  playing: boolean;
  onPlay(t: TrackRow, i: number): void;
  onMenu(t: TrackRow, e: React.MouseEvent<HTMLElement>): void;
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void;
}): JSX.Element {
  const showPause = usePlayer((s) => playing && s.status === "playing");
  return (
    <TopCard
      kind="Titre"
      title={track.title}
      sub={track.artist || "Artiste inconnu"}
      artKey={track.artKey}
      seed={`${track.albumId}:${track.album}`}
      playing={showPause}
      disabled={track.playable === false}
      label={`Meilleur résultat : titre ${track.title}${track.artist ? ` — ${track.artist}` : ""}`}
      onOpen={() => uiStore.getState().navigate({ name: "album", id: track.albumId })}
      onPlay={() => onPlay(track, Math.max(0, index))}
      onContextMenu={(e) => onMenu(track, e)}
      onKeyDown={onKeyDown}
      onDragStart={(e) => setDragTracks(e.dataTransfer, [track.id])}
    />
  );
}

function TopAlbumCard({
  album,
  onPlay,
  onMenu,
  onKeyDown,
}: {
  album: Album;
  onPlay(a: Album): void;
  onMenu(a: Album, e: React.MouseEvent<HTMLElement>): void;
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void;
}): JSX.Element {
  const showPause = usePlayer((s) => s.currentTrack?.albumId === album.id && s.status === "playing");
  const n = album.tracks.length;
  return (
    <TopCard
      kind="Album"
      title={album.title}
      sub={`${album.artist || "Artiste inconnu"} · ${n} ${n > 1 ? "titres" : "titre"}`}
      artKey={album.artKey}
      seed={`${album.id}:${album.title}`}
      playing={showPause}
      disabled={n === 0}
      label={`Meilleur résultat : album ${album.title}${album.artist ? ` — ${album.artist}` : ""}`}
      onOpen={() => uiStore.getState().navigate({ name: "album", id: album.id })}
      onPlay={() => onPlay(album)}
      onContextMenu={(e) => onMenu(album, e)}
      onKeyDown={onKeyDown}
      onDragStart={(e) => setDragTracks(e.dataTransfer, album.tracks.map((t) => t.id))}
    />
  );
}

/** Bouton « Pause » ssi le lecteur joue la file de CET artiste (comme la tuile Artistes). */
function useArtistPlaying(name: string): { list: TrackRow[]; showPause: boolean } {
  const albums = useLibrary((s) => s.albums);
  const grouped = useSettings((s) => s.groupVersions);
  const queue = usePlayer((s) => s.queue);
  const playing = usePlayer((s) => s.status === "playing");
  const list = useMemo(() => artistQueueOf(name), [name, albums, grouped]);
  const showPause = useMemo(() => artistShowsPause(queue, playing, list), [queue, playing, list]);
  return { list, showPause };
}

function TopArtistCard({
  name,
  actions,
  onKeyDown,
}: {
  name: string;
  actions: RouteViewActions;
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void;
}): JSX.Element {
  const albums = useLibrary((s) => s.albums);
  const page = useMemo(() => cachedArtistPage(albums, name), [albums, name]);
  const { list, showPause } = useArtistPlaying(name);
  const n = page.tracks.length;
  return (
    <TopCard
      kind="Artiste"
      title={page.name || name}
      sub={`${n} ${n > 1 ? "titres" : "titre"}`}
      artKey={page.artKey}
      seed={`artist:${name}`}
      round
      playing={showPause}
      disabled={list.length === 0}
      label={`Meilleur résultat : artiste ${name}`}
      onOpen={() => uiStore.getState().navigate({ name: "artist", artist: name })}
      onPlay={() => playArtistToggle(name, list, actions)}
      onContextMenu={(e) => {
        const a = anchorFromEvent(e);
        openMenu(a.x, a.y, artistMenuItems(name, actions), { focusFirst: a.focusFirst });
      }}
      onKeyDown={onKeyDown}
      onDragStart={(e) => setDragTracks(e.dataTransfer, list.map((t) => t.id))}
    />
  );
}

/** Lecture d'un artiste depuis la recherche (même chemin que la page artiste : bascule sur sa file). */
const playArtistToggle = (name: string, list: readonly TrackRow[], actions: RouteViewActions): void =>
  playArtist(name, list, actions);

/* ----------------------------------------- Tuile d'artiste ----------------------------------------- */

/** Avatar rond (mêmes matières que la grille Artistes) ; l'avatar voyage vers la page artiste. */
const SearchArtistTile = memo(function SearchArtistTile({
  name,
  actions,
}: {
  name: string;
  actions: RouteViewActions;
}): JSX.Element {
  const m = useMotion();
  const albums = useLibrary((s) => s.albums);
  const page = useMemo(() => cachedArtistPage(albums, name), [albums, name]);
  const seed = `artist:${name}`;
  const colors = useCoverColors(page.artKey, seed);
  const known = page.artKey ? coverColorCache.peek(page.artKey) : colors;
  const { list, showPause } = useArtistPlaying(name);
  const n = page.tracks.length;
  const open = (): void => uiStore.getState().navigate({ name: "artist", artist: name });
  const Icon = showPause ? Pause : Play;

  return (
    <div
      className="artist-tile"
      tabIndex={0}
      role="group"
      aria-label={`${name}, ${n} ${n > 1 ? "titres" : "titre"}`}
      draggable
      onDragStart={(e) => setDragTracks(e.dataTransfer, list.map((t) => t.id))}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") {
          e.preventDefault();
          open();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const a = anchorFromEvent(e);
        openMenu(a.x, a.y, artistMenuItems(name, actions), { focusFirst: a.focusFirst });
      }}
    >
      <div className="artist-tile__lift">
        <span className="artist-tile__glow" style={{ background: known?.vibrant ?? "transparent" }} aria-hidden="true" />
        <motion.div
          className="artist-tile__art"
          layoutId={m.enabled ? artistLayoutId(name) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: "50%" }}
        >
          <span className="artist-tile__zoom">
            <CoverArt artKey={page.artKey} seed={seed} placeholder={known?.dominant} />
          </span>
        </motion.div>
        <button
          type="button"
          tabIndex={-1}
          className={`artist-tile__play${showPause ? " is-current" : ""}`}
          aria-label={showPause ? `Mettre en pause ${name}` : `Lire ${name}`}
          disabled={list.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            playArtistToggle(name, list, actions);
          }}
        >
          <Icon size={20} strokeWidth={0} fill="currentColor" aria-hidden />
        </button>
      </div>
      <div className="artist-tile__meta">
        <div className="artist-tile__name" title={name}>
          {name}
        </div>
        <div className="artist-tile__count num">{`${n} ${n > 1 ? "titres" : "titre"}`}</div>
      </div>
    </div>
  );
});

/* -------------------------------------------- Squelette -------------------------------------------- */

/** Chargement : carte du meilleur résultat + lignes de titres + une rangée de pochettes fantômes. */
function SearchSkeleton(): JSX.Element {
  return (
    <div className="search-results search-skel" aria-busy="true" aria-label="Recherche en cours">
      <div className="search-top">
        <section className="search-top__best">
          <Skeleton w={150} h={14} radius={7} />
          <div className="search-card is-skeleton">
            <Skeleton w={112} h={112} radius={12} />
            <Skeleton w="70%" h={26} radius={8} style={{ marginTop: 20 }} />
            <Skeleton w="40%" h={12} radius={6} style={{ marginTop: 12 }} />
          </div>
        </section>
        <section className="search-top__tracks">
          <Skeleton w={70} h={14} radius={7} />
          <div className="tracks-skel">
            {Array.from({ length: TOP_TRACKS }, (_, i) => (
              <div key={i} className="tracks-skel__row">
                <Skeleton w={18} h={10} radius={5} />
                <Skeleton w={`${50 + ((i * 37) % 30)}%`} h={12} radius={6} />
                <Skeleton w="60%" h={10} radius={5} />
                <Skeleton w="54%" h={10} radius={5} />
                <Skeleton w={34} h={10} radius={5} />
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="search-section">
        <Skeleton w={90} h={14} radius={7} />
        <div className="search-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="grid-skel-card">
              <div className="grid-skel-art">
                <Skeleton h="100%" radius={12} />
              </div>
              <Skeleton w="72%" h={12} radius={6} />
              <Skeleton w="46%" h={10} radius={5} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
