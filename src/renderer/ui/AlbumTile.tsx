import type React from "react";
import { memo, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { GoldMedallion } from "./GoldMedallion";
import { cancelPrefetch, prefetchNow, prefetchOnHover } from "../runtime/prefetch";
import type { Album } from "../lib/library";
import { setDragTracks } from "../lib/dnd";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import { uiStore } from "../state/ui";
import { usePlayer } from "../state/player";
import { dur, ease } from "../theme/ds/motion";
import { CoverArt } from "./CoverArt";
import { Equalizer } from "./Equalizer";
import { useMotion } from "./useMotion";
import "./tiles.css";

export interface AlbumTileProps {
  album: Album;
  /** L'album contient le titre en cours (équaliseur, titre à l'accent, bouton pause). */
  playing: boolean;
  /** Bouton lecture de la pochette / touche Entrée. */
  onPlay(album: Album): void;
  /** Clic droit (ou touche Menu / Maj+F10) : menu contextuel. */
  onContextMenu?(album: Album, e: React.MouseEvent<HTMLElement>): void;
  /** Ordre d'apparition (cascade d'entrée de la première page de la grille) ; `null` = sans. */
  enterIndex?: number | null;
}

/** Identifiant d'élément partagé pochette tuile → en-tête de la page album. */
export const coverLayoutId = (albumId: number): string => `cover-album-${albumId}`;

/** Rayon de la pochette (porté en style pour que framer-motion le corrige pendant le voyage). */
const TILE_RADIUS = 12;

/**
 * Tuile d'album de la grille. Clic = ouvre la page album (la pochette y voyage, `layoutId`) ;
 * Entrée = lit l'album ; Maj+Entrée = ouvre. Survol : la tuile se soulève de 6 px, la pochette
 * zoome à 1.05, le bouton lecture monte. Glissable (pistes de l'album). Le titre complet est en
 * infobulle quand il est tronqué.
 */
function AlbumTileImpl({ album, playing, onPlay, onContextMenu, enterIndex = null }: AlbumTileProps): JSX.Element {
  const m = useMotion();
  const seed = `${album.id}:${album.title}`;
  const colors = useCoverColors(album.artKey, seed);
  // Teinte d'attente : seulement une couleur déjà extraite (jamais le repli génératif, faux ton).
  const known = album.artKey ? coverColorCache.peek(album.artKey) : colors;
  const artRef = useRef<HTMLDivElement>(null);
  const label = album.artist ? `${album.title} — ${album.artist}` : album.title;

  const open = useCallback((): void => {
    uiStore.getState().navigate({ name: "album", id: album.id });
  }, [album.id]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) open();
      else onPlay(album);
    }
  };

  const onDragStart = (e: React.DragEvent<HTMLDivElement>): void => {
    setDragTracks(e.dataTransfer, album.tracks.map((t) => t.id));
    const art = artRef.current;
    if (art) e.dataTransfer.setDragImage(art, art.offsetWidth / 2, art.offsetHeight / 2);
  };

  const style =
    enterIndex !== null && m.enabled
      ? ({ "--enter-delay": `${Math.min(enterIndex, 24) * 28}ms` } as React.CSSProperties)
      : undefined;

  return (
    <div
      className={`album-tile${playing ? " is-playing" : ""}${enterIndex !== null && m.enabled ? " is-entering" : ""}`}
      style={style}
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-current={playing ? "true" : undefined}
      aria-keyshortcuts="Enter Shift+Enter"
      draggable
      onDragStart={onDragStart}
      onClick={open}
      onKeyDown={onKeyDown}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(album, e);
            }
          : undefined
      }
    >
      <div className="album-tile__lift">
        <span
          className="album-tile__glow"
          style={{ background: known?.vibrant ?? "transparent" }}
          aria-hidden="true"
        />
        <motion.div
          ref={artRef}
          className="album-tile__art"
          layoutId={m.enabled ? coverLayoutId(album.id) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: TILE_RADIUS }}
        >
          <span className="album-tile__zoom">
            <CoverArt artKey={album.artKey} seed={seed} placeholder={known?.dominant} />
          </span>
        </motion.div>
        {playing && (
          <span className="album-tile__eq">
            <Equalizer />
          </span>
        )}
        <TilePlayButton album={album} current={playing} onPlay={onPlay} />
      </div>
      <div className="album-tile__meta">
        <div className="album-tile__title" title={album.title}>
          {album.title}
        </div>
        {album.artist ? (
          <button
            type="button"
            tabIndex={-1}
            className="album-tile__artist"
            title={album.artist}
            onClick={(e) => {
              e.stopPropagation();
              uiStore.getState().navigate({ name: "artist", artist: album.artist });
            }}
          >
            {album.artist}
          </button>
        ) : (
          <div className="album-tile__artist is-empty">Artiste inconnu</div>
        )}
      </div>
    </div>
  );
}

/**
 * Bouton lecture de la pochette ; « pause » si l'album joue (seule tuile abonnée au statut).
 * DA « Biwa & Or » : c'est le médaillon d'or (`GoldMedallion size="sm"`), pas un bouton rond neutre.
 */
function TilePlayButton({
  album,
  current,
  onPlay,
}: {
  album: Album;
  current: boolean;
  onPlay(album: Album): void;
}): JSX.Element {
  const playing = usePlayer((s) => current && s.status === "playing");
  return (
    <span
      onPointerMove={(event) => {
        // Inclinaison suivant le curseur : 4° au maximum, transform uniquement.
        const rect = event.currentTarget.getBoundingClientRect();
        const dx = (event.clientX - rect.left) / rect.width - 0.5;
        const dy = (event.clientY - rect.top) / rect.height - 0.5;
        event.currentTarget.style.setProperty("--tilt-x", `${(-dy * 4).toFixed(2)}deg`);
        event.currentTarget.style.setProperty("--tilt-y", `${(dx * 4).toFixed(2)}deg`);
      }}
      className={`album-tile__play${current ? " is-current" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={() => prefetchNow(album.tracks[0] ?? null)}
      onPointerEnter={() => prefetchOnHover(album.tracks[0] ?? null)}
      onPointerLeave={(event) => {
        event.currentTarget.style.setProperty("--tilt-x", "0deg");
        event.currentTarget.style.setProperty("--tilt-y", "0deg");
        cancelPrefetch();
      }}
    >
      <GoldMedallion
        playing={playing}
        size="sm"
        onToggle={() => onPlay(album)}
        disabled={album.tracks.length === 0}
        label={playing ? `Mettre en pause ${album.title}` : `Lire ${album.title}`}
        title={playing ? "Pause" : "Lire"}
      />
    </span>
  );
}

export const AlbumTile = memo(AlbumTileImpl);




