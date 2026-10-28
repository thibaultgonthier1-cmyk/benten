import { extname } from "node:path";
import { AUDIO_EXTENSIONS } from "./scanner";

/**
 * Extensions surveillees : l'audio connu + `.m4p` (protege par DRM). On surveille `.m4p` comme
 * l'indexeur pour que son ajout/retrait soit refletes dans l'index (il sera compte `skipped` a
 * l'indexation, mais sa disparition doit tout de meme le retirer de la base).
 */
const WATCHED_EXTENSIONS: ReadonlySet<string> = new Set([...AUDIO_EXTENSIONS, ".m4p"]);

function isWatchedAudio(path: string): boolean {
  return WATCHED_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Surface minimale d'un watcher chokidar, injectable pour les tests. */
export interface WatchHandle {
  on(event: "add" | "change" | "unlink", listener: (path: string) => void): WatchHandle;
  close(): Promise<void>;
}

/** Fabrique de watcher (prod : `chokidar.watch`). Injectable → les tests passent un faux. */
export type WatchFactory = (
  paths: readonly string[],
  options: { ignoreInitial?: boolean },
) => WatchHandle;

/** Bilan d'un lot de veille, passe a `onChanged` une fois par lot. */
export interface WatchSummary {
  /** Fichiers ajoutes/modifies (re)indexes avec succes. */
  indexed: number;
  /** Fichiers supprimes retires de l'index avec succes. */
  removed: number;
  /** Echecs par fichier (indexOne/removeOne ayant leve) — comptes, jamais propages. */
  errors: number;
}

export interface CreateWatcherOptions {
  /** (Re)indexe un fichier ajoute/modifie. Peut lever : l'erreur est captee et comptee. */
  indexOne: (path: string) => void | Promise<void>;
  /** Retire un fichier supprime de l'index. Peut lever : l'erreur est captee et comptee. */
  removeOne: (path: string) => void | Promise<void>;
  /** Appele UNE fois par lot, apres traitement, avec le bilan. */
  onChanged: (summary: WatchSummary) => void;
  /** Fenetre d'agregation (trailing debounce) en ms. Defaut 1000. */
  debounceMs?: number;
  /** Fabrique chokidar injectee. */
  watch: WatchFactory;
}

/** Poignee rendue par `createWatcher` : fermeture propre du watcher sous-jacent. */
export interface WatcherHandle {
  close(): Promise<void>;
}

/**
 * Cree une veille de dossiers sur `roots`. Les evenements `add`/`change`/`unlink` de fichiers audio
 * sont AGREGES sur une fenetre `debounceMs` (trailing debounce : chaque evenement repousse l'echeance)
 * puis traites en UN LOT : `indexOne(path)` pour chaque ajout/modification, `removeOne(path)` pour
 * chaque suppression, enfin `onChanged(summary)` UNE SEULE FOIS.
 *
 * ROBUSTESSE : une exception levee par `indexOne`/`removeOne` sur un fichier est CAPTEE et COMPTEE
 * (`errors`) ; elle n'interrompt pas le reste du lot et ne tue pas la veille. Les lots sont serialises
 * (chaines) pour qu'un lot n'empiete pas sur le suivant. Une exception de `onChanged` est elle aussi
 * avalee (un consommateur fautif ne doit pas casser la veille).
 *
 * LECTURE SEULE : la veille n'OBSERVE que le disque et ne mute QUE l'index (via `indexOne`/`removeOne`).
 * Elle n'ecrit, ne deplace ni ne supprime jamais de fichier.
 */
export function createWatcher(
  roots: readonly string[],
  options: CreateWatcherOptions,
): WatcherHandle {
  const { indexOne, removeOne, onChanged, watch } = options;
  const debounceMs = options.debounceMs ?? 1000;

  // Chemins a (re)indexer et a retirer, dedoublonnes. Le dernier evenement d'un chemin gagne :
  // un re-ajout annule une suppression en attente, et inversement.
  const toIndex = new Set<string>();
  const toRemove = new Set<string>();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // Chaine de lots : garantit qu'un lot est entierement traite avant le suivant.
  let pending: Promise<void> = Promise.resolve();

  const processBatch = async (indexPaths: string[], removePaths: string[]): Promise<void> => {
    let indexed = 0;
    let removed = 0;
    let errors = 0;
    for (const p of indexPaths) {
      try {
        await indexOne(p);
        indexed++;
      } catch {
        errors++;
      }
    }
    for (const p of removePaths) {
      try {
        await removeOne(p);
        removed++;
      } catch {
        errors++;
      }
    }
    try {
      onChanged({ indexed, removed, errors });
    } catch {
      /* un onChanged fautif ne doit jamais tuer la veille */
    }
  };

  const flush = (): void => {
    timer = undefined;
    if (closed) return;
    const indexPaths = [...toIndex];
    const removePaths = [...toRemove];
    toIndex.clear();
    toRemove.clear();
    if (indexPaths.length === 0 && removePaths.length === 0) return;
    // On chaine sur `pending` : les lots ne se chevauchent pas. `processBatch` ne rejette jamais.
    pending = pending.then(() => processBatch(indexPaths, removePaths));
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const onAddOrChange = (path: string): void => {
    if (closed || !isWatchedAudio(path)) return;
    toRemove.delete(path);
    toIndex.add(path);
    schedule();
  };

  const onUnlink = (path: string): void => {
    if (closed || !isWatchedAudio(path)) return;
    toIndex.delete(path);
    toRemove.add(path);
    schedule();
  };

  const fsw = watch(roots, { ignoreInitial: true });
  fsw.on("add", onAddOrChange);
  fsw.on("change", onAddOrChange);
  fsw.on("unlink", onUnlink);

  return {
    close: async (): Promise<void> => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // On laisse un lot en cours se terminer (il ne rejette pas), puis on ferme le watcher.
      await pending.catch(() => undefined);
      await fsw.close();
    },
  };
}
