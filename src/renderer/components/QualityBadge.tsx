import { useEffect, useRef, useState } from "react";
import type { AudioDeviceInfo, TrackRow } from "../../shared/types";
import { describeQuality } from "../lib/library";
import { useFocusTrap } from "../lib/focusTrap";

/**
 * Badge de qualite de la SOURCE : format + sampleRate/bitDepth de la ligne de piste
 * (p.ex. « FLAC · 24-bit/44.1 kHz »). Ce n'est JAMAIS la frequence de l'AudioContext.
 *
 * - `variant="badge"` : pastille coin-haut-gauche sur une pochette (n'affiche que le format).
 * - `variant="pill"`  : pilule complete (format + detail), pour mini-lecteur et vue lecture.
 */
export interface QualityBadgeProps {
  track: Pick<TrackRow, "format" | "sampleRate" | "bitDepth">;
  variant?: "badge" | "pill";
}

export function QualityBadge({ track, variant = "pill" }: QualityBadgeProps): JSX.Element {
  const q = describeQuality(track);
  const cls = (variant === "badge" ? "qbadge" : "qpill") + (q.lossless ? " lossless" : "");
  const text = variant === "badge" ? q.format : q.label;
  return (
    <span className={cls} title={q.label}>
      {text}
    </span>
  );
}

/** Valeur compacte pour la colonne de droite d'un mode : `24/44` (sans perte) ou `—`. */
function compactSource(track: Pick<TrackRow, "sampleRate" | "bitDepth">): string {
  if (track.bitDepth && track.sampleRate) {
    return `${track.bitDepth}/${Math.round(track.sampleRate / 1000)}`;
  }
  return "—";
}

/** Libelle de la sortie detectee : `Nom — 48 kHz` si la frequence est connue, sinon `Nom`. */
function describeOutput(dev: AudioDeviceInfo | null): string {
  if (!dev) return "detection en cours…";
  if (dev.sampleRate && dev.sampleRate > 0) {
    const v = dev.sampleRate / 1000;
    return `${dev.name} — ${Number.isInteger(v) ? v : v.toFixed(1)} kHz`;
  }
  return dev.name;
}

export interface QualitySheetProps {
  open: boolean;
  onClose: () => void;
  track: Pick<TrackRow, "format" | "sampleRate" | "bitDepth">;
}

/**
 * Feuille « Qualite de lecture » — INFORMATIVE (v1). Montre la qualite de la SOURCE (depuis la
 * piste), le peripherique de sortie detecte (IPC `audio:default-device`), et presente les trois
 * modes. Honnete : v1 NE FAIT PAS de bit-perfect / WASAPI exclusif — le graphe Web Audio suit la
 * frequence par defaut de la sortie. On n'affiche donc aucune qualite que l'app ne delivre pas :
 * « Equilibre » (suivre la sortie) est le comportement reel ; les deux autres sont annonces « a
 * venir » et grises. Fermee, `.sheet-wrap` passe en `display:none` : rien de focusable hors-ecran.
 */
export function QualitySheet({ open, onClose, track }: QualitySheetProps): JSX.Element {
  const q = describeQuality(track);
  const [device, setDevice] = useState<AudioDeviceInfo | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Piege de focus de la feuille (dialogue modal) : confine Tab, Echap ferme, focus restaure a la
  // fermeture. Imbrique dans la vue lecture : quand la feuille a le focus elle traite Tab/Echap en
  // premier (preventDefault), et le piege parent respecte `defaultPrevented`.
  useFocusTrap(sheetRef, { active: open, onEscape: onClose });

  // Interroge le peripherique de sortie a chaque ouverture (il peut changer entre deux lectures).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    window.benten.audio
      .defaultDevice()
      .then((d) => {
        if (alive) setDevice(d);
      })
      .catch(() => {
        if (alive) setDevice(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const srcVal = compactSource(track);

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
          On ne peut jamais depasser la qualite du fichier d'origine. Benten lit la source telle
          quelle, puis la laisse suivre ta sortie systeme.
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

        <div className="qopt dim" aria-disabled="true">
          <div className="r" />
          <div className="txt">
            <b>
              Fidelite maximale<span className="soon">a venir</span>
            </b>
            <span>Bit-perfect, aucune conversion — prevu pour une version ulterieure.</span>
          </div>
          <div className="val">{srcVal}</div>
        </div>

        <div className="qopt sel">
          <div className="r" />
          <div className="txt">
            <b>Equilibre</b>
            <span>Suit ta sortie audio — comportement actuel.</span>
          </div>
          <div className="val">systeme</div>
        </div>

        <div className="qopt dim" aria-disabled="true">
          <div className="r" />
          <div className="txt">
            <b>
              Econome<span className="soon">a venir</span>
            </b>
            <span>Moins de ressources, batterie preservee — prevu pour plus tard.</span>
          </div>
          <div className="val">—</div>
        </div>

        <p className="note">
          Sortie detectee : <b>{describeOutput(device)}</b>. En v1, Benten lit la source et laisse
          ta sortie systeme gerer la conversion finale ; il n'y a pas encore de mode bit-perfect
          exclusif.
        </p>
      </div>
    </div>
  );
}
