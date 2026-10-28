import type React from "react";
import { usePlayer, playerStore } from "../state/player";
import { formatTime } from "../lib/library";
import { Cover } from "./Cover";
import { QualityBadge } from "./QualityBadge";
import type { PlayerControls } from "./controls";

/**
 * Mini-lecteur persistant (bas d'ecran), porte du prototype : pochette, titre/artiste, transport
 * (precedent / lecture-pause / suivant), temps + barre de progression + badge qualite source.
 * Cliquer la barre ouvre la vue lecture plein ecran.
 */
export function MiniPlayer({ controls }: { controls: PlayerControls }): JSX.Element | null {
  const track = usePlayer((s) => s.currentTrack);
  const status = usePlayer((s) => s.status);
  const positionSec = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);

  if (!track) return null;
  const playing = status === "playing";
  const dur = durationSec || track.durationSec || 0;
  const pct = dur > 0 ? Math.min(100, (positionSec / dur) * 100) : 0;
  const seed = `${track.albumId}:${track.album}`;

  const stop = (e: React.MouseEvent): void => e.stopPropagation();

  return (
    <div className="player" onClick={() => playerStore.getState().setNowPlayingOpen(true)}>
      <div className="mp-art">
        <Cover artKey={track.artKey} seed={seed} size={128} alt={track.album} />
      </div>
      <div className="mp-meta">
        <div className="t">{track.title}</div>
        <div className="a">{track.artist}</div>
      </div>
      <div className="mp-controls" onClick={stop}>
        <button className="ic" title="Precedent" onClick={controls.prev}>
          <svg viewBox="0 0 24 24">
            <path d="M7 6v12M20 6L9 12l11 6z" />
          </svg>
        </button>
        <button className="play-btn" title={playing ? "Pause" : "Lecture"} onClick={controls.toggle}>
          <svg viewBox="0 0 24 24">
            {playing ? <path d="M8 5h4v14H8zM14 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
          </svg>
        </button>
        <button className="ic" title="Suivant" onClick={controls.next}>
          <svg viewBox="0 0 24 24">
            <path d="M17 6v12M4 6l11 6L4 18z" />
          </svg>
        </button>
      </div>
      <div className="mp-right" onClick={stop}>
        <span className="mp-time">{formatTime(positionSec)}</span>
        <div
          className="mp-bar"
          style={{ "--p": `${pct}%` } as React.CSSProperties}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            controls.seekFraction((e.clientX - r.left) / r.width);
          }}
        >
          <i />
        </div>
        <span className="mp-time">{formatTime(dur)}</span>
        <QualityBadge track={track} variant="pill" />
      </div>
    </div>
  );
}
