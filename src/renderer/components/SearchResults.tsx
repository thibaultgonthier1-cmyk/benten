import type React from "react";
import { useMemo } from "react";
import { groupTracksToAlbums, type Album } from "../lib/library";
import type { TrackRow } from "../../shared/types";
import { LibraryGrid } from "./LibraryGrid";

/**
 * Vue de recherche : les pistes renvoyees par `library:search` sont regroupees en albums
 * (`groupTracksToAlbums`) et rendues avec la meme grille que la bibliotheque — meme DA, meme
 * geste « cliquer = jouer l'album ». Zero resultat affiche une note discrete.
 */
export interface SearchResultsProps {
  tracks: readonly TrackRow[];
  query: string;
  /** Element scrollable parent (le `.main`), pour la grille virtualisee. */
  scrollRef: React.RefObject<HTMLElement>;
  playingAlbumId?: number | null;
  onPlay: (album: Album) => void;
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
  playingAlbumId,
  onPlay,
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
        <LibraryGrid
          albums={albums}
          scrollRef={scrollRef}
          playingAlbumId={playingAlbumId}
          onPlay={onPlay}
        />
      )}
    </section>
  );
}
