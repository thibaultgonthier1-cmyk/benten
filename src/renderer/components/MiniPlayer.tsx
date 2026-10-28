import type React from "react";
import { usePlayer, playerStore } from "../state/player";
import { formatTime } from "../lib/library";
import { Cover } from "./Cover";
import { QualityBadge } from "./QualityBadge";
import type { PlayerControls } from "./controls";

/** Pas de deplacement clavier du scrubber, en secondes. */
const SEEK_STEP_SEC = 5;

/**
 * Mini-lecteur persistant (bas d'ecran), porte du prototype : pochette, titre/artiste, transport
 * (precedent / lecture-pause / suivant), temps + barre de progression + badge qualite source.
 * Cliquer (ou Entree/Espace) ouvre la vue lecture plein ecran ; la barre est un `slider` operable
 * au clavier (fleches / Debut / Fin).
 */
export function MiniPlayer({ controls }: { controls: PlayerControls }): JSX.Element | null {
  const track = usePlayer((s) => s.currentTrack);
  const status = usePlayer((s) => s.status);
  const positionSec = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);

  if (!track) return null;
  const playing = status === "playing";
  const dur = durationSec || track.durationSec || 0;
  const frac = dur > 0 ? Math.min(1, positionSec / dur) : 0;
  const pct = frac * 100;
  const seed = `${track.albumId}:${track.album}`;

  const stop = (e: React.MouseEvent): void => e.stopPropagation();
  const open = (): void => playerStore.getState().setNowPlayingOpen(true);

  const onBarKey = (e: React.KeyboardEvent): void => {
    if (dur <= 0) return;
    const step = SEEK_STEP_SEC / dur;
    let f: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") f = Math.min(1, frac + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") f = Math.max(0, frac - step);
    else if (e.key === "Home") f = 0;
    else if (e.key === "End") f = 1;
    if (f !== null) {
      e.preventDefault();
      controls.seekFraction(f);
    }
  };

  return (
    <div
      className="player"
      role="button"
      tabIndex={0}
      aria-label="Ouvrir la vue lecture"
      onClick={open}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="mp-art">
        <Cover artKey={track.artKey} seed={seed} size={128} alt={track.album} />
      </div>
      <div className="mp-meta">
        <div className="t">{track.title}</div>
        <div className="a">{track.artist}</div>
      </div>
      <div className="mp-controls" onClick={stop}>
        <button className="ic" type="button" title="Precedent" aria-label="Morceau precedent" onClick={controls.prev}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 6v12M20 6L9 12l11 6z" />
          </svg>
        </button>
        <button
          className="play-btn"
          type="button"
          title={playing ? "Pause" : "Lecture"}
          aria-label={playing ? "Pause" : "Lecture"}
          onClick={controls.toggle}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {playing ? <path d="M8 5h4v14H8zM14 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
          </svg>
        </button>
        <button className="ic" type="button" title="Suivant" aria-label="Morceau suivant" onClick={controls.next}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 6v12M4 6l11 6L4 18z" />
          </svg>
        </button>
      </div>
      <div className="mp-right" onClick={stop}>
        <span className="mp-time">{formatTime(positionSec)}</span>
        <div
          className="mp-bar"
          role="slider"
          tabIndex={0}
          aria-label="Progression"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(positionSec)}
          aria-valuetext={`${formatTime(positionSec)} sur ${formatTime(dur)}`}
          style={{ "--p": `${pct}%` } as React.CSSProperties}
          onKeyDown={onBarKey}
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
