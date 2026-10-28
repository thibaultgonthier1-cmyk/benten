import { memo, useState } from "react";
import type { Album } from "../lib/library";
import { coverAccent, Cover } from "./Cover";
import { QualityBadge } from "./QualityBadge";

/**
 * Carte d'album : pochette (vraie via `benten-art://` ou repli generatif), badge qualite de la
 * source, badge lecture magenta au survol, titre + artiste. Clic sur la carte = jouer l'album.
 *
 * Un bouton d'actions « ⋯ » (FRERE du bouton-carte, jamais imbrique dedans — on evite
 * l'interactif-dans-interactif signale a la revue Phase 1) ouvre un petit menu DA : « Lire ensuite »,
 * « Ajouter à la file », « Ajouter à une playlist ». Il n'apparait que si les callbacks sont fournis.
 */
export interface AlbumCardProps {
  album: Album;
  playing?: boolean;
  onPlay: (album: Album) => void;
  /** Insère l'album juste après la piste courante. */
  onPlayNext?: (album: Album) => void;
  /** Ajoute l'album en fin de file. */
  onAddToQueue?: (album: Album) => void;
  /** Ouvre la feuille « Ajouter à une playlist » pour l'album. */
  onAddToPlaylist?: (album: Album) => void;
}

function AlbumCardImpl({
  album,
  playing = false,
  onPlay,
  onPlayNext,
  onAddToQueue,
  onAddToPlaylist,
}: AlbumCardProps): JSX.Element {
  const first = album.tracks[0];
  const seed = `${album.id}:${album.title}`;
  const accent = album.artKey ? "transparent" : coverAccent(seed);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenu = Boolean(onPlayNext || onAddToQueue || onAddToPlaylist);
  const close = (): void => setMenuOpen(false);

  return (
    <div className="card-wrap">
      <button
        type="button"
        className={"card" + (playing ? " playing" : "")}
        onClick={() => onPlay(album)}
        title={`${album.title} — ${album.artist}`}
      >
        <div className="cover">
          <span className="glow" style={{ background: accent }} />
          <Cover artKey={album.artKey} seed={seed} size={256} alt={album.title} />
          {first && <QualityBadge track={first} variant="badge" />}
          <span className="play-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </div>
        <p className="t">{album.title}</p>
        <p className="a">{album.artist}</p>
      </button>

      {hasMenu && (
        <button
          className={"card-menu" + (menuOpen ? " active" : "")}
          type="button"
          aria-label={`Actions pour ${album.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      )}

      {hasMenu && menuOpen && (
        <>
          <button
            className="card-menu-scrim"
            type="button"
            aria-label="Fermer le menu"
            onClick={close}
          />
          <div className="card-menu-pop" role="menu">
            {onPlayNext && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onPlayNext(album);
                  close();
                }}
              >
                Lire ensuite
              </button>
            )}
            {onAddToQueue && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onAddToQueue(album);
                  close();
                }}
              >
                Ajouter à la file
              </button>
            )}
            {onAddToPlaylist && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onAddToPlaylist(album);
                  close();
                }}
              >
                Ajouter à une playlist
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export const AlbumCard = memo(AlbumCardImpl);
