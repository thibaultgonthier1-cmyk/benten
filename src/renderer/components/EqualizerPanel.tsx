import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type { AudioEngine } from "../audio/engine";
import { EQ_BAND_COUNT, FLAT_EQ, settingsStore, useSettings } from "../state/settings";
import "./equalizer.css";

/**
 * Égaliseur « chevalets de koto » (T17B).
 *
 * Dix cordes verticales, un chevalet mobile par corde : on le fait glisser (ou on utilise les
 * flèches) et la courbe — un **fil d'or** — se retend entre les chevalets. La valeur va de −12 à
 * +12 dB, comme les filtres du moteur.
 *
 * Le composant ne touche jamais le moteur directement : il écrit dans les réglages, et l'hôte
 * (`bindEqualizer`) applique au moteur. Une seule source de vérité, donc pas de dérive entre ce
 * qu'on voit et ce qu'on entend.
 */

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Hz → libellé court (`1k`, `16k`). */
function labelFor(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/** dB → position verticale [0..1] (0 = en bas, 1 = en haut). 0 dB tombe au milieu. */
export function gainToFraction(gainDb: number): number {
  const clamped = Math.max(-12, Math.min(12, gainDb));
  return (clamped + 12) / 24;
}

/** Position verticale → dB, arrondi au demi-décibel. */
export function fractionToGain(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return Math.round((clamped * 24 - 12) * 2) / 2;
}

let engineRef: AudioEngine | null = null;

/** Branche le moteur : appelé une fois par App. Idempotent. */
export function bindEqualizer(engine: AudioEngine): void {
  engineRef = engine;
}

/** Applique les réglages courants au moteur (actif → gains réels, inactif → 0 dB partout). */
export function applyEqualizer(): void {
  if (!engineRef) return;
  const { eqEnabled, eqGains } = settingsStore.getState();
  engineRef.setEqGains(eqEnabled ? eqGains : FLAT_EQ);
}

export function EqualizerPanel({ onClose }: { onClose(): void }): JSX.Element {
  const gains = useSettings((s) => s.eqGains);
  const enabled = useSettings((s) => s.eqEnabled);
  const [dragging, setDragging] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const setGain = useCallback((index: number, gainDb: number) => {
    const next = [...settingsStore.getState().eqGains];
    next[index] = Math.max(-12, Math.min(12, gainDb));
    settingsStore.getState().setEqGains(next);
  }, []);

  // Toute modification part au moteur : c'est le seul chemin vers le son.
  useEffect(() => {
    applyEqualizer();
  }, [gains, enabled]);

  useEffect(() => {
    if (dragging === null) return undefined;
    const move = (event: PointerEvent): void => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const fraction = 1 - (event.clientY - rect.top) / rect.height;
      setGain(dragging, fractionToGain(fraction));
    };
    const up = (): void => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, setGain]);

  const points = gains.map((gain, index) => {
    const x = ((index + 0.5) / EQ_BAND_COUNT) * 100;
    const y = (1 - gainToFraction(gain)) * 100;
    return `${x},${y}`;
  });

  return (
    <div className="eq-backdrop" role="presentation" onClick={onClose}>
      <div
        className="eq-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Égaliseur"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="eq-head">
          <div>
            <span className="eq-eyebrow">Koto</span>
            <h2>Égaliseur</h2>
          </div>
          <div className="eq-head__actions">
            <button
              className={"eq-toggle" + (enabled ? " is-on" : "")}
              type="button"
              aria-pressed={enabled}
              onClick={() => settingsStore.getState().setEqEnabled(!enabled)}
            >
              {enabled ? "Actif" : "Inactif"}
            </button>
            <button
              className="eq-reset"
              type="button"
              aria-label="Remettre à plat"
              title="Remettre à plat"
              onClick={() => settingsStore.getState().setEqGains(FLAT_EQ)}
            >
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
            </button>
            <button className="eq-close" type="button" aria-label="Fermer" onClick={onClose}>
              <X size={15} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </header>

        <div className="eq-board" ref={railRef} data-enabled={enabled ? "true" : "false"}>
          {/* Fil d'or : la courbe de réponse, tendue entre les chevalets. */}
          <svg className="eq-thread" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={points.join(" ")} />
          </svg>

          {gains.map((gain, index) => {
            const fraction = gainToFraction(gain);
            return (
              <div key={index} className="eq-string">
                <span className="eq-string__wire" aria-hidden="true" />
                <button
                  className={"eq-bridge" + (dragging === index ? " is-dragging" : "")}
                  type="button"
                  role="slider"
                  aria-label={`${labelFor(EQ_FREQUENCIES[index]!)} hertz`}
                  aria-valuemin={-12}
                  aria-valuemax={12}
                  aria-valuenow={gain}
                  aria-valuetext={`${gain > 0 ? "+" : ""}${gain} dB`}
                  style={{ top: `${(1 - fraction) * 100}%` }}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    setDragging(index);
                  }}
                  onDoubleClick={() => setGain(index, 0)}
                  onKeyDown={(e) => {
                    // On relit la valeur du store : plusieurs appuis dans la même frame (ou une
                    // touche maintenue) doivent S'ACCUMULER, pas repartir de la valeur rendue.
                    const current = settingsStore.getState().eqGains[index] ?? 0;
                    if (e.key === "ArrowUp") setGain(index, current + 0.5);
                    else if (e.key === "ArrowDown") setGain(index, current - 0.5);
                    else if (e.key === "Home") setGain(index, 12);
                    else if (e.key === "End") setGain(index, -12);
                    else if (e.key === "0" || e.key === "Backspace") setGain(index, 0);
                    else return;
                    e.preventDefault();
                  }}
                />
                <span className="eq-label">{labelFor(EQ_FREQUENCIES[index]!)}</span>
                <span className="eq-value">{gain > 0 ? `+${gain}` : gain}</span>
              </div>
            );
          })}
        </div>

        <p className="eq-hint">
          Glisse un chevalet, ou utilise les flèches. Double-clic sur un chevalet : 0 dB.
        </p>
      </div>
    </div>
  );
}

