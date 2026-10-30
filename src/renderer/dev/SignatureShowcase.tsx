import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { AudioEngine } from "../audio/engine";
import type { PlayerControls } from "../components/controls";
import { formatTime } from "../lib/library";
import { useCoverColors } from "../lib/useCoverColors";
import { playerStore, usePlayer } from "../state/player";
import { settingsStore, useSettings } from "../state/settings";
import type { MotionIntensity } from "../theme/ds/motion";
import { BiwaString } from "../ui/BiwaString";
import { FxOverlay, fxScheduler } from "../ui/FxOverlay";
import { GoldMedallion } from "../ui/GoldMedallion";
import { LacquerDisc } from "../ui/LacquerDisc";
import { activeFrameLoops } from "../ui/frameLoop";
import "./showcase.css";

/**
 * Vitrine DEV-ONLY des composants signature DA2 (jamais embarquée en production : chargée
 * paresseusement derrière `import.meta.env.DEV`). Pilotée par le pont `window.__benten.signature`
 * (`show()` / `hide()`), elle monte les 4 composants sur le VRAI moteur (analyser en lecture
 * seule, commandes de transport existantes) — sans toucher aux écrans livrés.
 */

interface Props {
  engine: AudioEngine;
  controls: PlayerControls;
}

type Bridge = Record<string, unknown> & { signature?: unknown };

const MOTION: ReadonlyArray<{ value: MotionIntensity; label: string }> = [
  { value: "full", label: "Complet" },
  { value: "subtle", label: "Sobre" },
  { value: "reduced", label: "Réduit" },
];

export default function SignatureShowcase({ engine, controls }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const w = window as Window & { __benten?: Bridge };
    const signature = {
      show: () => setOpen(true),
      hide: () => setOpen(false),
      loops: () => activeFrameLoops(),
      fx: () => fxScheduler.active().map((t) => t.kind),
      videos: () => document.querySelectorAll("video").length,
    };
    w.__benten = { ...(w.__benten ?? {}), signature };
    return () => {
      if (w.__benten?.signature === signature) delete w.__benten.signature;
    };
  }, []);

  if (!open) return null;
  return <Showcase engine={engine} controls={controls} onClose={() => setOpen(false)} />;
}

function Showcase({ engine, controls, onClose }: Props & { onClose(): void }): JSX.Element {
  const track = usePlayer((s) => s.currentTrack);
  const status = usePlayer((s) => s.status);
  const position = usePlayer((s) => s.positionSec);
  const durationSec = usePlayer((s) => s.durationSec);
  const volume = usePlayer((s) => s.volume);
  const intensity = useSettings((s) => s.motionIntensity);
  const playing = status === "playing";
  const duration = durationSec || track?.durationSec || 0;
  const value = duration > 0 ? position / duration : 0;
  const colors = useCoverColors(track?.artKey ?? null, track ? `${track.albumId}:${track.album}` : "benten");
  const analyser = useCallback((): AnalyserNode => engine.getAnalyser(), [engine]);
  const toggle = useCallback((): void => controls.toggle(), [controls]);
  const seek = useCallback((f: number): void => controls.seekFraction(f), [controls]);
  const setVolume = useCallback((f: number): void => playerStore.getState().setVolume(f), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sig-showcase" style={{ "--sig-tint": colors.accent } as CSSProperties}>
      <div className="sig-showcase__halo" />
      <header className="sig-showcase__head">
        <div>
          <p className="sig-showcase__kicker">弁天 · Biwa &amp; Or</p>
          <h1 className="sig-showcase__title">Composants signature</h1>
        </div>
        <div className="sig-showcase__motion" role="radiogroup" aria-label="Mouvement">
          {MOTION.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={intensity === m.value}
              className={intensity === m.value ? "is-on" : undefined}
              onClick={() => settingsStore.getState().setMotionIntensity(m.value)}
            >
              {m.label}
            </button>
          ))}
          <button type="button" className="sig-showcase__close" onClick={onClose} aria-label="Fermer la vitrine">
            ✕
          </button>
        </div>
      </header>

      <main className="sig-showcase__stage">
        <section className="sig-showcase__disc">
          <LacquerDisc artKey={track?.artKey ?? null} tint={colors.accent} playing={playing} size={340} />
        </section>

        <section className="sig-showcase__panel">
          <div className="sig-showcase__track">
            <p className="sig-showcase__track-title">{track?.title ?? "Aucune piste"}</p>
            <p className="sig-showcase__track-artist">{track ? `${track.artist} — ${track.album}` : "—"}</p>
          </div>

          <div className="sig-showcase__progress">
            <BiwaString
              value={value}
              duration={duration}
              onSeek={seek}
              analyser={analyser}
              playing={playing}
              trackKey={track?.id ?? null}
              label="Position de lecture"
            />
            <div className="sig-showcase__times">
              <span>{formatTime(position)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="sig-showcase__controls">
            <GoldMedallion playing={playing} size="lg" onToggle={toggle} />
          </div>

          <div className="sig-showcase__volume">
            <span className="sig-showcase__label">Volume</span>
            <BiwaString
              value={volume}
              onSeek={setVolume}
              thin
              analyser={analyser}
              playing={playing}
              trackKey="volume"
              label="Volume"
            />
          </div>

          <div className="sig-showcase__sizes">
            {(["sm", "md", "lg"] as const).map((s) => (
              <figure key={s}>
                <GoldMedallion playing={playing} size={s} onToggle={toggle} />
                <figcaption>{s}</figcaption>
              </figure>
            ))}
            <figure>
              <GoldMedallion playing={!playing} size="md" onToggle={toggle} />
              <figcaption>inverse</figcaption>
            </figure>
          </div>
        </section>
      </main>
      <FxOverlay />
    </div>
  );
}
