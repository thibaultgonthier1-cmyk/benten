/**
 * Frontière typée du pipeline Apple Music (importé de Prism).
 *
 * Les deux modules portés (`collection.ts`, `download.ts`) contiennent le code d'origine, éprouvé
 * sur une playlist de 969 titres : résolution via `amp-api` (jeton du lecteur web, pagination
 * complète) et téléchargement par plusieurs processus `gamdl`. On ne les réécrit pas ; on expose
 * ici une surface typée, stable et testable.
 */

import { resolveAppleCollection } from "./collection";
import { AppleDownloadRunner } from "./download";

/** Piste telle que la résolution Apple la renvoie (champs réels du module porté). */
export interface AppleTrack {
  title: string;
  artist: string;
  album: string;
  /** Durée en secondes. */
  duration: number;
  trackNo: number | null;
  trackId: string;
  url: string;
  artworkUrl: string;
}

export interface AppleCollection {
  ok: boolean;
  kind: string;
  playlistName: string;
  tracks: AppleTrack[];
  reason: string;
  truncated: boolean;
}

/** Lien de playlist ou d'album Apple Music ? */
export function isAppleCollectionUrl(url: unknown): boolean {
  return isAppleCollectionUrlImpl(url);
}

/**
 * Résout un lien Apple Music en liste de pistes.
 * Lève si le réseau échoue ; renvoie `ok: false` pour un lien invalide.
 */
export async function resolveCollection(url: string): Promise<AppleCollection> {
  const result = (await resolveAppleCollection(url)) as AppleCollection;
  return {
    ok: Boolean(result?.ok),
    kind: String(result?.kind ?? "unknown"),
    playlistName: String(result?.playlistName ?? ""),
    tracks: Array.isArray(result?.tracks) ? result.tracks : [],
    reason: String(result?.reason ?? ""),
    truncated: Boolean(result?.truncated),
  };
}

export interface AppleProgress {
  running: boolean;
  done: number;
  total: number;
  workers: number;
  startedAt: number;
  error: string;
}

export interface AppleRunnerOptions {
  cookiesPath: string;
  outputPath: string;
  databasePath: string;
  workers?: number;
  onProgress?: (state: AppleProgress, line?: string) => void;
}

/**
 * Lance `gamdl` sur des liens Apple. Les fichiers tombent dans `outputPath`
 * (`Musique/Benten/Apple`), le runner signale l'avancement et se termine par un état final.
 */
export class AppleRunner {
  // Le module porté n'est pas typé (`@ts-nocheck`) : c'est ici, et seulement ici, qu'on le dompte.
  private readonly inner: {
    start(tracks: readonly string[], options?: { workers?: number }): Promise<AppleProgress>;
    cancel(): void;
  };

  constructor(options: AppleRunnerOptions) {
    const runner: unknown = new AppleDownloadRunner({
      cookiesPath: options.cookiesPath,
      outputPath: options.outputPath,
      databasePath: options.databasePath,
      workers: options.workers ?? 3,
      onProgress: (state: AppleProgress) => options.onProgress?.(state),
    } as never);
    this.inner = runner as {
      start(tracks: readonly string[], options?: { workers?: number }): Promise<AppleProgress>;
      cancel(): void;
    };
  }

  start(urls: readonly string[], workers?: number): Promise<AppleProgress> {
    return this.inner.start([...urls], workers ? { workers } : undefined);
  }

  cancel(): void {
    this.inner.cancel();
  }
}

// Import séparé pour garder le nom public `isAppleCollectionUrl` et l'implémentation portée.
import { isAppleCollectionUrl as isAppleCollectionUrlImpl } from "./collection";


