import type React from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import { MicVocal, Pause, Play } from "lucide-react";
import { setDragTracks } from "../lib/dnd";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import {
  artistInitial,
  artistRail,
  artistShowsPause,
  gridLayout,
  groupArtists,
  letterIndex,
  type ArtistGroup,
  type RailEntry,
} from "../lib/viewModels";
import { useLibrary } from "../state/library";
import { useSettings } from "../state/settings";
import { usePlayer } from "../state/player";
import { uiStore } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { plannedScroll } from "../shell/scrollMemory";
import { dur, ease } from "../theme/ds/motion";
import { CoverArt } from "../ui/CoverArt";
import { Equalizer } from "../ui/Equalizer";
import { openMenu } from "../ui/menuStore";
import { Skeleton } from "../ui/Skeleton";
import { useMotion } from "../ui/useMotion";
import { artistLayoutId, artistMenuItems, artistQueueOf, libraryIndex, playArtist } from "./artistPlay";
import { EmptyState, PageHeader } from "./common";
import { anchorFromEvent } from "./menus";
import "./views.css";
import "./artists.css";

export interface ArtistsViewProps {
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/** Largeur minimale d'une tuile, gouttières (px). */
const MIN_TILE = 148;
const GAP_X = 24;
const GAP_Y = 26;
/** Sous l'avatar : 14 px d'air + nom 20 + 2 + sous-titre 18. */
const META_H = 56;
const OVERSCAN = 2;
const ENTER_WINDOW_MS = 900;
const PAGE_X = 32;
/** Rail alphabétique : hauteur idéale d'une lettre, hauteur minimale pour l'afficher (px). */
const RAIL_STEP = 16;
const RAIL_MIN_H = 240;

/**
 * Écran Artistes : un artiste par artiste d'album (`groupArtists`, insensible à la casse), en
 * grille VIRTUALISÉE d'avatars ronds (la première pochette de l'artiste), nom et « n albums ».
 * Clic / Entrée : page de l'artiste (l'avatar y voyage, `layoutId`). Survol : la tuile se soulève,
 * un bouton lecture lit tout l'artiste. Clic droit : Lire / Lire ensuite / Ajouter à la file /
 * Aléatoire. Flèches : tuile voisine. Rail A–Z à droite : saute à une lettre (clic ou glisser).
 */
export function ArtistsView({ scrollRef, actions }: ArtistsViewProps): JSX.Element {
  const albums = useLibrary((s) => s.albums);
  const loading = useLibrary((s) => s.loading);
  const artists = useMemo(() => groupArtists(albums, libraryIndex(albums)), [albums]);

  const sub = loading && albums.length === 0 ? null : `${artists.length} ${artists.length > 1 ? "artistes" : "artiste"}`;

  let body: JSX.Element;
  if (loading && albums.length === 0) {
    body = <ArtistsSkeleton />;
  } else if (artists.length === 0) {
    body = (
      <EmptyState
        icon={MicVocal}
        title="Aucun artiste"
        text="Ajoute un dossier de musique depuis l'accueil pour remplir ta bibliothèque."
      />
    );
  } else {
    body = <ArtistGrid artists={artists} scrollRef={scrollRef} actions={actions} />;
  }

  return (
    <div className="artists-view">
      <PageHeader title="Artistes" sub={sub} />
      {body}
    </div>
  );
}

function ArtistGrid({
  artists,
  scrollRef,
  actions,
}: {
  artists: readonly ArtistGroup[];
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [restoreTop] = useState(() => plannedScroll("artists"));
  const [layout, setLayout] = useState(() =>
    gridLayout(Math.max(0, (scrollRef.current?.clientWidth ?? 0) - 2 * PAGE_X), MIN_TILE, GAP_X),
  );
  const [scrollMargin, setScrollMargin] = useState(0);
  const [entering, setEntering] = useState(restoreTop === null);
  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);

  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const recompute = (): void => {
      const next = gridLayout(el.clientWidth, MIN_TILE, GAP_X);
      setLayout((prev) => (prev.cols === next.cols && prev.cardW === next.cardW ? prev : next));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const measureMargin = useCallback((): void => {
    const el = wrapperRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const next = Math.max(0, Math.round(offset));
    setScrollMargin((prev) => (prev === next ? prev : next));
  }, [scrollRef]);

  useLayoutEffect(() => {
    measureMargin();
  }, [measureMargin, artists.length, layout.cols]);

  useEffect(() => {
    const head = wrapperRef.current?.parentElement;
    if (!head) return;
    const ro = new ResizeObserver(measureMargin);
    ro.observe(head);
    return () => ro.disconnect();
  }, [measureMargin]);

  useEffect(() => {
    const id = setTimeout(() => setEntering(false), ENTER_WINDOW_MS);
    return () => clearTimeout(id);
  }, []);

  const { cols, cardW } = layout;
  const rowCount = Math.ceil(artists.length / cols);
  const rowHeight = cardW + META_H + GAP_Y;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    scrollMargin,
    scrollPaddingStart: 8,
    initialOffset: restoreTop ?? 0,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const rows = virtualizer.getVirtualItems();
  const names = useMemo(() => artists.map((a) => a.name), [artists]);
  /** Premier artiste de chaque lettre (saisie rapide) et entrées du rail A–Z. */
  const letters = useMemo(() => letterIndex(names), [names]);
  const rail = useMemo(() => artistRail(names), [names]);

  // Tabulation itinérante : UN arrêt de tabulation pour toute la grille (la dernière tuile
  // focalisée, sinon la première montée) ; les flèches déplacent le focus.
  const [tabStop, setTabStop] = useState(0);
  const firstMounted = (rows[0]?.index ?? 0) * cols;
  const lastMounted = Math.min(artists.length, ((rows.at(-1)?.index ?? 0) + 1) * cols) - 1;
  const tabIndexStop = tabStop >= firstMounted && tabStop <= lastMounted ? tabStop : firstMounted;
  const onGridFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
    const ai = (e.target as HTMLElement).dataset?.ai;
    if (ai !== undefined) setTabStop(Number(ai));
  };

  // Callbacks STABLES (tuiles mémoïsées) : l'état courant est lu au clic.
  const onPlay = useCallback(
    (artist: ArtistGroup): void => playArtist(artist.name, artistQueueOf(artist.name), actions),
    [actions],
  );
  const onContextMenu = useCallback(
    (artist: ArtistGroup, e: React.MouseEvent<HTMLElement>): void => {
      const a = anchorFromEvent(e);
      openMenu(a.x, a.y, artistMenuItems(artist.name, actions), { focusFirst: a.focusFirst });
    },
    [actions],
  );

  /** Amène la tuile `index` à l'écran puis lui donne le focus (elle peut être démontée). */
  const focusIndex = useCallback(
    (index: number): void => {
      const row = Math.floor(index / cols);
      virtualizer.scrollToIndex(row, { align: "auto" });
      let tries = 0;
      const attempt = (): void => {
        const el = wrapperRef.current?.querySelector<HTMLElement>(`[data-ai="${index}"]`);
        if (el) el.focus({ preventScroll: true });
        else if (++tries < 6) requestAnimationFrame(attempt);
      };
      requestAnimationFrame(attempt);
    },
    [cols, virtualizer],
  );

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>("[data-ai]");
    if (!tile || e.target !== tile || e.altKey || e.ctrlKey || e.metaKey) return;
    // Maj+flèches / Maj+Début/Fin : raccourcis globaux (avancer / reculer), jamais avalés ici.
    if (e.shiftKey && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) return;
    const i = Number(tile.dataset.ai);
    const last = artists.length - 1;
    let target: number | null = null;
    if (e.key === "ArrowRight") target = Math.min(last, i + 1);
    else if (e.key === "ArrowLeft") target = Math.max(0, i - 1);
    else if (e.key === "ArrowDown") target = Math.min(last, i + cols);
    else if (e.key === "ArrowUp") target = Math.max(0, i - cols);
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = last;
    else if (/^[\p{L}\p{N}]$/u.test(e.key)) {
      // Saisie rapide : une lettre (ou un chiffre → « # ») amène au premier artiste de la lettre.
      target = letters.get(artistInitial(e.key)) ?? null;
    }
    if (target === null) return;
    e.preventDefault();
    if (target !== i) focusIndex(target);
  };

  // --- Rail alphabétique ----------------------------------------------------------------------
  const jumpTo = useCallback(
    (i: number): void => {
      const row = Math.floor(i / cols);
      if (row === 0) scrollRef.current?.scrollTo({ top: 0 });
      else virtualizer.scrollToIndex(row, { align: "start" });
    },
    [cols, scrollRef, virtualizer],
  );
  // Entrée courante : la dernière dont le premier artiste est au plus sur la première rangée visible
  // (les index du rail croissent : « # » de tête, A–Z, « # » de fin).
  const firstRow = Math.max(0, Math.floor(((virtualizer.scrollOffset ?? 0) - scrollMargin + 8) / rowHeight));
  const firstVisible = Math.min(artists.length - 1, firstRow * cols);
  let activeEntry = -1;
  rail.forEach((r, k) => {
    if (r.index !== null && r.index <= firstVisible) activeEntry = k;
  });

  return (
    <div className="artists-grid-wrap">
      <AlphaRail scrollRef={scrollRef} entries={rail} active={activeEntry} onJump={jumpTo} />
      <div
        ref={wrapperRef}
        className="album-grid artist-grid"
        role="list"
        aria-label="Artistes"
        style={{ height: Math.max(0, virtualizer.getTotalSize() - GAP_Y) }}
        onKeyDown={onGridKeyDown}
        onFocus={onGridFocus}
      >
        {rows.map((row) => {
          const start = row.index * cols;
          const rowArtists = artists.slice(start, start + cols);
          return (
            <div
              key={row.key}
              className="album-grid__row"
              role="presentation"
              style={{
                transform: `translateY(${row.start - scrollMargin}px)`,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                columnGap: GAP_X,
              }}
            >
              {rowArtists.map((artist, i) => (
                <div key={artist.name} role="listitem" className="album-grid__cell">
                  <ArtistTile
                    artist={artist}
                    index={start + i}
                    tabbable={start + i === tabIndexStop}
                    playing={currentAlbumId !== null && artist.albums.some((a) => a.id === currentAlbumId)}
                    onPlay={onPlay}
                    onContextMenu={onContextMenu}
                    enterIndex={entering ? start + i : null}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------ Tuile ------------------------------------------ */

interface ArtistTileProps {
  artist: ArtistGroup;
  /** Position dans la grille (navigation aux flèches). */
  index: number;
  /** Seule tuile dans l'ordre de tabulation (tabulation itinérante). */
  tabbable: boolean;
  /** Un de ses albums contient le titre en cours. */
  playing: boolean;
  onPlay(artist: ArtistGroup): void;
  onContextMenu(artist: ArtistGroup, e: React.MouseEvent<HTMLElement>): void;
  enterIndex: number | null;
}

/** Libellé sous le nom : toujours la même unité, « 12 titres ». */
export function artistCountLabel(artist: Pick<ArtistGroup, "trackCount">): string {
  return `${artist.trackCount} ${artist.trackCount > 1 ? "titres" : "titre"}`;
}

const ArtistTile = memo(function ArtistTile({
  artist,
  index,
  tabbable,
  playing,
  onPlay,
  onContextMenu,
  enterIndex,
}: ArtistTileProps): JSX.Element {
  const m = useMotion();
  const seed = `artist:${artist.name}`;
  const colors = useCoverColors(artist.artKey, seed);
  const known = artist.artKey ? coverColorCache.peek(artist.artKey) : colors;
  const artRef = useRef<HTMLDivElement>(null);

  const open = (): void => uiStore.getState().navigate({ name: "artist", artist: artist.name });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    }
  };

  const onDragStart = (e: React.DragEvent<HTMLDivElement>): void => {
    setDragTracks(e.dataTransfer, artistQueueOf(artist.name).map((t) => t.id));
    const art = artRef.current;
    if (art) e.dataTransfer.setDragImage(art, art.offsetWidth / 2, art.offsetHeight / 2);
  };

  const style =
    enterIndex !== null && m.enabled
      ? ({ "--enter-delay": `${Math.min(enterIndex, 24) * 28}ms` } as React.CSSProperties)
      : undefined;
  const count = artistCountLabel(artist);

  return (
    <div
      className={`artist-tile${playing ? " is-playing" : ""}${enterIndex !== null && m.enabled ? " is-entering" : ""}`}
      style={style}
      tabIndex={tabbable ? 0 : -1}
      role="group"
      data-ai={index}
      aria-label={`${artist.name}, ${count}`}
      aria-current={playing ? "true" : undefined}
      aria-keyshortcuts="Enter"
      draggable
      onDragStart={onDragStart}
      onClick={open}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(artist, e);
      }}
    >
      <div className="artist-tile__lift">
        <span className="artist-tile__glow" style={{ background: known?.vibrant ?? "transparent" }} aria-hidden="true" />
        <motion.div
          ref={artRef}
          className="artist-tile__art"
          layoutId={m.enabled ? artistLayoutId(artist.name) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: "50%" }}
        >
          <span className="artist-tile__zoom">
            <CoverArt artKey={artist.artKey} seed={seed} placeholder={known?.dominant} />
          </span>
        </motion.div>
        {playing && (
          <span className="artist-tile__eq">
            <Equalizer />
          </span>
        )}
        <ArtistPlayButton artist={artist} onPlay={onPlay} />
      </div>
      <div className="artist-tile__meta">
        <div className="artist-tile__name" title={artist.name}>
          {artist.name}
        </div>
        <div className="artist-tile__count num">{count}</div>
      </div>
    </div>
  );
});

/**
 * Bouton lecture de l'avatar : « Pause » ssi le lecteur joue la file de CET artiste — quel que soit
 * l'album du titre courant (une apparition compte aussi) ; le clic fait alors pause, sinon lit.
 */
function ArtistPlayButton({
  artist,
  onPlay,
}: {
  artist: ArtistGroup;
  onPlay(artist: ArtistGroup): void;
}): JSX.Element {
  const playing = usePlayer((s) => s.status === "playing");
  const queue = usePlayer((s) => s.queue);
  const albums = useLibrary((s) => s.albums);
  const grouped = useSettings((s) => s.groupVersions);
  // Recalcul seulement quand la file, la bibliothèque ou le regroupement changent (pas à chaque frame).
  const showPause = useMemo(
    () => playing && queue.length > 0 && artistShowsPause(queue, playing, artistQueueOf(artist.name)),
    [playing, queue, albums, grouped, artist.name],
  );
  const Icon = showPause ? Pause : Play;
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`artist-tile__play${showPause ? " is-current" : ""}`}
      aria-label={showPause ? `Mettre en pause ${artist.name}` : `Lire ${artist.name}`}
      title={showPause ? "Pause" : "Lire"}
      disabled={artist.trackCount === 0}
      onClick={(e) => {
        e.stopPropagation();
        onPlay(artist);
      }}
    >
      <Icon size={20} strokeWidth={0} fill="currentColor" aria-hidden />
    </button>
  );
}

/* ------------------------------------ Rail alphabétique ------------------------------------ */

/**
 * Rail A–Z collé à droite (comme Apple Music) : clic ou glisser vertical → saute à la première
 * rangée de la lettre. Lettres sans artiste estompées ; la lettre de la première rangée visible
 * est à l'accent. Masqué si la fenêtre est trop basse pour des lettres lisibles.
 */
function AlphaRail({
  scrollRef,
  entries,
  active,
  onJump,
}: {
  scrollRef: React.RefObject<HTMLElement>;
  entries: readonly RailEntry[];
  /** Rang de l'entrée courante dans `entries` (-1 : aucune). */
  active: number;
  onJump(index: number): void;
}): JSX.Element | null {
  const [height, setHeight] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = (): void => setHeight(Math.min(entries.length * RAIL_STEP, scroller.clientHeight - 140));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scrollRef, entries.length]);

  if (height < RAIL_MIN_H) return null;

  const entryAt = (clientY: number): number | null => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r || r.height <= 0) return null;
    const k = Math.floor(((clientY - r.top) / r.height) * entries.length);
    return Math.max(0, Math.min(entries.length - 1, k));
  };
  const scrub = (clientY: number): void => {
    const k = entryAt(clientY);
    if (k === null || k === dragging.current) return;
    dragging.current = k;
    const target = entries[k]?.index;
    if (target !== null && target !== undefined) onJump(target);
  };

  return (
    <div className="alpha-rail-anchor">
      <div
        ref={railRef}
        className="alpha-rail"
        aria-hidden="true"
        title="Index alphabétique"
        style={{ height }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = null;
          scrub(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e.clientY);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          dragging.current = null;
        }}
      >
        {entries.map((entry, k) => (
          // Hors tabulation : au clavier, taper une lettre dans la grille y saute déjà. Pas de
          // `disabled` (il avalerait le glisser commencé sur une lettre vide).
          <span
            key={`${entry.label}-${k}`}
            className={`alpha-rail__l${k === active ? " is-active" : ""}${entry.index === null ? " is-empty" : ""}`}
            aria-hidden="true"
          >
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Avatars fantômes pendant le premier chargement. */
function ArtistsSkeleton(): JSX.Element {
  return (
    <div className="grid-skel artists-skel" aria-busy="true" aria-label="Chargement">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="grid-skel-card artists-skel__card">
          <div className="grid-skel-art">
            <Skeleton h="100%" radius="50%" />
          </div>
          <Skeleton w={`${50 + ((i * 29) % 30)}%`} h={12} radius={6} />
          <Skeleton w="34%" h={10} radius={5} />
        </div>
      ))}
    </div>
  );
}
