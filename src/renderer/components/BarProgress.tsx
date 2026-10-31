import { memo } from "react";
import { usePlayer } from "../state/player";
import { BiwaString } from "../ui/BiwaString";

/**
 * Le bloc de progression de la barre de lecture, isolé du reste.
 *
 * POURQUOI CE COMPOSANT EXISTE
 * La barre entière s'abonnait à `positionSec`, qui change ~15 fois par seconde : chaque tick
 * redessinait donc la pochette, les boutons de transport, le menu de fondu, l'égaliseur… pour rien.
 * Ici, seuls le temps affiché et la corde dépendent de la position ; le reste de la barre ne
 * bouge plus.
 *
 * Le formatage est fait ici aussi : `formatTime` sur une position qui change 15 fois par seconde
 * n'a aucune raison de faire travailler le parent.
 */

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface BarProgressProps {
  fallbackDurationSec: number;
  playing: boolean;
  trackKey: number;
  onSeek(fraction: number): void;
}

function BarProgressImpl({ fallbackDurationSec, playing, trackKey, onSeek }: BarProgressProps): JSX.Element {
  // Deux sélecteurs étroits : la position seule ne fait re-rendre QUE ce composant.
  const positionSec = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);
  const dur = durationSec || fallbackDurationSec || 0;
  const frac = dur > 0 ? Math.min(1, positionSec / dur) : 0;

  return (
    <>
      <span className="mp-time">{formatTime(positionSec)}</span>
      <BiwaString
        className="mp-biwa"
        value={frac}
        onSeek={onSeek}
        onScrubMove={onSeek}
        playing={playing}
        trackKey={trackKey}
        duration={dur}
        label="Progression"
      />
      <span className="mp-time">{formatTime(dur)}</span>
    </>
  );
}

export const BarProgress = memo(BarProgressImpl);
