import { useMemo, useState } from "react";
import { artUrl } from "../lib/library";
import { generativeCover } from "../lib/cover";

/**
 * Pochette : rend l'image du cache via `benten-art://` en `<img src>` (PAS `fetch` : le
 * protocole n'expose pas d'en-tete CORS). Repli sur une pochette generative deterministe si
 * `artKey` est null OU si l'image echoue a charger (cache absent / illisible).
 */
export interface CoverProps {
  artKey: string | null | undefined;
  /** Cle de repli pour la pochette generative (id ou titre d'album), stable. */
  seed: string;
  /** Taille de vignette demandee au cache (px). */
  size?: number;
  alt?: string;
}

export function Cover({ artKey, seed, size = 256, alt = "" }: CoverProps): JSX.Element {
  // On memorise l'URL qui a ECHOUE (pas un simple booleen) : ainsi, quand `artKey`/`url` change
  // (changement de morceau dans un <Cover> persistant comme le mini-lecteur / la vue lecture), on
  // retente automatiquement la vraie pochette au lieu de rester bloque sur le repli generatif.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = artUrl(artKey, size);
  const gen = useMemo(() => generativeCover(seed), [seed]);

  if (url && failedUrl !== url) {
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        draggable={false}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return <div className="gen-cover" aria-hidden="true" dangerouslySetInnerHTML={{ __html: gen.svg }} />;
}

/** Teinte d'accent de la pochette generative (pour lueurs / fond) — deterministe. */
export function coverAccent(seed: string): string {
  return generativeCover(seed).accent;
}
