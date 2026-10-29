import { memo } from "react";
import { ListMusic } from "lucide-react";
import { CoverArt } from "./CoverArt";
import { ICON_STROKE } from "./IconButton";
import "./tiles.css";

export interface PlaylistMosaicProps {
  /** Pochettes distinctes de la playlist (`mosaicArtKeys`), dans l'ordre. */
  artKeys: readonly string[];
  /** Graine stable (id de playlist). */
  seed: string;
  /** Taille de l'icône de la pochette vide (px). */
  iconSize?: number;
}

/**
 * Pochette d'une playlist : mosaïque 2×2 des 4 premières pochettes distinctes ; une seule pochette
 * pleine s'il y en a moins de 4 (comme Apple Music) ; playlist sans pochette : aplat « matière »
 * teinté de l'accent, icône au trait. Remplit son conteneur (positionné, coins hérités).
 */
function PlaylistMosaicImpl({ artKeys, seed, iconSize = 34 }: PlaylistMosaicProps): JSX.Element {
  if (artKeys.length >= 4) {
    return (
      <span className="pl-mosaic is-grid">
        {artKeys.slice(0, 4).map((k, i) => (
          <span key={`${k}:${i}`} className="pl-mosaic__cell">
            <CoverArt artKey={k} seed={`${seed}:${i}`} />
          </span>
        ))}
      </span>
    );
  }
  if (artKeys.length > 0) {
    return (
      <span className="pl-mosaic">
        <CoverArt artKey={artKeys[0]} seed={seed} />
      </span>
    );
  }
  return (
    <span className="pl-mosaic is-empty">
      <ListMusic size={iconSize} strokeWidth={ICON_STROKE} aria-hidden />
    </span>
  );
}

export const PlaylistMosaic = memo(PlaylistMosaicImpl, (a, b) => a.seed === b.seed && a.iconSize === b.iconSize && a.artKeys.join("|") === b.artKeys.join("|"));
