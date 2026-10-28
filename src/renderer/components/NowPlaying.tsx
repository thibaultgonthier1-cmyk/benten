import type React from "react";
import { useRef, useState } from "react";
import { usePlayer, playerStore } from "../state/player";
import { describeQuality, formatTime } from "../lib/library";
import { useFocusTrap } from "../lib/focusTrap";
import { coverAccent, Cover } from "./Cover";
import { QualityBadge, QualitySheet } from "./QualityBadge";
import type { PlayerControls } from "./controls";

/** Pas de deplacement clavier du scrubber, en secondes. */
const SEEK_STEP_SEC = 5;

/**
 * Vue lecture plein ecran, portee du prototype : grande pochette (anneau qui tourne + leger
 * « beat » en lecture), titre/artiste, badges qualite, scrubber (clic + glisser + clavier) et
 * transport. S'ouvre depuis le mini-lecteur ; se ferme par le chevron ou Echap. Fermee, elle passe
 * en `visibility:hidden` (apres l'animation) : invisible ET non focusable — pas de piege de focus
 * ni de boutons tabbables dans un panneau hors-ecran.
 */
export function NowPlaying({ controls }: { controls: PlayerControls }): JSX.Element | null {
  const open = usePlayer((s) => s.nowPlayingOpen);
  const track = usePlayer((s) => s.currentTrack);
  const status = usePlayer((s) => s.status);
  const positionSec = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);
  const isFav = usePlayer((s) => (track ? s.favoriteIds.has(track.id) : false));
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);

  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const close = (): void => {
    setSheetOpen(false);
    playerStore.getState().setNowPlayingOpen(false);
  };
  const cycleRepeat = (): void =>
    playerStore.getState().setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  const repeatLabel =
    repeat === "one" ? "Repeter : une piste" : repeat === "all" ? "Repeter : tout" : "Repetition desactivee";

  // Piege de focus de la vue lecture (dialogue modal) : confine Tab, restaure le focus a la
  // fermeture. Echap ferme d'abord la feuille qualite si ouverte, sinon la vue (comportement proto).
  // La feuille qualite a son propre piege imbrique : quand elle a le focus, elle traite la touche
  // en premier (defaultPrevented) et ce piege parent la laisse passer.
  useFocusTrap(rootRef, {
    active: open,
    onEscape: () => {
      if (sheetOpen) setSheetOpen(false);
      else close();
    },
  });

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

  const onBarKey = (e: React.KeyboardEvent): void => {
    if (dur <= 0) return;
    const step = SEEK_STEP_SEC / dur;
    let f: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") f = Math.min(1, liveFrac + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") f = Math.max(0, liveFrac - step);
    else if (e.key === "Home") f = 0;
    else if (e.key === "End") f = 1;
    if (f !== null) {
      e.preventDefault();
      controls.seekFraction(f);
    }
  };

  return (
    <div
      id="now"
      ref={rootRef}
      className={open ? "open" : ""}
      role="dialog"
      aria-modal="true"
      aria-label={`En lecture — ${track.title}`}
      aria-hidden={!open}
    >
      <div
        className="np-bg"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${accent}, transparent 60%), radial-gradient(circle at 70% 70%, #1b1823, #0b0b11)`,
        }}
      />
      <div className="np-scrim" />

      <div className="np-top">
        <button className="ic" type="button" title="Reduire" aria-label="Reduire la vue lecture" onClick={close}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
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
          <div className={"np-ring" + (playing ? " spin" : "")} aria-hidden="true" />
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
            <button
              className={"ic fav" + (isFav ? " on" : "")}
              type="button"
              title={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
              aria-label={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
              aria-pressed={isFav}
              onClick={() => playerStore.getState().toggleFavorite(track.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20.5l-1.3-1.2C5.4 14.5 2.5 11.9 2.5 8.6 2.5 6.2 4.4 4.3 6.8 4.3c1.4 0 2.7.65 3.6 1.7l1.6 1.9 1.6-1.9c.9-1.05 2.2-1.7 3.6-1.7 2.4 0 4.3 1.9 4.3 4.3 0 3.3-2.9 5.9-8.2 10.7L12 20.5z" />
              </svg>
            </button>
          </div>

          <div className="scrub">
            <div
              ref={barRef}
              className={"bar" + (drag !== null ? " drag" : "")}
              role="slider"
              tabIndex={0}
              aria-label="Progression"
              aria-valuemin={0}
              aria-valuemax={Math.round(dur)}
              aria-valuenow={Math.round(frac * dur)}
              aria-valuetext={`${formatTime(frac * dur)} sur ${formatTime(dur)}`}
              style={{ "--p": pct } as React.CSSProperties}
              onKeyDown={onBarKey}
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
            <button
              className={"ic" + (shuffle ? " on" : "")}
              type="button"
              title={shuffle ? "Lecture aleatoire activee" : "Lecture aleatoire"}
              aria-label="Lecture aleatoire"
              aria-pressed={shuffle}
              onClick={() => playerStore.getState().setShuffle(!shuffle)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M4 5h3.5c1.3 0 2.5.6 3.2 1.7l5.6 8.6c.7 1.1 1.9 1.7 3.2 1.7H21" />
                <path d="M4 19h3.5c1.3 0 2.5-.6 3.2-1.7" />
                <path d="M14.5 6.7C15.2 5.6 16.4 5 17.7 5H21" />
                <path d="M18 2.5L21 5l-3 2.5" />
                <path d="M18 16.5L21 19l-3 2.5" />
              </svg>
            </button>
            <button className="ic" type="button" title="Precedent" aria-label="Morceau precedent" onClick={controls.prev}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 6v12M20 6L9 12l11 6z" />
              </svg>
            </button>
            <button
              className="play-btn np-play"
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
            <button
              className={"ic rep" + (repeat !== "off" ? " on" : "")}
              type="button"
              title={repeatLabel}
              aria-label={repeatLabel}
              aria-pressed={repeat !== "off"}
              onClick={cycleRepeat}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              {repeat === "one" && <span className="rep-one" aria-hidden="true">1</span>}
            </button>
          </div>
        </div>
      </div>

      <div className="np-foot">
        <button
          className="foot-btn"
          type="button"
          aria-label="Ouvrir la file d'attente"
          onClick={() => playerStore.getState().setQueueOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h11M4 12h11M4 17h7" fill="none" />
            <path d="M16 15v6l5-3z" fill="currentColor" stroke="none" />
          </svg>
          <span>File d'attente</span>
        </button>
        <button
          className={"foot-btn" + (sheetOpen ? " active" : "")}
          type="button"
          aria-label="Afficher la qualite de lecture"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h3l3-8 4 16 3-8h3" />
          </svg>
          <span>Qualite — {q.label}</span>
        </button>
      </div>

      <QualitySheet open={sheetOpen} onClose={() => setSheetOpen(false)} track={track} />
    </div>
  );
}
