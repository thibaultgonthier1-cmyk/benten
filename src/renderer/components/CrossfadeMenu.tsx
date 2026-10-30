import { useEffect, useState } from "react";
import { Shuffle } from "lucide-react";
import { settingsStore, useSettings } from "../state/settings";
import type { AudioEngine } from "../audio/engine";
import "./crossfade.css";

/**
 * Réglage du fondu enchaîné.
 *
 * Deux choix indépendants : la DURÉE (0 = gapless pur, comme avant) et le CALAGE SUR LE TEMPO.
 * Avec le calage, la durée est arrondie à un nombre entier de mesures de la piste sortante et le
 * départ tombe sur un temps — c'est ce qui va au-delà du fondu d'Apple Music, qui ne connaît que
 * la durée fixe.
 */

const DURATIONS = [0, 3, 6, 9, 12] as const;

export function CrossfadeMenu({ engine }: { engine: AudioEngine | null }): JSX.Element {
  const seconds = useSettings((s) => s.crossfadeSec);
  const beatMatched = useSettings((s) => s.crossfadeBeatMatched);
  const [open, setOpen] = useState(false);
  const [bpm, setBpm] = useState<number | null>(null);

  // Applique le réglage au moteur (une seule source de vérité : les réglages).
  useEffect(() => {
    if (!engine) return;
    engine.setCrossfade(seconds);
    engine.setBeatMatchedCrossfade(beatMatched);
  }, [engine, seconds, beatMatched]);

  useEffect(() => {
    if (!open || !engine) return undefined;
    setBpm(engine.getCurrentBpm());
    const id = window.setInterval(() => setBpm(engine.getCurrentBpm()), 1000);
    return () => window.clearInterval(id);
  }, [open, engine]);

  return (
    <div className="xf">
      <button
        className={"ic" + (seconds > 0 ? " on" : "")}
        type="button"
        title={seconds > 0 ? `Fondu enchaîné : ${seconds} s` : "Fondu enchaîné : désactivé"}
        aria-label="Réglage du fondu enchaîné"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Shuffle size={16} strokeWidth={1.75} aria-hidden />
        {seconds > 0 && <span className="xf__badge">{seconds}</span>}
      </button>

      {open && (
        <div className="xf__menu" role="menu" aria-label="Fondu enchaîné">
          <span className="xf__title">Fondu enchaîné</span>
          {DURATIONS.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={seconds === value}
              className={seconds === value ? "is-on" : ""}
              onClick={() => settingsStore.getState().setCrossfade(value)}
            >
              {value === 0 ? "Désactivé (enchaînement sec)" : `${value} secondes`}
            </button>
          ))}
          <label className="xf__check">
            <input
              type="checkbox"
              checked={beatMatched}
              onChange={(e) => settingsStore.getState().setCrossfadeBeatMatched(e.target.checked)}
              disabled={seconds === 0}
            />
            Caler sur le tempo
          </label>
          <span className="xf__hint">
            {seconds === 0
              ? "Enchaînement sans trou (gapless), comme avant."
              : beatMatched
                ? bpm
                  ? `Tempo détecté : ${bpm} BPM — fondu arrondi à une mesure.`
                  : "Tempo en cours d'analyse… (fondu à durée fixe en attendant)"
                : "Durée fixe, sans calage rythmique."}
          </span>
        </div>
      )}
    </div>
  );
}
