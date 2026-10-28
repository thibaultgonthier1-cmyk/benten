import { memo } from "react";
import type { Album } from "../lib/library";
import { coverAccent, Cover } from "./Cover";
import { QualityBadge } from "./QualityBadge";

/**
 * Carte d'album : pochette (vraie via `benten-art://` ou repli generatif), badge qualite de la
 * source, badge lecture magenta au survol, titre + artiste. Clic = jouer l'album.
 */
export interface AlbumCardProps {
  album: Album;
  playing?: boolean;
  onPlay: (album: Album) => void;
}

function AlbumCardImpl({ album, playing = false, onPlay }: AlbumCardProps): JSX.Element {
  const first = album.tracks[0];
  const seed = `${album.id}:${album.title}`;
  const accent = album.artKey ? "transparent" : coverAccent(seed);
  return (
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
  );
}

export const AlbumCard = memo(AlbumCardImpl);
