import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Album } from "../lib/library";
import { AlbumCard } from "./AlbumCard";

/**
 * Grille de bibliotheque VIRTUALISEE (`@tanstack/react-virtual`) : avec ~969 titres regroupes en
 * albums, on ne monte que les rangees visibles. On virtualise par RANGEE ; le nombre de colonnes
 * suit la largeur (ResizeObserver) en reproduisant `minmax(172px,1fr)` + gap 20 du prototype.
 *
 * La grille defile dans `.main` (fourni via `scrollRef`) : `scrollMargin` compense la hauteur du
 * bandeau/hero qui precede la grille, et chaque rangee est positionnee en absolu.
 */
export interface LibraryGridProps {
  albums: readonly Album[];
  /** Element scrollable parent (le `.main`). */
  scrollRef: React.RefObject<HTMLElement>;
  playingAlbumId?: number | null;
  onPlay: (album: Album) => void;
  /** Actions optionnelles du menu « ⋯ » de chaque carte (Task 11). */
  onPlayNext?: (album: Album) => void;
  onAddToQueue?: (album: Album) => void;
  onAddToPlaylist?: (album: Album) => void;
}

const MIN_CARD = 172;
const GAP = 20;
const ROW_PAD = 56; // titre + artiste + gap sous la pochette (estimation)

export function LibraryGrid({
  albums,
  scrollRef,
  playingAlbumId,
  onPlay,
  onPlayNext,
  onAddToQueue,
  onAddToPlaylist,
}: LibraryGridProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  const [cardW, setCardW] = useState(MIN_CARD);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Colonnes + largeur de carte depuis la largeur du conteneur (reproduit auto-fill minmax).
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const recompute = (): void => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const c = Math.max(1, Math.floor((w + GAP) / (MIN_CARD + GAP)));
      setCols(c);
      setCardW(Math.floor((w - GAP * (c - 1)) / c));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Decalage de la grille dans le conteneur scrollable (hero/topbar au-dessus).
  const measureMargin = useCallback(() => {
    const el = wrapperRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const offset =
      el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin(Math.max(0, Math.round(offset)));
  }, [scrollRef]);

  useLayoutEffect(() => {
    measureMargin();
  }, [measureMargin, albums.length, cols]);

  useEffect(() => {
    window.addEventListener("resize", measureMargin);
    return () => window.removeEventListener("resize", measureMargin);
  }, [measureMargin]);

  const rowCount = Math.ceil(albums.length / cols);
  const rowHeight = cardW + ROW_PAD + GAP;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
    scrollMargin,
  });

  // Recalcule quand la hauteur de rangee change.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={wrapperRef} style={{ position: "relative", height: virtualizer.getTotalSize() }}>
      {items.map((row) => {
        const start = row.index * cols;
        const rowAlbums = albums.slice(start, start + cols);
        return (
          <div
            key={row.key}
            data-row={row.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start - scrollMargin}px)`,
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: `${GAP}px`,
            }}
          >
            {rowAlbums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                playing={album.id === playingAlbumId}
                onPlay={onPlay}
                onPlayNext={onPlayNext}
                onAddToQueue={onAddToQueue}
                onAddToPlaylist={onAddToPlaylist}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
