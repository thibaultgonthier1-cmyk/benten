import { useEffect, useState } from "react";
import { Moon } from "lucide-react";
import { sleepTimer } from "../runtime/sleepTimerHost";
import "./sleep.css";

/**
 * Menu du minuteur de sommeil (T17) : durées fixes, « fin du titre », annulation, et compte à
 * rebours vivant. Le minuteur lui-même vit dans `runtime/sleepTimerHost` ; ce composant ne fait
 * qu'afficher et armer.
 */

const MINUTES = [15, 30, 45, 60] as const;

export function SleepTimerMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | null>(null);

  // Compte à rebours rafraîchi chaque seconde tant qu'un minuteur est armé.
  useEffect(() => {
    const timer = sleepTimer();
    if (!timer) return undefined;
    const tick = (): void => {
      const remaining = timer.remainingSec();
      if (timer.mode() === "end-of-track") setLabel("Fin du titre");
      else if (remaining === null) setLabel(null);
      else {
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        setLabel(`${minutes}:${String(seconds).padStart(2, "0")}`);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [open, label === null]);

  const arm = (minutes: (typeof MINUTES)[number]): void => {
    sleepTimer()?.start(minutes);
    setOpen(false);
  };

  return (
    <div className="sleep">
      <button
        className={"ic sleep__btn" + (label ? " on" : "")}
        type="button"
        title={label ? `Minuteur de sommeil : ${label}` : "Minuteur de sommeil"}
        aria-label={label ? `Minuteur de sommeil, ${label} restant` : "Minuteur de sommeil"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Moon size={16} strokeWidth={1.75} aria-hidden />
        {label && <span className="sleep__badge">{label}</span>}
      </button>

      {open && (
        <div className="sleep__menu" role="menu" aria-label="Minuteur de sommeil">
          {MINUTES.map((minutes) => (
            <button key={minutes} type="button" role="menuitem" onClick={() => arm(minutes)}>
              {minutes} minutes
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              sleepTimer()?.startEndOfTrack();
              setOpen(false);
            }}
          >
            Fin du titre
          </button>
          <button
            type="button"
            role="menuitem"
            className="sleep__cancel"
            onClick={() => {
              sleepTimer()?.cancel();
              setLabel(null);
              setOpen(false);
            }}
          >
            Désactiver
          </button>
        </div>
      )}
    </div>
  );
}
