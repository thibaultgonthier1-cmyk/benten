import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandEntry,
  journalCommand,
  jumpWithOrigin,
  setCommandJournal,
  withOrigin,
} from "../src/renderer/runtime/transportJournal";
import { bindMediaSession } from "../src/renderer/runtime/mediaSession";
import { createShellShortcuts } from "../src/renderer/shell/shellShortcuts";
import { createPlayerStore } from "../src/renderer/state/player";
import { createUiStore } from "../src/renderer/state/ui";
import type { PlayerControls } from "../src/renderer/components/controls";
import type { DiagEntry } from "../src/shared/diagnostics";
import { validateDiagEntries } from "../src/main/journal";
import type { TrackRow } from "../src/shared/types";

const fakeControls = (): PlayerControls & Record<string, ReturnType<typeof vi.fn>> =>
  ({
    playAlbum: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seekFraction: vi.fn(),
  }) as unknown as PlayerControls & Record<string, ReturnType<typeof vi.fn>>;

const track = (id: number): TrackRow => ({
  id,
  path: `C:/m/${id}.flac`,
  title: `t${id}`,
  artist: "A",
  album: "Al",
  albumArtist: null,
  albumId: 1,
  trackNo: id,
  discNo: 1,
  durationSec: 200,
  format: "flac",
  sampleRate: 44100,
  bitDepth: 16,
  playable: true,
  artKey: null,
  mtimeMs: null,
  sizeBytes: null,
  addedAtMs: null,
});

class FakeMediaSession {
  metadata: unknown = null;
  playbackState: MediaSessionPlaybackState = "none";
  handlers = new Map<string, ((details: MediaSessionActionDetails) => void) | null>();
  setActionHandler(action: string, handler: ((d: MediaSessionActionDetails) => void) | null): void {
    this.handlers.set(action, handler);
  }
  setPositionState(): void {}
  fire(action: string, details: Partial<MediaSessionActionDetails> = {}): void {
    this.handlers.get(action)!({ action, ...details } as MediaSessionActionDetails);
  }
}

let log: DiagEntry[] = [];
let release: (() => void) | undefined;
const capture = (): void => {
  log = [];
  setCommandJournal((e) => log.push(e));
};
const commands = (): Record<string, unknown>[] =>
  log.filter((e) => e.kind === "engine" && e["event"] === "command") as Record<string, unknown>[];

afterEach(() => {
  release?.();
  release = undefined;
  setCommandJournal(null);
});

describe("commandEntry / journalCommand", () => {
  it("forme : kind engine, event command, cmd, origin, détails ; accepté par la validation du Main", () => {
    const e = commandEntry("pause", "media-session", { action: "pause" });
    expect(e).toMatchObject({ kind: "engine", event: "command", cmd: "pause", origin: "media-session", action: "pause" });
    expect(typeof e.t).toBe("string");
    expect(() => validateDiagEntries([e])).not.toThrow();
  });

  it("sans journal actif : no-op ; un journal qui lève n'interrompt rien", () => {
    expect(() => journalCommand("toggle", "ui")).not.toThrow();
    setCommandJournal(() => {
      throw new Error("ipc down");
    });
    expect(() => journalCommand("toggle", "ui")).not.toThrow();
  });
});

describe("withOrigin", () => {
  it("consigne chaque commande avec son origine puis délègue à l'identique", () => {
    capture();
    const raw = fakeControls();
    const c = withOrigin(raw, "ui", { getStatus: () => "playing" });
    const album = { id: 1, title: "Al", artist: "A", artKey: null, tracks: [track(1)] };
    c.toggle();
    c.next();
    c.prev();
    c.seekFraction(0.5);
    c.playAlbum(album, 0);
    expect(raw.toggle).toHaveBeenCalledTimes(1);
    expect(raw.next).toHaveBeenCalledTimes(1);
    expect(raw.prev).toHaveBeenCalledTimes(1);
    expect(raw.seekFraction).toHaveBeenCalledWith(0.5);
    expect(raw.playAlbum).toHaveBeenCalledWith(album, 0);
    expect(commands().map((e) => [e["cmd"], e["origin"]])).toEqual([
      ["toggle", "ui"],
      ["next", "ui"],
      ["prev", "ui"],
      ["seek", "ui"],
      ["play", "ui"],
    ]);
    // Bascule depuis « playing » : l'intention est une pause.
    expect(commands()[0]).toMatchObject({ status: "playing", intent: "pause" });
  });

  it("ré-étiqueter des commandes déjà étiquetées : une seule entrée, la nouvelle origine", () => {
    capture();
    const raw = fakeControls();
    const shortcut = withOrigin(withOrigin(raw, "ui"), "shortcut");
    shortcut.toggle();
    expect(raw.toggle).toHaveBeenCalledTimes(1);
    expect(commands().map((e) => e["origin"])).toEqual(["shortcut"]);
  });
});

describe("origine des commandes", () => {
  it("action mediaSession « pause » → command origin media-session (+ action)", () => {
    capture();
    const store = createPlayerStore();
    store.getState().setQueue([track(1)], 0);
    store.setState({ status: "playing" });
    const ms = new FakeMediaSession();
    const raw = fakeControls();
    release = bindMediaSession(store, raw, ms as unknown as MediaSession, { fetchArt: null });
    ms.fire("pause");
    expect(raw.toggle).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual([
      expect.objectContaining({ cmd: "pause", origin: "media-session", action: "pause", status: "playing" }),
    ]);
  });

  it("action mediaSession sans effet (pause déjà en pause) : consignée quand même", () => {
    capture();
    const store = createPlayerStore();
    store.setState({ status: "paused" });
    const ms = new FakeMediaSession();
    const raw = fakeControls();
    release = bindMediaSession(store, raw, ms as unknown as MediaSession, { fetchArt: null });
    ms.fire("pause");
    ms.fire("stop");
    ms.fire("nexttrack");
    ms.fire("seekto", { seekTime: 12 });
    expect(raw.toggle).not.toHaveBeenCalled();
    expect(commands().map((e) => [e["cmd"], e["action"], e["noop"]])).toEqual([
      ["pause", "pause", true],
      ["pause", "stop", true],
      ["next", "nexttrack", false],
      ["seek", "seekto", true],
    ]);
  });

  it("session média branchée sur les commandes « ui » (runtime) : une seule entrée, media-session", () => {
    capture();
    const store = createPlayerStore();
    store.getState().setQueue([track(1)], 0);
    store.setState({ status: "playing" });
    const ms = new FakeMediaSession();
    const raw = fakeControls();
    const ui = withOrigin(raw, "ui", { getStatus: () => store.getState().status });
    release = bindMediaSession(store, ui, ms as unknown as MediaSession, { fetchArt: null });
    ms.fire("pause");
    ms.fire("nexttrack");
    expect(raw.toggle).toHaveBeenCalledTimes(1);
    expect(raw.next).toHaveBeenCalledTimes(1);
    expect(commands().map((e) => [e["cmd"], e["origin"]])).toEqual([
      ["pause", "media-session"],
      ["next", "media-session"],
    ]);
    // Hors session média, les mêmes commandes restent « ui ».
    ui.toggle();
    expect(commands().at(-1)).toMatchObject({ cmd: "toggle", origin: "ui" });
  });

  it("saut mediaSession sans durée connue : noop:true ; avec durée : noop:false", () => {
    capture();
    const store = createPlayerStore();
    store.setState({ status: "playing" });
    const ms = new FakeMediaSession();
    const raw = fakeControls();
    release = bindMediaSession(store, raw, ms as unknown as MediaSession, { fetchArt: null });
    ms.fire("seekforward");
    ms.fire("seekto", { seekTime: 5 });
    expect(raw.seekFraction).not.toHaveBeenCalled();
    store.getState().setQueue([track(1)], 0);
    ms.fire("seekto", { seekTime: 50 });
    ms.fire("seekbackward");
    expect(raw.seekFraction).toHaveBeenCalledTimes(2);
    expect(commands().map((e) => [e["action"], e["noop"]])).toEqual([
      ["seekforward", true],
      ["seekto", true],
      ["seekto", false],
      ["seekbackward", false],
    ]);
  });

  it("saut dans la file (panneau File d'attente) : command « jump », origine ui", () => {
    capture();
    const jumpTo = vi.fn();
    const store = { getState: () => ({ status: "paused", jumpTo }) };
    jumpWithOrigin(store, 3, "ui");
    expect(jumpTo).toHaveBeenCalledWith(3);
    expect(commands()).toEqual([expect.objectContaining({ cmd: "jump", origin: "ui", index: 3, status: "paused" })]);
  });

  it("raccourci global « toggle » → command origin shortcut", () => {
    capture();
    const player = createPlayerStore();
    player.getState().setQueue([track(1)], 0);
    player.setState({ status: "playing" });
    const raw = fakeControls();
    const handlers = createShellShortcuts({
      controls: withOrigin(raw, "ui"),
      focusSearch: () => undefined,
      player,
      ui: createUiStore(),
      isModalOpen: () => false,
    });
    handlers.toggle!();
    expect(raw.toggle).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual([expect.objectContaining({ cmd: "toggle", origin: "shortcut", intent: "pause" })]);
  });
});
