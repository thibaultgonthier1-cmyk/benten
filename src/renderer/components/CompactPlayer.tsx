import { Minimize2 } from "lucide-react";
import { usePlayer } from "../state/player";
import { uiStore } from "../state/ui";
import { formatTime } from "../lib/library";
import { Cover } from "./Cover";
import { GoldMedallion } from "../ui/GoldMedallion";
import type { PlayerControls } from "./controls";
import "./compact.css";

/**
 * Mode compact (T17) : fenêtre 420×132 toujours au premier plan, réduite à l'essentiel —
 * pochette, titre, médaillon, progression. Double-clic n'importe où (ou la flèche) pour revenir.
 *
 * Ce composant ne redimensionne rien lui-même : il demande `window:set-compact` au Main, qui
 * mémorise la géométrie d'avant et la restaure.
 */

export function CompactPlayer({ controls }: { controls: PlayerControls }): JSX.Element | null {
  const track = usePlayer((s) => s.currentTrack);
  const status = usePlayer((s) => s.status);
  const positionSec = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);
  if (!track) return null;

  const playing = status === "playing";
  const dur = durationSec || track.durationSec || 0;
  const frac = dur > 0 ? Math.min(1, positionSec / dur) : 0;

  const leave = (): void => {
    uiStore.getState().setCompact(false);
    void window.benten?.window.setCompact(false);
  };

  return (
    <div className="compact" onDoubleClick={leave}>
      <div className="compact__art">
        <Cover artKey={track.artKey} seed={`${track.albumId}:${track.album}`} size={64} alt={track.album} />
      </div>
      <div className="compact__body">
        <div className="compact__title" title={track.title}>
          {track.title}
        </div>
        <div className="compact__artist">{track.artist}</div>
        <div className="compact__bar" aria-hidden>
          <i style={{ width: `${frac * 100}%` }} />
        </div>
        <div className="compact__times">
          <span>{formatTime(positionSec)}</span>
          <span>{formatTime(dur)}</span>
        </div>
      </div>
      <div className="compact__controls">
        <GoldMedallion playing={playing} size="sm" onToggle={controls.toggle} />
        <button className="compact__exit" type="button" aria-label="Quitter le mode compact" onClick={leave}>
          <Minimize2 size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

