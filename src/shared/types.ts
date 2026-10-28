// Types partagés Main <-> Preload <-> Renderer. Aucune dépendance Node/Electron ici.

export type LibraryView = "albums" | "tracks" | "artists";

export interface LibraryQueryArgs {
  view: LibraryView;
  limit?: number;
  offset?: number;
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
}

declare global {
  interface Window {
    benten: BentenApi;
  }
}
