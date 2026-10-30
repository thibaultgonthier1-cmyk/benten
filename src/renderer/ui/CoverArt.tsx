import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { artUrl } from "../lib/library";
import { generativeCover } from "../lib/cover";
import { useMotion } from "./useMotion";
import "./tiles.css";

export interface CoverArtProps {
  artKey: string | null | undefined;
  /** Graine de la pochette générative de repli (stable : id + titre d'album). */
  seed: string;
  alt?: string;
  /** Teinte d'attente (couleur CSS) affichée tant que l'image n'est pas décodée. */
  placeholder?: string;
  className?: string;
}

type Phase = "loading" | "reveal" | "done";

/** Filet de sécurité : fin de révélation forcée si `transitionend` ne vient pas (élément masqué). */
const REVEAL_MAX_MS = 900;

/**
 * Pochette avec apparition « blur-up » : un aplat teinté attend l'image ; au chargement, une copie
 * floutée (statique) apparaît d'abord puis la version nette se fond par-dessus (opacité + léger
 * zoom arrière — transform/opacity uniquement). Une image déjà en cache au montage (défilement de
 * la grille virtualisée) s'affiche aussitôt, sans rejouer l'animation. Repli génératif si l'art
 * est absent ou illisible. Remplit son conteneur (positionné).
 */
function CoverArtImpl({ artKey, seed, alt = "", placeholder, className }: CoverArtProps): JSX.Element {
  const url = artUrl(artKey, 512);
  const [failed, setFailed] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const imgRef = useRef<HTMLImageElement>(null);
  const gen = useMemo(() => generativeCover(seed), [seed]);
  const showImage = url !== null && failed !== url;
  const m = useMotion();

  // Nouvelle URL : on repart du chargement, sauf si l'image est déjà décodée (cache mémoire).
  useLayoutEffect(() => {
    const img = imgRef.current;
    setPhase(img && img.complete && img.naturalWidth > 0 ? "done" : "loading");
  }, [url]);

  useEffect(() => {
    if (phase !== "reveal") return;
    const id = setTimeout(() => setPhase("done"), REVEAL_MAX_MS);
    return () => clearTimeout(id);
  }, [phase]);

  const style = placeholder ? ({ "--cover-ph": placeholder } as CSSProperties) : undefined;

  if (!showImage) {
    return (
      <span className={`cover-art is-gen${className ? ` ${className}` : ""}`} aria-hidden={alt ? undefined : true}>
        <span className="cover-art__gen" role={alt ? "img" : undefined} aria-label={alt || undefined} dangerouslySetInnerHTML={{ __html: gen.svg }} />
      </span>
    );
  }

  return (
    <span className={`cover-art is-${phase}${className ? ` ${className}` : ""}`} style={style}>
      {phase === "reveal" && <img className="cover-art__blur" src={url} alt="" aria-hidden="true" draggable={false} />}
      <img
        ref={imgRef}
        className="cover-art__img"
        src={url}
        alt={alt}
        draggable={false}
        decoding="async"
        onLoad={() => setPhase((p) => (p === "done" || !m.enabled ? "done" : "reveal"))}
        onError={() => setFailed(url)}
        onTransitionEnd={(e) => {
          if (e.propertyName === "opacity") setPhase("done");
        }}
      />
    </span>
  );
}

export const CoverArt = memo(CoverArtImpl);
