import type React from "react";
import { memo, type ReactNode } from "react";
import { Heart } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import { formatTime } from "../lib/library";
import { setDragTracks } from "../lib/dnd";
import { playerStore, usePlayer } from "../state/player";
import { uiStore } from "../state/ui";
import { Equalizer } from "./Equalizer";
import { ICON_STROKE } from "./IconButton";
import { GoldMedallion } from "./GoldMedallion";
import { cancelPrefetch, prefetchNow, prefetchOnHover } from "../runtime/prefetch";
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
  /**
   * Clic simple : sélection. L'événement (clic ou clic droit) donne les modificateurs Ctrl / Maj
   * aux listes à sélection multiple.
   */
  onSelect?(track: TrackRow, index: number, e: React.MouseEvent<HTMLElement>): void;
  onContextMenu?(track: TrackRow, e: React.MouseEvent<HTMLElement>): void;
  /** Glissable vers une playlist / la file (défaut : oui). */
  draggable?: boolean;
  /** Colonne album (inutile sur la page de l'album lui-même). */
  showAlbum?: boolean;
  /** Numéro affiché (ex. n° de piste du tag) ; défaut : `index + 1`. */
  number?: number;
  /**
   * Tabulation itinérante : une seule ligne de la liste est dans l'ordre de tabulation (`true`) ;
   * les flèches déplacent le focus entre lignes. Défaut : focalisable au clavier.
   */
  tabbable?: boolean;
  /** La ligne reçoit le focus (la liste y déplace son arrêt de tabulation). */
  onFocusRow?(track: TrackRow): void;
  /** Ids glissés (ex. toute la sélection) ; défaut : ce seul titre. */
  getDragIds?(track: TrackRow): readonly number[];
  /** Pastilles / contrôles affichés après le titre (versions, chevron…). */
  titleAddon?: ReactNode;
  /** Libellé affiché à la place du titre (sous-ligne de version) ; info-bulle = titre complet. */
  displayTitle?: string;
  /** N° masqué (sous-ligne) ; l'équaliseur et le bouton lecture restent. */
  hideNumber?: boolean;
  /** Classe supplémentaire sur la ligne. */
  className?: string;
}

/** Déplace le focus vers la ligne voisine (`dir` ±1) ou vers la première / dernière (`"first"`/`"last"`). */
function focusSibling(row: HTMLElement, dir: 1 | -1 | "first" | "last"): void {
  const list = row.closest("[data-track-list]");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-track-row]"));
  const next =
    dir === "first" ? rows[0] : dir === "last" ? rows[rows.length - 1] : rows[rows.indexOf(row) + dir];
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
  number,
  tabbable = true,
  onFocusRow,
  getDragIds,
  titleAddon,
  displayTitle,
  hideNumber = false,
  className,
}: TrackRowItemProps): JSX.Element {
  const favorite = usePlayer((s) => s.favoriteIds.has(track.id));
  const statusPlaying = usePlayer((s) => playing && s.status === "playing");
  const unplayable = track.playable === false;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onPlay(track, index);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusSibling(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusSibling(e.currentTarget, e.key === "Home" ? "first" : "last");
    }
  };

  return (
    <div
      className={
        "track-row" +
        (showAlbum ? "" : " no-album") +
        (playing ? " is-playing" : "") +
        (selected ? " is-selected" : "") +
        (unplayable ? " is-unplayable" : "") +
        (className ? ` ${className}` : "")
      }
      data-track-row=""
      role="listitem"
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocusRow ? (e) => e.target === e.currentTarget && onFocusRow(track) : undefined}
      aria-label={`${track.title}${track.artist ? ` — ${track.artist}` : ""}`}
      aria-current={playing ? "true" : undefined}
      data-selected={selected || undefined}
      draggable={draggable}
      onDragStart={
        draggable ? (e) => setDragTracks(e.dataTransfer, getDragIds ? getDragIds(track) : [track.id]) : undefined
      }
      onClick={(e) => onSelect?.(track, index, e)}
      onDoubleClick={() => onPlay(track, index)}
      onKeyDown={onKeyDown}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onSelect?.(track, index, e);
              onContextMenu(track, e);
            }
          : undefined
      }
    >
      <div className="track-row__num num">
        {playing ? (
          <Equalizer className="track-row__eq" />
        ) : hideNumber ? null : (
          <span className="track-row__n">{number ?? index + 1}</span>
        )}
        <span
          className="track-row__play"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={() => prefetchNow(track)}
          onPointerEnter={() => prefetchOnHover(track)}
          onPointerLeave={() => cancelPrefetch()}
        >
          <GoldMedallion
            playing={statusPlaying}
            size="sm"
            onToggle={() => onPlay(track, index)}
            disabled={unplayable}
            label={statusPlaying ? `Mettre en pause ${track.title}` : `Lire ${track.title}`}
            title={statusPlaying ? "Pause" : "Lire"}
          />
        </span>
      </div>
      {titleAddon ? (
        <div className="track-row__title has-addon">
          <span className="track-row__title-text" title={track.title}>
            {displayTitle ?? track.title}
          </span>
          {titleAddon}
        </div>
      ) : (
        <div className="track-row__title" title={track.title}>
          {displayTitle ?? track.title}
        </div>
      )}
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


