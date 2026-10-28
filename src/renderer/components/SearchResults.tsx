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
}

export function SearchResults({
  tracks,
  query,
  scrollRef,
  playingAlbumId,
  onPlay,
}: SearchResultsProps): JSX.Element {
  const albums = useMemo(() => groupTracksToAlbums(tracks), [tracks]);
  return (
    <section className="section">
      <div className="section-head">
        <h2>Resultats</h2>
        <span className="count">
          {albums.length === 0 ? "aucun resultat" : `${albums.length} albums`}
        </span>
      </div>
      {albums.length === 0 ? (
        <div className="scan-note">
          Rien ne correspond a « {query.trim()} ».
        </div>
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
