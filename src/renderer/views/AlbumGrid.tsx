import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Album } from "../lib/library";
import { gridLayout } from "../lib/viewModels";
import { usePlayer } from "../state/player";
import { plannedScroll } from "../shell/scrollMemory";
import { AlbumTile } from "../ui/AlbumTile";
import "./views.css";

export interface AlbumGridProps {
  albums: readonly Album[];
  /** Conteneur de défilement (`.shell-scroll`). */
  scrollRef: React.RefObject<HTMLElement>;
  onPlay(album: Album): void;
  onContextMenu?(album: Album, e: React.MouseEvent<HTMLElement>): void;
  /**
   * Clé de mémoire du défilement (ex. la clé de route) : en revenant d'une page album par
   * « Précédent », la grille reprend où on l'avait laissée (sans rejouer la cascade d'entrée).
   */
  memoryKey?: string;
}

/** Largeur minimale d'une tuile, gouttières horizontale / verticale (px). */
const MIN_TILE = 176;
const GAP_X = 24;
const GAP_Y = 28;
/** Bloc texte sous la pochette : 12 px d'air + titre 20 + 3 + artiste 18 (+ marge). */
const META_H = 58;
/** Rangées montées hors écran de chaque côté (défilement fluide sans gonfler le DOM). */
const OVERSCAN = 2;
/** Durée pendant laquelle les rangées montées jouent la cascade d'entrée (premier affichage). */
const ENTER_WINDOW_MS = 900;
/** Marge horizontale de page (`--page-x`) : estimation de largeur avant la première mesure. */
const PAGE_X = 32;

/**
 * Grille d'albums VIRTUALISÉE (`@tanstack/react-virtual`) : on ne monte que les rangées visibles
 * (+ 2 de marge), quel que soit le nombre d'albums (~784). Le nombre de colonnes suit la largeur
 * (ResizeObserver, `gridLayout`) ; chaque rangée est positionnée en `translateY` dans un conteneur
 * de la hauteur totale. `scrollMargin` compense l'en-tête de page au-dessus de la grille.
 */
export function AlbumGrid({ albums, scrollRef, onPlay, onContextMenu, memoryKey }: AlbumGridProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Retour par « Précédent » : position annoncée par le RouteView (déjà appliquée au conteneur
  // avant la mesure du layout) ; les bonnes rangées sont montées dès le premier rendu.
  const [restoreTop] = useState(() => (memoryKey ? plannedScroll(memoryKey) : null));
  // Largeur estimée dès le premier rendu (le conteneur existe déjà) : les tuiles montées au
  // premier rendu sont les bonnes, la pochette partagée retrouve donc sa tuile.
  const [layout, setLayout] = useState(() =>
    gridLayout(Math.max(0, (scrollRef.current?.clientWidth ?? 0) - 2 * PAGE_X), MIN_TILE, GAP_X),
  );
  const [scrollMargin, setScrollMargin] = useState(0);
  const [entering, setEntering] = useState(restoreTop === null);
  const currentAlbumId = usePlayer((s) => s.currentTrack?.albumId ?? null);

  // Colonnes + largeur de tuile depuis la largeur du conteneur.
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

  // Décalage de la grille dans le conteneur défilant (en-tête de page au-dessus).
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
  }, [measureMargin, albums.length, layout.cols]);

  // L'en-tête peut changer de hauteur (polices chargées, fenêtre redimensionnée).
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
  const rowCount = Math.ceil(albums.length / cols);
  const rowHeight = cardW + META_H + GAP_Y;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    scrollMargin,
    initialOffset: restoreTop ?? 0,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const rows = virtualizer.getVirtualItems();

  return (
    <div
      ref={wrapperRef}
      className="album-grid"
      role="list"
      aria-label="Albums"
      style={{ height: Math.max(0, virtualizer.getTotalSize() - GAP_Y) }}
    >
      {rows.map((row) => {
        const start = row.index * cols;
        const rowAlbums = albums.slice(start, start + cols);
        return (
          <div
            key={row.key}
            className="album-grid__row"
            role="presentation"
            data-row={row.index}
            style={{
              transform: `translateY(${row.start - scrollMargin}px)`,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              columnGap: GAP_X,
            }}
          >
            {rowAlbums.map((album, i) => (
              <div key={album.id} role="listitem" className="album-grid__cell">
                <AlbumTile
                  album={album}
                  playing={album.id === currentAlbumId}
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
  );
}
