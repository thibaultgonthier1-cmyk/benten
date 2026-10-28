import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWatcher, type WatchFactory } from "../src/main/library/watcher";

/**
 * Faux watcher chokidar : on enregistre les handlers par evenement et on expose `emit` pour
 * simuler des evenements du disque, plus un `close` espionnable. `watch` est la fabrique injectee
 * (equivalent de `chokidar.watch` en prod) ; elle renvoie toujours ce meme faux watcher.
 */
function makeFakeChokidar() {
  const handlers = new Map<string, Array<(p: string) => void>>();
  const close = vi.fn(async (): Promise<void> => undefined);
  const watcher = {
    on: vi.fn((event: string, cb: (p: string) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return watcher;
    }),
    close,
    emit: (event: string, path: string): void => {
      for (const cb of handlers.get(event) ?? []) cb(path);
    },
  };
  const watch = vi.fn((_paths: readonly string[], _opts: unknown) => watcher);
  return { watch: watch as unknown as WatchFactory, raw: watch, watcher };
}

const DEBOUNCE = 1000;

describe("createWatcher — veille de dossiers (debounce + agregation + robustesse)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ouvre le watcher avec ignoreInitial sur les racines donnees", () => {
    const { watch, raw, watcher } = makeFakeChokidar();
    createWatcher(["/music"], {
      indexOne: vi.fn(),
      removeOne: vi.fn(),
      onChanged: vi.fn(),
      debounceMs: DEBOUNCE,
      watch,
    });
    expect(raw).toHaveBeenCalledTimes(1);
    const [paths, opts] = raw.mock.calls[0]!;
    expect(paths).toEqual(["/music"]);
    expect(opts).toMatchObject({ ignoreInitial: true });
    // Les trois evenements pertinents sont abonnes.
    const events = watcher.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(["add", "change", "unlink"]));
  });

  it("agrege une rafale d'add : un seul lot indexOne (une fois par chemin) et un seul onChanged", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (): Promise<void> => undefined);
    const removeOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    createWatcher(["/music"], { indexOne, removeOne, onChanged, debounceMs: DEBOUNCE, watch });

    const paths = ["/music/1.flac", "/music/2.flac", "/music/3.flac", "/music/4.flac", "/music/5.flac"];
    for (const p of paths) watcher.emit("add", p);

    // Avant la fin du debounce : rien n'est encore traite.
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(indexOne).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();

    // Apres le debounce : un seul lot.
    await vi.advanceTimersByTimeAsync(1);
    expect(indexOne).toHaveBeenCalledTimes(5);
    for (const p of paths) expect(indexOne).toHaveBeenCalledWith(p);
    expect(removeOne).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ indexed: 5, removed: 0, errors: 0 }));
  });

  it("un add repete sur le meme chemin n'indexe ce chemin qu'une fois par lot", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    createWatcher(["/music"], { indexOne, removeOne: vi.fn(), onChanged, debounceMs: DEBOUNCE, watch });

    watcher.emit("add", "/music/a.flac");
    watcher.emit("change", "/music/a.flac");
    watcher.emit("change", "/music/a.flac");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(indexOne).toHaveBeenCalledTimes(1);
    expect(indexOne).toHaveBeenCalledWith("/music/a.flac");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("un unlink appelle removeOne avec le chemin supprime", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (): Promise<void> => undefined);
    const removeOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    createWatcher(["/music"], { indexOne, removeOne, onChanged, debounceMs: DEBOUNCE, watch });

    watcher.emit("unlink", "/music/gone.flac");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(removeOne).toHaveBeenCalledTimes(1);
    expect(removeOne).toHaveBeenCalledWith("/music/gone.flac");
    expect(indexOne).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ indexed: 0, removed: 1, errors: 0 }));
  });

  it("une erreur de indexOne sur un chemin n'interrompt pas le lot et ne rejette pas ; onChanged est quand meme appele", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (p: string): Promise<void> => {
      if (p === "/music/bad.flac") throw new Error("boom");
    });
    const removeOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    createWatcher(["/music"], { indexOne, removeOne, onChanged, debounceMs: DEBOUNCE, watch });

    watcher.emit("add", "/music/ok1.flac");
    watcher.emit("add", "/music/bad.flac");
    watcher.emit("add", "/music/ok2.flac");

    // Ne doit pas rejeter malgre le throw interne (un `await` qui rejetterait ferait echouer le test).
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    // Les trois chemins sont tentes (le throw d'un seul ne saute pas les autres).
    expect(indexOne).toHaveBeenCalledTimes(3);
    expect(indexOne).toHaveBeenCalledWith("/music/ok1.flac");
    expect(indexOne).toHaveBeenCalledWith("/music/ok2.flac");
    // onChanged fire une fois, l'erreur est comptee.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ indexed: 2, errors: 1 }));
  });

  it("ignore les evenements sur des extensions non audio (aucun traitement, aucun onChanged)", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (): Promise<void> => undefined);
    const removeOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    createWatcher(["/music"], { indexOne, removeOne, onChanged, debounceMs: DEBOUNCE, watch });

    watcher.emit("add", "/music/readme.txt");
    watcher.emit("add", "/music/cover.jpg");
    watcher.emit("change", "/music/.DS_Store");
    watcher.emit("unlink", "/music/notes.md");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(indexOne).not.toHaveBeenCalled();
    expect(removeOne).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("surveille aussi les .m4p (ensemble audio + .m4p)", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    createWatcher(["/music"], { indexOne, removeOne: vi.fn(), onChanged, debounceMs: DEBOUNCE, watch });

    watcher.emit("add", "/music/protected.m4p");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(indexOne).toHaveBeenCalledWith("/music/protected.m4p");
  });

  it("close() ferme le watcher chokidar injecte", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const handle = createWatcher(["/music"], {
      indexOne: vi.fn(),
      removeOne: vi.fn(),
      onChanged: vi.fn(),
      debounceMs: DEBOUNCE,
      watch,
    });
    await handle.close();
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("apres close(), un evenement en vol n'est plus traite", async () => {
    const { watch, watcher } = makeFakeChokidar();
    const indexOne = vi.fn(async (): Promise<void> => undefined);
    const onChanged = vi.fn();
    const handle = createWatcher(["/music"], {
      indexOne,
      removeOne: vi.fn(),
      onChanged,
      debounceMs: DEBOUNCE,
      watch,
    });
    watcher.emit("add", "/music/late.flac");
    await handle.close();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(indexOne).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
