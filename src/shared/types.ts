// Types partagés Main <-> Preload <-> Renderer. Aucune dépendance Node/Electron ici.

export type LibraryView = "albums" | "tracks" | "artists";

export interface LibraryQueryArgs {
  view: LibraryView;
  limit?: number;
  offset?: number;
}

/** Les types de lignes (album/titre/artiste) arrivent avec le schéma DB (Task 3+). */
export interface LibraryQueryResult {
  view: LibraryView;
  rows: readonly unknown[];
}

export interface ScanSummary {
  scanned: number;
  added: number;
  skipped: number;
  errors: number;
}

export interface AudioDeviceInfo {
  sampleRate: number;
  channels: number;
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
  };
}

declare global {
  interface Window {
    benten: BentenApi;
  }
}
