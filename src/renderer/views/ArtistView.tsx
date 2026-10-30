import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Clock3, Ellipsis, ListEnd, ListStart, MicVocal, Pause, Play, Shuffle } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import {
  artistKey,
  artistQueue,
  canResume,
  groupVersions,
  sameTrackList,
  versionName,
  versionRows,
  type ArtistPageModel,
  type VersionRow,
} from "../lib/viewModels";
import { useLibrary } from "../state/library";
import { playerStore, usePlayer } from "../state/player";
import { useSettings } from "../state/settings";
import type { RouteViewActions } from "../shell/RouteView";
import { dur, ease } from "../theme/ds/motion";
import { AlbumTile } from "../ui/AlbumTile";
import { Button } from "../ui/Button";
import { CoverArt } from "../ui/CoverArt";
import { IconButton, ICON_STROKE } from "../ui/IconButton";
import { openMenu } from "../ui/menuStore";
import { Skeleton } from "../ui/Skeleton";
import { TrackRowItem } from "../ui/TrackRowItem";
import { useMotion } from "../ui/useMotion";
import {
  addArtistToQueue,
  artistAlbum,
  artistLayoutId,
  cachedArtistPage,
  playArtist,
  playArtistNext,
  shuffleArtist,
} from "./artistPlay";
import { EmptyState } from "./common";
import { HeroCompactBar, safeTint, useCompactOnScroll, useHeroEnter, useTopTint } from "./hero";
import { anchorBelow, anchorFromEvent, playlistMenuItem, useViewMenus } from "./menus";
import "./views.css";
import "./artists.css";

export interface ArtistViewProps {
  name: string;
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/**
 * Page artiste (à la Apple Music) : grand avatar rond (première pochette, arrivée de la tuile par
 * élément partagé `layoutId`), nom en mincho, « n albums · n titres », dégradé de la couleur vive
 * de la pochette qui passe sous la barre du haut. Lecture (tout l'artiste dans l'ordre, mélange
 * coupé) / Aléatoire / ⋯ (lire ensuite, ajouter à la file, à une playlist) ; une barre compacte
 * prend le relais au défilement. Sections : « Albums » (artiste d'album), « Apparaît sur » (crédité
 * sur des titres d'autres albums), « Titres » (tous, par date d'ajout ; versions regroupées selon
 * le réglage, « +N versions » les déplie).
 */
export function ArtistView({ name, scrollRef, actions }: ArtistViewProps): JSX.Element {
  const albums = useLibrary((s) => s.albums);
  const loading = useLibrary((s) => s.loading);
  const page = useMemo(() => cachedArtistPage(albums, name), [albums, name]);

  if (page.albums.length === 0 && page.tracks.length === 0) {
    return loading ? <ArtistSkeleton /> : (
      <EmptyState icon={MicVocal} title="Artiste introuvable" text="Aucun titre de cet artiste dans la bibliothèque." />
    );
  }
  return <ArtistPageView key={artistKey(page.name)} page={page} scrollRef={scrollRef} actions={actions} />;
}

function ArtistPageView({
  page,
  scrollRef,
  actions,
}: {
  page: ArtistPageModel;
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}): JSX.Element {
  const m = useMotion();
  const enter = useHeroEnter();
  const menus = useViewMenus(actions);
  const seed = `artist:${page.name}`;
  const colors = useCoverColors(page.artKey, seed);
  // Couleur seulement quand elle est connue (jamais le repli génératif transitoire d'une vraie pochette).
  const resolved = page.artKey ? coverColorCache.peek(page.artKey) : colors;
  useTopTint(scrollRef, safeTint(resolved?.vibrant));
  const actionsRef = useRef<HTMLDivElement>(null);
  const compact = useCompactOnScroll(scrollRef, actionsRef);

  const grouped = useSettings((s) => s.groupVersions);
  const currentTrackId = usePlayer((s) => s.currentTrack?.id ?? null);
  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);
  const queue = usePlayer((s) => s.queue);
  const statusPlaying = usePlayer((s) => s.status === "playing");

  // File « Lecture » (un titre par morceau si les versions sont regroupées).
  const playList = useMemo(() => artistQueue(page.tracks, grouped), [page.tracks, grouped]);
  const isCurrent = useMemo(() => sameTrackList(queue, playList), [queue, playList]);
  const isPlaying = isCurrent && statusPlaying;
  const empty = playList.length === 0;

  // --- Titres : versions regroupées (dépli local à la page) ---------------------------------------
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const groups = useMemo(() => (grouped ? groupVersions(page.tracks) : null), [grouped, page.tracks]);
  const rows = useMemo<VersionRow[]>(
    () =>
      groups
        ? versionRows(groups, expanded)
        : page.tracks.map((t) => ({ track: t, depth: 0, groupId: t.id, versionCount: 0, expanded: false, tag: null })),
    [groups, expanded, page.tracks],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.track.id, i])), [rows]);
  const toggleGroup = useCallback((leadId: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }, []);

  const [selected, setSelected] = useState<number | null>(null);
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const tabStopId =
    [focusedRow, selected, currentTrackId].find((id) => id !== null && indexOf.has(id)) ?? rows[0]?.track.id ?? null;

  // --- Lecture ------------------------------------------------------------------------------------
  const onHeaderPlay = useCallback(() => playArtist(page.name, playList, actions), [page.name, playList, actions]);

  /** Double-clic / Entrée : la liste AFFICHÉE depuis ce titre ; sur le titre courant : bascule. */
  const playFrom = useCallback(
    (track: TrackRow): void => {
      const p = playerStore.getState();
      if (p.currentTrack?.id === track.id && canResume(p.status)) {
        actions.togglePlay();
        return;
      }
      const list = rowsRef.current.map((r) => r.track);
      actions.playAlbum(artistAlbum(page.name, list), Math.max(0, list.findIndex((t) => t.id === track.id)));
    },
    [actions, page.name],
  );
  const onRowPlay = useCallback((track: TrackRow) => playFrom(track), [playFrom]);
  const onRowSelect = useCallback((track: TrackRow) => setSelected(track.id), []);
  const onRowFocus = useCallback((track: TrackRow) => setFocusedRow(track.id), []);
  const onRowMenu = useCallback(
    (track: TrackRow, e: React.MouseEvent<HTMLElement>): void => {
      void menus.openTrackMenu(track, anchorFromEvent(e), playFrom);
    },
    [menus, playFrom],
  );

  const onAlbumPlay = useCallback(
    (album: Album): void => {
      const p = playerStore.getState();
      if (p.currentTrack?.albumId === album.id && canResume(p.status)) actions.togglePlay();
      else actions.playAlbumInOrder(album);
    },
    [actions],
  );
  const onAlbumMenu = useCallback(
    (album: Album, e: React.MouseEvent<HTMLElement>): void => {
      void menus.openAlbumMenu(album, anchorFromEvent(e));
    },
    [menus],
  );

  const openMoreMenu = async (e: React.MouseEvent<HTMLElement>): Promise<void> => {
    const a = anchorBelow(e);
    const addTo = await playlistMenuItem(playList, a, { disabled: empty });
    openMenu(
      a.x,
      a.y,
      [
        { label: "Lire ensuite", icon: ListStart, disabled: empty, onSelect: () => playArtistNext(page.name, playList) },
        { label: "Ajouter à la file", icon: ListEnd, disabled: empty, onSelect: () => addArtistToQueue(page.name, playList) },
        "separator",
        addTo,
      ],
      { focusFirst: a.focusFirst },
    );
  };

  // Pastilles « +N versions » / tag de version (mêmes que la vue Titres).
  const addons = useMemo(() => {
    const map = new Map<number, JSX.Element>();
    for (const r of rows) {
      if (r.depth === 0 && r.versionCount > 0) {
        map.set(
          r.track.id,
          <button
            type="button"
            tabIndex={-1}
            className={`version-toggle${r.expanded ? " is-open" : ""}`}
            aria-expanded={r.expanded}
            aria-label={`${r.expanded ? "Replier" : "Afficher"} les ${r.versionCount + 1} versions de ${r.track.title}`}
            title={r.expanded ? "Replier les versions" : "Afficher les versions"}
            onClick={(e) => {
              e.stopPropagation();
              toggleGroup(r.groupId);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="num">+{r.versionCount}</span>
            <span>{r.versionCount > 1 ? "versions" : "version"}</span>
            <ChevronDown className="version-toggle__chev" size={13} strokeWidth={ICON_STROKE} aria-hidden />
          </button>,
        );
      } else if (r.depth === 1 && r.tag) {
        map.set(
          r.track.id,
          <span className="version-tag" title={r.tag}>
            {r.tag}
          </span>,
        );
      }
    }
    return map;
  }, [rows, toggleGroup]);

  const ownCount = page.albums.length;
  const files = page.tracks.length;
  // Versions regroupées : « 13 morceaux · 23 fichiers » (comme la section Titres) — l'en-tête ne
  // promet jamais 23 titres quand Lecture en jouera 13.
  const songs = groups ? groups.length : files;
  const countLine =
    songs !== files
      ? `${songs} ${songs > 1 ? "morceaux" : "morceau"} · ${files} fichiers`
      : `${files} ${files > 1 ? "titres" : "titre"}`;
  const sub = [ownCount > 0 ? `${ownCount} ${ownCount > 1 ? "albums" : "album"}` : null, countLine]
    .filter(Boolean)
    .join(" · ");
  const heroStyle = resolved ? ({ "--hero": resolved.vibrant } as React.CSSProperties) : undefined;

  let ordinal = 0;
  return (
    <div className="album-view artist-view" style={heroStyle}>
      <HeroCompactBar
        visible={compact}
        playing={isPlaying}
        onPlay={onHeaderPlay}
        disabled={empty}
        title={page.name}
        sub="Artiste"
        artKey={page.artKey}
        seed={seed}
        round
      />

      <section className="album-hero artist-hero" aria-label={`Artiste ${page.name}`}>
        {resolved && <div key={resolved.vibrant} className="album-hero__bg" aria-hidden="true" />}
        <motion.div
          className="artist-hero__avatar"
          layoutId={m.enabled ? artistLayoutId(page.name) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: "50%" }}
        >
          <CoverArt artKey={page.artKey} seed={seed} alt={page.name} placeholder={resolved?.dominant} />
        </motion.div>
        <motion.div className="album-hero__meta" {...enter(0)}>
          <div className="album-hero__kind">Artiste</div>
          <h1 className="album-hero__title artist-hero__name" title={page.name}>
            {page.name}
          </h1>
          <p className="album-hero__sub num">{sub}</p>
        </motion.div>
      </section>

      <motion.div className="album-actions" ref={actionsRef} {...enter(1)}>
        <Button variant="primary" icon={isPlaying ? Pause : Play} onClick={onHeaderPlay} disabled={empty}>
          {isPlaying ? "Pause" : "Lecture"}
        </Button>
        <Button variant="ghost" icon={Shuffle} onClick={() => shuffleArtist(page.name, playList, actions)} disabled={empty}>
          Aléatoire
        </Button>
        <IconButton
          label="Plus d'actions"
          icon={Ellipsis}
          variant="solid"
          size={40}
          aria-haspopup="menu"
          onClick={(e) => void openMoreMenu(e)}
        />
      </motion.div>

      {page.albums.length > 0 && (
        <motion.section className="artist-section" aria-label="Albums" {...enter(2)}>
          <h2 className="artist-section__title">Albums</h2>
          <AlbumShelf albums={page.albums} currentAlbumId={currentAlbumId} onPlay={onAlbumPlay} onMenu={onAlbumMenu} />
        </motion.section>
      )}

      {page.appearsOn.length > 0 && (
        <motion.section className="artist-section" aria-label="Apparaît sur" {...enter(3)}>
          <h2 className="artist-section__title">Apparaît sur</h2>
          <AlbumShelf albums={page.appearsOn} currentAlbumId={currentAlbumId} onPlay={onAlbumPlay} onMenu={onAlbumMenu} />
        </motion.section>
      )}

      {rows.length > 0 && (
        <motion.section className="artist-section artist-tracks" aria-label="Titres" {...enter(4)}>
          <h2 className="artist-section__title">
            Titres
            {groups && groups.length !== page.tracks.length && (
              <span className="artist-section__meta num">
                {groups.length} morceaux · {page.tracks.length} fichiers
              </span>
            )}
          </h2>
          <div className="track-head" aria-hidden="true">
            <span className="track-head__num">#</span>
            <span>Titre</span>
            <span>Artiste</span>
            <span>Album</span>
            <span />
            <span className="track-head__dur">
              <Clock3 size={14} strokeWidth={ICON_STROKE} />
            </span>
          </div>
          <div
            className="track-list artist-track-list"
            role="list"
            data-track-list=""
            aria-label={`Titres de ${page.name}`}
            style={{ "--tv-dur": `${m.d(dur.base)}s` } as React.CSSProperties}
          >
            {rows.map((r, i) => {
              const t = r.track;
              const isVersion = r.depth === 1;
              if (!isVersion) ordinal++;
              const next = rows[i + 1];
              const lastVersion = isVersion && !(next && next.depth === 1 && next.groupId === r.groupId);
              const item = (
                <TrackRowItem
                  key={t.id}
                  track={t}
                  index={i}
                  number={isVersion ? undefined : ordinal}
                  hideNumber={isVersion}
                  tabbable={t.id === tabStopId}
                  onFocusRow={onRowFocus}
                  playing={t.id === currentTrackId}
                  selected={t.id === selected}
                  onPlay={onRowPlay}
                  onSelect={onRowSelect}
                  onContextMenu={onRowMenu}
                  titleAddon={addons.get(t.id)}
                  displayTitle={isVersion && r.tag ? versionName(t.title) : undefined}
                  className={isVersion ? (lastVersion ? "is-version is-version-last" : "is-version") : undefined}
                />
              );
              // Version dépliée : entre en fondu sous son lead (cascade brève, coupée en mouvement réduit).
              return isVersion ? (
                <div
                  key={t.id}
                  className="artist-version-in"
                  role="presentation"
                  style={{ "--sub": i - (indexOf.get(r.groupId) ?? i) } as React.CSSProperties}
                >
                  {item}
                </div>
              ) : (
                item
              );
            })}
          </div>
        </motion.section>
      )}
    </div>
  );
}

/** Albums d'une section, en grille qui passe à la ligne (tuiles de la grille Albums). */
function AlbumShelf({
  albums,
  currentAlbumId,
  onPlay,
  onMenu,
}: {
  albums: readonly Album[];
  currentAlbumId: number | null;
  onPlay(album: Album): void;
  onMenu(album: Album, e: React.MouseEvent<HTMLElement>): void;
}): JSX.Element {
  return (
    <div className="artist-shelf" role="list">
      {albums.map((a) => (
        <div key={a.id} role="listitem" className="album-grid__cell">
          <AlbumTile album={a} playing={a.id === currentAlbumId} onPlay={onPlay} onContextMenu={onMenu} />
        </div>
      ))}
    </div>
  );
}

/** Squelette de la page artiste (bibliothèque en cours de chargement). */
function ArtistSkeleton(): JSX.Element {
  return (
    <div className="album-view artist-view" aria-busy="true" aria-label="Chargement">
      <section className="album-hero artist-hero">
        <div className="artist-hero__avatar">
          <Skeleton h="100%" radius="50%" />
        </div>
        <div className="album-hero__meta">
          <Skeleton w={60} h={10} radius={5} />
          <Skeleton w={280} h={44} radius={10} style={{ marginTop: 12 }} />
          <Skeleton w={140} h={14} radius={7} style={{ marginTop: 14 }} />
        </div>
      </section>
    </div>
  );
}

