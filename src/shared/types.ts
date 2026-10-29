// Types partagés Main <-> Preload <-> Renderer. Aucune dépendance Node/Electron ici.
import type { DiagEntry } from "./diagnostics";

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
  /**
   * Date d'ajout (ms epoch) = création du fichier (birthtime, repli mtime), figée à la première
   * indexation : l'ordre d'ajout réel de la bibliothèque. `null` si inconnue.
   */
  addedAtMs: number | null;
}

/**
 * Piste à insérer / mettre à jour (clé naturelle : `path`). `addedAtMs` est facultatif : il n'est
 * pris qu'à l'insertion (ou pour compléter une valeur NULL), jamais pour réécrire une date connue.
 */
export type TrackInput = Omit<TrackRow, "id" | "albumId" | "addedAtMs"> & { addedAtMs?: number | null };

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

/** Playlist telle que listée (avec son nombre de pistes). */
export interface PlaylistRow {
  id: number;
  name: string;
  /** Nombre de pistes (LEFT JOIN : 0 pour une playlist vide). */
  trackCount: number;
  /** Horodatage de création (ms epoch). */
  createdAt: number;
  /** Horodatage de dernière modification (ms epoch) ; bougé à chaque mutation. */
  updatedAt: number;
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

/**
 * Mode de qualite de lecture (Task 13). `max`/`balanced` suivent la frequence de la sortie ;
 * `economy` force 44.1 kHz. Le changement de mode recree PROPREMENT l'`AudioContext` (hors-lecture)
 * — voir `qualitySampleRate` et `AudioEngine.rebuildContext`.
 */
export type QualityMode = "max" | "balanced" | "economy";

/** API exposée au Renderer sous `window.benten` (contextBridge). */
export interface BentenApi {
  ping(): Promise<"pong">;
  library: {
    query(args: LibraryQueryArgs): Promise<LibraryQueryResult>;
    scan(paths: readonly string[]): Promise<ScanSummary>;
    /** Recherche sur titre/artiste/album (`LIKE` insensible à la casse). */
    search(args: SearchArgs): Promise<TrackRow[]>;
    /**
     * Re-résout une liste d'ids en `TrackRow` (ordre préservé, ids absents ignorés). Sert la
     * reprise de file au lancement (Task 14A).
     */
    tracksByIds(ids: readonly number[]): Promise<TrackRow[]>;
  };
  audio: {
    defaultDevice(): Promise<AudioDeviceInfo>;
    /** Enumeration fine des sorties detectees (repli sur le defaut, jamais vide, ne rejette pas). */
    listDevices(): Promise<AudioDeviceInfo[]>;
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
  playlists: {
    /** Toutes les playlists avec leur `trackCount` (triées récent d'abord). */
    list(): Promise<PlaylistRow[]>;
    /** Crée une playlist et renvoie son id. */
    create(name: string): Promise<number>;
    /** Renomme une playlist (bouge `updated_at`). */
    rename(id: number, name: string): Promise<void>;
    /** Supprime une playlist (cascade sur ses pistes). */
    remove(id: number): Promise<void>;
    /** Pistes d'une playlist, ordonnées par position. */
    tracks(id: number): Promise<TrackRow[]>;
    /** Ajoute des pistes à la fin de la playlist (positions denses). */
    add(id: number, trackIds: readonly number[]): Promise<void>;
    /** Retire la piste à `position`, puis recompacte les positions. */
    removeTrack(id: number, position: number): Promise<void>;
    /** Déplace la piste de `from` vers `to`, re-densifie les positions. */
    reorder(id: number, from: number, to: number): Promise<void>;
    /** Remet `trackId` à `position` en une transaction (annulation d'un retrait). */
    insertAt(id: number, trackId: number, position: number): Promise<void>;
  };
  /** État applicatif persisté (magasin clé/valeur `app_state`) — reprise au lancement (Task 14A). */
  state: {
    /** Lit la valeur d'une clé, ou `undefined` si absente. */
    get(key: string): Promise<string | undefined>;
    /** Écrit (upsert) la valeur d'une clé. */
    set(key: string, value: string): Promise<void>;
  };
  /** Journal audio (diagnostic des micro-coupures). */
  diagnostics: {
    /**
     * Ajoute un lot d'entrees (≤ 200, chacune ≤ 2 Ko, `kind` connu) a
     * `userData/logs/audio-journal.log`. Rejette un payload invalide (lot entier).
     */
    append(entries: readonly DiagEntry[]): Promise<void>;
  };
  /**
   * S'abonne au signal PUSH Main -> Renderer « la bibliothèque a changé » (veille de dossiers,
   * Task 14B). `cb` est appelé (sans argument) après chaque lot de re-scan incrémental ; l'UI
   * doit se contenter de re-interroger la DB (la lecture n'est JAMAIS touchée). Renvoie une
   * fonction de désabonnement.
   */
  onLibraryChanged(cb: () => void): () => void;
}

declare global {
  interface Window {
    benten: BentenApi;
  }
}
