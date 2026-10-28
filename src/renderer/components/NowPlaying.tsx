import type React from "react";
import { useEffect, useRef, useState } from "react";
import { usePlayer, playerStore } from "../state/player";
import { describeQuality, formatTime } from "../lib/library";
import { coverAccent, Cover } from "./Cover";
import { QualityBadge } from "./QualityBadge";
import type { PlayerControls } from "./controls";

/**
 * Vue lecture plein ecran, portee du prototype : grande pochette (anneau qui tourne + leger
 * « beat » en lecture), titre/artiste, badges qualite, scrubber (clic + glisser) et transport.
 * S'ouvre depuis le mini-lecteur ; se ferme par le chevron ou Echap.
 */
export function NowPlaying({ controls }: { controls: PlayerControls }): JSX.Element | null {
  const open = usePlayer((s) => s.nowPlayingOpen);
  const track = usePlayer((s) => s.currentTrack);
  const status = usePlayer((s) => s.status);
  const positionSec = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);

  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const close = (): void => playerStore.getState().setNowPlayingOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!track) return null;
  const playing = status === "playing";
  const dur = durationSec || track.durationSec || 0;
  const liveFrac = dur > 0 ? Math.min(1, positionSec / dur) : 0;
  const frac = drag ?? liveFrac;
  const pct = `${frac * 100}%`;
  const seed = `${track.albumId}:${track.album}`;
  const accent = coverAccent(seed);
  const q = describeQuality(track);

  const fracFromEvent = (clientX: number): number => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  return (
    <div id="now" className={open ? "open" : ""} aria-hidden={!open}>
      <div
        className="np-bg"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${accent}, transparent 60%), radial-gradient(circle at 70% 70%, #1b1823, #0b0b11)`,
        }}
      />
      <div className="np-scrim" />

      <div className="np-top">
        <button className="ic" title="Reduire" onClick={close}>
          <svg viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth={2} />
          </svg>
        </button>
        <div className="label">
          en lecture depuis
          <b>{track.album}</b>
        </div>
        <span style={{ width: 38 }} />
      </div>

      <div className="np-body">
        <div className="np-stage">
          <div className={"np-ring" + (playing ? " spin" : "")} />
          <div className={"np-cover" + (playing ? " beat" : "")}>
            <Cover artKey={track.artKey} seed={seed} size={256} alt={track.album} />
          </div>
        </div>

        <div className="np-info">
          <div className="jp">{q.lossless ? "sans perte" : "lecture"}</div>
          <h2>{track.title}</h2>
          <p className="artist">{track.artist}</p>

          <div className="np-qrow">
            <QualityBadge track={track} variant="pill" />
            <span className="tag">
              <b>{q.lossless ? "Sans perte" : "Avec perte"}</b>
            </span>
          </div>

          <div className="scrub">
            <div
              ref={barRef}
              className={"bar" + (drag !== null ? " drag" : "")}
              style={{ "--p": pct } as React.CSSProperties}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag(fracFromEvent(e.clientX));
              }}
              onPointerMove={(e) => {
                if (drag !== null) setDrag(fracFromEvent(e.clientX));
              }}
              onPointerUp={(e) => {
                const f = fracFromEvent(e.clientX);
                setDrag(null);
                controls.seekFraction(f);
              }}
            >
              <i />
              <span className="thumb" />
            </div>
            <div className="times">
              <span>{formatTime(frac * dur)}</span>
              <span>{formatTime(dur)}</span>
            </div>
          </div>

          <div className="np-controls">
            <button className="ic" title="Precedent" onClick={controls.prev}>
              <svg viewBox="0 0 24 24">
                <path d="M7 6v12M20 6L9 12l11 6z" />
              </svg>
            </button>
            <button
              className="play-btn np-play"
              title={playing ? "Pause" : "Lecture"}
              onClick={controls.toggle}
            >
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
        </div>
      </div>
    </div>
  );
}
