import { useEffect, useRef, useState } from "react";
import type { AudioDeviceInfo, QualityMode, TrackRow } from "../../shared/types";
import { describeQuality } from "../lib/library";
import { useFocusTrap } from "../lib/focusTrap";
import { usePlayer, playerStore } from "../state/player";
import { qualitySampleRate } from "../audio/engine";

/** Valeur compacte de la SOURCE pour la colonne de droite d'un mode : `24/44` ou `—`. */
function compactSource(track: Pick<TrackRow, "sampleRate" | "bitDepth">): string {
  if (track.bitDepth && track.sampleRate) {
    return `${track.bitDepth}/${Math.round(track.sampleRate / 1000)}`;
  }
  return "—";
}

/** Libelle de sortie : `Nom — 48 kHz` si la frequence est connue, sinon `Nom`. */
function describeOutput(dev: AudioDeviceInfo | null): string {
  if (!dev) return "detection en cours…";
  if (dev.sampleRate && dev.sampleRate > 0) {
    const v = dev.sampleRate / 1000;
    return `${dev.name} — ${Number.isInteger(v) ? v : v.toFixed(1)} kHz`;
  }
  return dev.name;
}

/** kHz lisible pour une frequence (`48` / `44.1`). */
function khz(hz: number): string {
  const v = hz / 1000;
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

interface ModeDef {
  mode: QualityMode;
  title: string;
  desc: string;
}

/** Les trois modes, dans l'ordre d'affichage. `balanced` est le comportement par defaut. */
const MODES: readonly ModeDef[] = [
  { mode: "max", title: "Fidelite maximale", desc: "Suit ta sortie, sans re-echantillonnage impose." },
  { mode: "balanced", title: "Equilibre", desc: "Suit ta sortie audio — recommande." },
  { mode: "economy", title: "Econome", desc: "44.1 kHz, moins de ressources — batterie preservee." },
];

export interface QualitySheetProps {
  open: boolean;
  onClose: () => void;
  track: Pick<TrackRow, "format" | "sampleRate" | "bitDepth">;
}

/**
 * Feuille « Qualite de lecture » — FONCTIONNELLE (Task 13).
 *
 * Montre la SOURCE (depuis la piste), laisse CHOISIR la sortie parmi les peripheriques enumeres
 * (IPC `audio:list-devices`), selectionner un des TROIS modes (le changement recree PROPREMENT le
 * contexte audio hors-lecture, sans clic), et regler le VOLUME. Honnete : v1 ne fait pas de
 * bit-perfect / WASAPI exclusif ni de routage de sortie — la lecture passe par la sortie systeme ;
 * les modes agissent sur la frequence du graphe Web Audio (`max`/`balanced` suivent la sortie,
 * `economy` force 44.1 kHz). Fermee, `.sheet-wrap` passe en `display:none` : rien de focusable
 * hors-ecran.
 */
export function QualitySheet({ open, onClose, track }: QualitySheetProps): JSX.Element {
  const q = describeQuality(track);
  const qualityMode = usePlayer((s) => s.qualityMode);
  const volume = usePlayer((s) => s.volume);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [selected, setSelected] = useState<number>(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Piege de focus (dialogue modal) : confine Tab, Echap ferme, focus restaure a la fermeture.
  useFocusTrap(sheetRef, { active: open, onEscape: onClose });

  // Enumere les sorties a chaque ouverture (la liste peut changer entre deux lectures).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    window.benten.audio
      .listDevices()
      .then((list) => {
        if (!alive) return;
        setDevices(list);
        setSelected(0);
      })
      .catch(() => {
        if (alive) setDevices([]);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const device = devices[selected] ?? null;
  const srcVal = compactSource(track);
  const volPct = Math.round(volume * 100);

  // Frequence resultante d'un mode, compte tenu de la sortie choisie (`sampleRate` si connu).
  const modeVal = (mode: QualityMode): string => {
    if (mode === "economy") return "44.1 kHz";
    if (device?.sampleRate && device.sampleRate > 0) return `${khz(device.sampleRate)} kHz`;
    const rate = qualitySampleRate(mode, device?.sampleRate);
    return mode === "balanced" ? "systeme" : `${khz(rate)} kHz`;
  };

  return (
    <div className={"sheet-wrap" + (open ? " open" : "")} aria-hidden={!open}>
      <button
        className="sheet-scrim"
        type="button"
        aria-label="Fermer la feuille qualite"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-label="Qualite de lecture">
        <button
          className="sheet-close"
          type="button"
          aria-label="Fermer"
          tabIndex={open ? 0 : -1}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <h3>Qualite de lecture</h3>
        <p className="sub">
          On ne depasse jamais la qualite du fichier d'origine. Benten lit la source telle quelle ;
          le mode choisi ne touche qu'a la frequence du moteur audio.
        </p>

        <div className="src">
          <span className="k" aria-hidden="true">
            源
          </span>
          <div>
            <b>{q.label}</b>
            <br />
            <span>fichier d'origine detecte</span>
          </div>
        </div>

        <label className="qsel">
          <span className="qsel-lbl">Sortie</span>
          <select
            aria-label="Peripherique de sortie"
            tabIndex={open ? 0 : -1}
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            disabled={devices.length === 0}
          >
            {devices.length === 0 ? (
              <option value={0}>detection en cours…</option>
            ) : (
              devices.map((d, i) => (
                <option key={`${d.name}:${i}`} value={i}>
                  {describeOutput(d)}
                </option>
              ))
            )}
          </select>
        </label>

        <div role="radiogroup" aria-label="Mode de qualite">
          {MODES.map(({ mode, title, desc }) => {
            const sel = qualityMode === mode;
            return (
              <button
                key={mode}
                className={"qopt" + (sel ? " sel" : "")}
                type="button"
                role="radio"
                aria-checked={sel}
                tabIndex={open ? 0 : -1}
                onClick={() => playerStore.getState().setQualityMode(mode)}
              >
                <span className="r" aria-hidden="true" />
                <span className="txt">
                  <b>{title}</b>
                  <span>{desc}</span>
                </span>
                <span className="val">{modeVal(mode)}</span>
              </button>
            );
          })}
        </div>

        <div className="qvol">
          <span className="qvol-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 9v6h4l5 4V5L8 9H4z" />
              <path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth={2} />
            </svg>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={volPct}
            tabIndex={open ? 0 : -1}
            aria-label="Volume"
            aria-valuetext={`${volPct}%`}
            onChange={(e) => playerStore.getState().setVolume(Number(e.target.value) / 100)}
          />
          <span className="qvol-val">{volPct}%</span>
        </div>

        <p className="note">
          Sortie detectee : <b>{describeOutput(device)}</b>. En v1, Benten lit la source et laisse ta
          sortie systeme gerer la conversion finale ; il n'y a pas encore de routage de sortie ni de
          mode bit-perfect exclusif. Le changement de mode recree le contexte audio hors lecture (il
          met en pause, sans coupure brutale).
        </p>
      </div>
    </div>
  );
}

