import type React from "react";
import { usePlayer, playerStore } from "../state/player";
import { formatTime } from "../lib/library";
import { Cover } from "./Cover";
import { QualityBadge } from "./QualityBadge";
import type { PlayerControls } from "./controls";
import { GoldMedallion } from "../ui/GoldMedallion";
import { BiwaString } from "../ui/BiwaString";
import { SleepTimerMenu } from "./SleepTimerMenu";
import { Shuffle, Minimize2 } from "lucide-react";
import { uiStore } from "../state/ui";

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
  const isFav = usePlayer((s) => (track ? s.favoriteIds.has(track.id) : false));
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);

  if (!track) return null;
  const trackId = track.id;
  const playing = status === "playing";
  const dur = durationSec || track.durationSec || 0;
  const frac = dur > 0 ? Math.min(1, positionSec / dur) : 0;
  const pct = frac * 100;
  const seed = `${track.albumId}:${track.album}`;

  const open = (): void => playerStore.getState().setNowPlayingOpen(true);
  const cycleRepeat = (): void =>
    playerStore.getState().setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  const repeatLabel =
    repeat === "one" ? "Repeter : une piste" : repeat === "all" ? "Repeter : tout" : "Repetition desactivee";

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
    // Conteneur PRESENTATIONNEL (aucun role/handler) : les anciens `role="button"` + boutons
    // imbriques formaient un interactif-dans-interactif (signale a la revue Phase 1). L'ouverture de
    // la vue lecture passe maintenant par un bouton dedie `.mp-open` (pochette + titre), distinct et
    // frere des autres controles, chacun focusable separement.
    <div className="player">
      <button className="mp-open" type="button" aria-label="Ouvrir la vue lecture" onClick={open}>
        <div className="mp-art">
          <Cover artKey={track.artKey} seed={seed} size={128} alt={track.album} />
        </div>
        <div className="mp-meta">
          <div className="t">{track.title}</div>
          <div className="a">{track.artist}</div>
        </div>
      </button>
      <div className="mp-controls">
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
                <GoldMedallion playing={playing} size="md" onToggle={controls.toggle} title={playing ? "Pause" : "Lecture"} />
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
      <div className="mp-extras">
        <button
          className="ic"
          type="button"
          title="Aléatoire total"
          aria-label="Lecture aléatoire de toute la bibliothèque"
          onClick={() => void window.benten?.library.query({ view: "tracks", limit: 20000 }).then((result) => {
            const tracks = result.rows as unknown as Parameters<PlayerControls["playTracks"]>[0];
            if (!tracks || tracks.length === 0) return;
            playerStore.getState().setShuffle(true);
            controls.playTracks(tracks, Math.floor(Math.random() * tracks.length));
          })}
        >
          <Shuffle size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <SleepTimerMenu />
        <button
          className="ic"
          type="button"
          title="Mode compact"
          aria-label="Passer en mode compact"
          onClick={() => {
            uiStore.getState().setCompact(true);
            void window.benten?.window.setCompact(true);
          }}
        >
          <Minimize2 size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>      <div className="mp-right">
        <button
          className="ic"
          type="button"
          title="File d'attente"
          aria-label="Ouvrir la file d'attente"
          onClick={() => playerStore.getState().setQueueOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h12v2H4zM4 11h12v2H4zM4 16h8v2H4zM16 14l6 3-6 3z" />
          </svg>
        </button>
        <button
          className={"ic fav" + (isFav ? " on" : "")}
          type="button"
          title={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
          aria-label={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
          aria-pressed={isFav}
          onClick={() => playerStore.getState().toggleFavorite(trackId)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20.5l-1.3-1.2C5.4 14.5 2.5 11.9 2.5 8.6 2.5 6.2 4.4 4.3 6.8 4.3c1.4 0 2.7.65 3.6 1.7l1.6 1.9 1.6-1.9c.9-1.05 2.2-1.7 3.6-1.7 2.4 0 4.3 1.9 4.3 4.3 0 3.3-2.9 5.9-8.2 10.7L12 20.5z" />
          </svg>
        </button>
        <span className="mp-time">{formatTime(positionSec)}</span>
                <BiwaString
          className="mp-biwa"
          value={frac}
          onSeek={(fraction) => controls.seekFraction(fraction)}
          playing={playing}
          trackKey={trackId}
          duration={dur}
          label="Progression"
        />
        <span className="mp-time">{formatTime(dur)}</span>
        <QualityBadge track={track} variant="pill" />
      </div>
    </div>
  );
}



