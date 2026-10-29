import type React from "react";
import { useMemo } from "react";
import { groupTracksToAlbums, type Album } from "../lib/library";
import type { TrackRow } from "../../shared/types";
import { AlbumGrid } from "../views/AlbumGrid";

/**
 * Vue de recherche : les pistes renvoyees par `library:search` sont regroupees en albums
 * (`groupTracksToAlbums`) et rendues avec la grille d'albums virtualisee (Tache 6) — memes tuiles,
 * memes gestes (clic = page album, bouton = lecture, clic droit = menu). Zero resultat affiche une
 * note discrete.
 */
export interface SearchResultsProps {
  tracks: readonly TrackRow[];
  query: string;
  /** Element scrollable parent, pour la grille virtualisee. */
  scrollRef: React.RefObject<HTMLElement>;
  onPlay: (album: Album) => void;
  onContextMenu?: (album: Album, e: React.MouseEvent<HTMLElement>) => void;
  /**
   * `true` une fois qu'une recherche a REELLEMENT abouti pour le terme courant. Tant qu'elle est en
   * vol (anti-rebond de 150 ms), on n'affiche NI « aucun resultat » NI « Rien ne correspond » : cela
   * evitait de faire clignoter le vide avant la premiere reponse.
   */
  searched?: boolean;
}

export function SearchResults({
  tracks,
  query,
  scrollRef,
  onPlay,
  onContextMenu,
  searched = true,
}: SearchResultsProps): JSX.Element {
  const albums = useMemo(() => groupTracksToAlbums(tracks), [tracks]);
  const empty = albums.length === 0;
  return (
    <section className="section">
      <div className="section-head">
        <h2>Résultats</h2>
        <span className="count">
          {empty ? (searched ? "aucun résultat" : "recherche…") : `${albums.length} albums`}
        </span>
      </div>
      {empty ? (
        searched ? (
          <div className="scan-note">Rien ne correspond à « {query.trim()} ».</div>
        ) : null
      ) : (
        <AlbumGrid
          albums={albums}
          scrollRef={scrollRef}
          onPlay={onPlay}
          onContextMenu={onContextMenu}
          memoryKey="search"
        />
      )}
    </section>
  );
}
