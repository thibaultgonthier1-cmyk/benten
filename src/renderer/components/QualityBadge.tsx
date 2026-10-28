import type { TrackRow } from "../../shared/types";
import { describeQuality } from "../lib/library";

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
