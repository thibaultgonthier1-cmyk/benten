import type React from "react";
import { memo } from "react";
import { Heart, Pause, Play } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import { formatTime } from "../lib/library";
import { setDragTracks } from "../lib/dnd";
import { playerStore, usePlayer } from "../state/player";
import { uiStore } from "../state/ui";
import { Equalizer } from "./Equalizer";
import { ICON_STROKE } from "./IconButton";
import "./tiles.css";

export interface TrackRowItemProps {
  track: TrackRow;
  /** Position affichée (0-based) : le n° montré est `index + 1`. */
  index: number;
  /** Titre en cours de lecture (équaliseur à la place du n°, titre à l'accent). */
  playing: boolean;
  selected: boolean;
  /** Lecture (double-clic, Entrée, bouton du survol). Sur le titre courant : bascule lecture/pause. */
  onPlay(track: TrackRow, index: number): void;
  /** Clic simple : sélection. */
  onSelect?(track: TrackRow, index: number): void;
  onContextMenu?(track: TrackRow, e: React.MouseEvent<HTMLElement>): void;
  /** Glissable vers une playlist / la file (défaut : oui). */
  draggable?: boolean;
  /** Colonne album (inutile sur la page de l'album lui-même). */
  showAlbum?: boolean;
}

/** Déplace le focus vers la ligne précédente / suivante de la même liste. */
function focusSibling(row: HTMLElement, dir: 1 | -1): void {
  const list = row.closest("[data-track-list]");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-track-row]"));
  const next = rows[rows.indexOf(row) + dir];
  next?.focus();
}

/**
 * Ligne de titre : n° (ou équaliseur si en cours ; bouton lecture au survol), titre, artiste
 * (lien), album (lien), cœur (bascule favori), durée en chiffres tabulaires. Focalisable :
 * Entrée lit, ↑/↓ passent à la ligne voisine, Menu / Maj+F10 ouvre le menu contextuel.
 */
function TrackRowItemImpl({
  track,
  index,
  playing,
  selected,
  onPlay,
  onSelect,
  onContextMenu,
  draggable = true,
  showAlbum = true,
}: TrackRowItemProps): JSX.Element {
  const favorite = usePlayer((s) => s.favoriteIds.has(track.id));
  const statusPlaying = usePlayer((s) => playing && s.status === "playing");
  const unplayable = track.playable === false;
  const PlayIcon = statusPlaying ? Pause : Play;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onPlay(track, index);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusSibling(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <div
      className={
        "track-row" +
        (showAlbum ? "" : " no-album") +
        (playing ? " is-playing" : "") +
        (selected ? " is-selected" : "") +
        (unplayable ? " is-unplayable" : "")
      }
      data-track-row=""
      role="listitem"
      tabIndex={0}
      aria-label={`${track.title}${track.artist ? ` — ${track.artist}` : ""}`}
      aria-current={playing ? "true" : undefined}
      data-selected={selected || undefined}
      draggable={draggable}
      onDragStart={draggable ? (e) => setDragTracks(e.dataTransfer, [track.id]) : undefined}
      onClick={() => onSelect?.(track, index)}
      onDoubleClick={() => onPlay(track, index)}
      onKeyDown={onKeyDown}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onSelect?.(track, index);
              onContextMenu(track, e);
            }
          : undefined
      }
    >
      <div className="track-row__num num">
        {playing ? <Equalizer className="track-row__eq" /> : <span className="track-row__n">{index + 1}</span>}
        <button
          type="button"
          tabIndex={-1}
          className="track-row__play"
          aria-label={statusPlaying ? `Mettre en pause ${track.title}` : `Lire ${track.title}`}
          disabled={unplayable}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(track, index);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <PlayIcon size={15} strokeWidth={0} fill="currentColor" aria-hidden />
        </button>
      </div>
      <div className="track-row__title" title={track.title}>
        {track.title}
      </div>
      <div className="track-row__artist">
        {track.artist ? (
          <button
            type="button"
            tabIndex={-1}
            className="track-row__link"
            title={track.artist}
            onClick={(e) => {
              e.stopPropagation();
              uiStore.getState().navigate({ name: "artist", artist: track.artist });
            }}
          >
            {track.artist}
          </button>
        ) : null}
      </div>
      {showAlbum && (
        <div className="track-row__album">
          <button
            type="button"
            tabIndex={-1}
            className="track-row__link"
            title={track.album}
            onClick={(e) => {
              e.stopPropagation();
              uiStore.getState().navigate({ name: "album", id: track.albumId });
            }}
          >
            {track.album}
          </button>
        </div>
      )}
      <div className="track-row__fav">
        <button
          type="button"
          tabIndex={-1}
          className={`track-row__heart${favorite ? " is-on" : ""}`}
          aria-label={favorite ? `Retirer ${track.title} des favoris` : `Ajouter ${track.title} aux favoris`}
          aria-pressed={favorite}
          title={favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
          onClick={(e) => {
            e.stopPropagation();
            playerStore.getState().toggleFavorite(track.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Heart size={16} strokeWidth={ICON_STROKE} fill={favorite ? "currentColor" : "none"} aria-hidden />
        </button>
      </div>
      <div className="track-row__dur num">{formatTime(track.durationSec)}</div>
    </div>
  );
}

export const TrackRowItem = memo(TrackRowItemImpl);
