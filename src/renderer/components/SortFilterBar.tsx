import type { AlbumSortField, AlbumSortFilter } from "../lib/library";

/**
 * Barre de tri + filtres de la vue albums (DA Benten). Composant CONTRÔLÉ : il ne garde aucun état,
 * il lit `value` et notifie chaque changement via `onChange`. Expose un menu de tri (titre/artiste/
 * durée), une bascule de sens (croissant/décroissant) et deux bascules de filtre (favoris, sans
 * perte). Le filtre « favoris » est câblé mais sa donnée arrive en Task 9 (voir `sortFilterAlbums`).
 */
export interface SortFilterBarProps {
  value: AlbumSortFilter;
  onChange: (next: AlbumSortFilter) => void;
}

const SORT_OPTIONS: ReadonlyArray<{ value: AlbumSortField; label: string }> = [
  { value: "title", label: "Titre" },
  { value: "artist", label: "Artiste" },
  { value: "duration", label: "Durée" },
];

export function SortFilterBar({ value, onChange }: SortFilterBarProps): JSX.Element {
  const set = (patch: Partial<AlbumSortFilter>): void => onChange({ ...value, ...patch });
  const asc = value.dir === "asc";

  return (
    <div className="sortbar" role="group" aria-label="Tri et filtres">
      <label className="sortsel">
        <span className="sr">Trier par</span>
        <select
          value={value.sort}
          onChange={(e) => set({ sort: e.target.value as AlbumSortField })}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="chip dir"
        onClick={() => set({ dir: asc ? "desc" : "asc" })}
        aria-label={asc ? "Ordre croissant" : "Ordre décroissant"}
        title={asc ? "Croissant" : "Décroissant"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {asc ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}
        </svg>
        {asc ? "A→Z" : "Z→A"}
      </button>

      <button
        type="button"
        className={`chip toggle${value.favoritesOnly ? " on" : ""}`}
        aria-pressed={value.favoritesOnly}
        onClick={() => set({ favoritesOnly: !value.favoritesOnly })}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20.5l-1.3-1.2C5.4 14.5 2.5 11.9 2.5 8.6 2.5 6.2 4.4 4.3 6.8 4.3c1.4 0 2.7.65 3.6 1.7l1.6 1.9 1.6-1.9c.9-1.05 2.2-1.7 3.6-1.7 2.4 0 4.3 1.9 4.3 4.3 0 3.3-2.9 5.9-8.2 10.7L12 20.5z" />
        </svg>
        Favoris
      </button>

      <button
        type="button"
        className={`chip toggle${value.losslessOnly ? " on" : ""}`}
        aria-pressed={value.losslessOnly}
        onClick={() => set({ losslessOnly: !value.losslessOnly })}
      >
        Sans perte
      </button>
    </div>
  );
}
