// Types partagés Main <-> Preload <-> Renderer. Aucune dépendance Node/Electron ici.

export type LibraryView = "albums" | "tracks" | "artists";

/** Sens de tri. Mappé côté repository vers le littéral SQL `ASC`/`DESC` (jamais interpolé brut). */
export type SortDir = "asc" | "desc";

/**
 * Champs de tri acceptés : ÉNUMÉRATION FERMÉE (liste blanche). Chaque champ est mappé, côté
 * repository, vers une expression de colonne sûre ; la chaîne brute n'atteint JAMAIS le SQL.
 * Albums : `title|artist|created_at|duration` ; pistes : `title|artist|album|duration|track_no`.
 * Un champ hors-liste (ou inconnu pour la vue) retombe sur le tri par défaut (`title`).
 */
export type SortField = "title" | "artist" | "album" | "created_at" | "duration" | "track_no";

/** Filtres de bibliothèque, cumulables. Tout absent/faux = aucun filtre. */
export interface LibraryFilter {
  /** Ne garder que les favoris (jointure `favorites`). */
  favoritesOnly?: boolean;
  /** Ne garder que le sans-perte (`bit_depth IS NOT NULL`). */
  losslessOnly?: boolean;
}

export interface LibraryQueryArgs {
  view: LibraryView;
  limit?: number;
  offset?: number;
  /** Champ de tri (liste blanche) ; défaut `title`. */
  sort?: SortField;
  /** Sens de tri ; défaut `asc`. */
  dir?: SortDir;
  /** Filtres cumulables. */
  filter?: LibraryFilter;
}

/** Arguments de `library:search` : terme libre + limite optionnelle. */
export interface SearchArgs {
  q: string;
  limit?: number;
}

/** Piste telle que lue dans la bibliothèque. */
export interface TrackRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  /** Artiste de l'album (tag `albumartist`) ; `null` si absent. */
  albumArtist: string | null;
  albumId: number;
  /** Numéro de piste, `null` si absent des tags. */
  trackNo: number | null;
  /** Numéro de disque, `null` si absent des tags. */
  discNo: number | null;
  durationSec: number;
  format: string;
  /** Hz ; `null` si inconnu. */
  sampleRate: number | null;
  /** Bits par échantillon ; `null` pour les formats avec perte / inconnu. */
  bitDepth: number | null;
  /** `false` si le fichier est indexé mais non lisible. */
  playable: boolean;
  /** Clé de la pochette dans le cache d'art ; `null` si aucune. */
  artKey: string | null;
  /** mtime du fichier en millisecondes (indexation incrémentale) ; `null` si inconnu. */
  mtimeMs: number | null;
  /** Taille du fichier en octets (indexation incrémentale) ; `null` si inconnue. */
  sizeBytes: number | null;
}

/** Piste à insérer / mettre à jour (clé naturelle : `path`). */
export type TrackInput = Omit<TrackRow, "id" | "albumId">;

export interface AlbumRow {
  id: number;
  title: string;
  artist: string;
  trackCount: number;
  artKey: string | null;
}

export interface ArtistRow {
  id: number;
  name: string;
  trackCount: number;
  albumCount: number;
}

export interface Page {
  limit: number;
  offset: number;
}

/** Racine de bibliothèque persistée. `audio:read-file` ne lit que sous ces racines. */
export interface SourceRow {
  id: number;
  path: string;
  /** Horodatage d'ajout (ms epoch). */
  addedAt: number;
}

export type LibraryRow = AlbumRow | TrackRow | ArtistRow;

export interface LibraryQueryResult {
  view: LibraryView;
  rows: readonly LibraryRow[];
}

export interface ScanSummary {
  scanned: number;
  added: number;
  skipped: number;
  errors: number;
}

/** Peripherique de sortie detecte (informatif). `sampleRate` absent si indisponible. */
export interface AudioDeviceInfo {
  name: string;
  sampleRate?: number;
}

/** API exposée au Renderer sous `window.benten` (contextBridge). */
export interface BentenApi {
  ping(): Promise<"pong">;
  library: {
    query(args: LibraryQueryArgs): Promise<LibraryQueryResult>;
    scan(paths: readonly string[]): Promise<ScanSummary>;
    /** Recherche sur titre/artiste/album (`LIKE` insensible à la casse). */
    search(args: SearchArgs): Promise<TrackRow[]>;
  };
  audio: {
    defaultDevice(): Promise<AudioDeviceInfo>;
    /** Octets bruts d'un fichier audio, pour decodage cote Renderer. Rejette si illisible. */
    readFile(path: string): Promise<ArrayBuffer>;
  };
  dialog: {
    /** Ouvre le selecteur de dossier natif. Renvoie le chemin choisi, ou `null` si annule. */
    pickFolder(): Promise<string | null>;
  };
  sources: {
    /** Racines persistées (ajoutées par `library.scan`). */
    list(): Promise<SourceRow[]>;
    /** Retire une racine par `id`. */
    remove(id: number): Promise<void>;
  };
  favorites: {
    /** Marque (`on=true`) ou démarque (`on=false`) une piste comme favorite. */
    toggle(trackId: number, on: boolean): Promise<void>;
    /** Ids de toutes les pistes favorites (pour amorcer le store). */
    list(): Promise<number[]>;
  };
}

declare global {
  interface Window {
    benten: BentenApi;
  }
}
