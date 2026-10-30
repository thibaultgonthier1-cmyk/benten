import { vi } from "vitest";
import type { BentenApi, PlaylistRow, TrackRow } from "../../src/shared/types";

export const track = (id: number, artKey: string | null = `k${id}`): TrackRow =>
  ({
    id,
    path: `/m/${id}.flac`,
    title: `t${id}`,
    artist: "A",
    album: "Al",
    albumArtist: null,
    albumId: 1,
    trackNo: id,
    discNo: null,
    durationSec: 100,
    format: "flac",
    sampleRate: 44100,
    bitDepth: 16,
    playable: true,
    artKey,
    mtimeMs: null,
    sizeBytes: null,
    addedAtMs: null,
  }) as TrackRow;

/** Faux `window.benten.playlists` en mémoire (même sémantique que le repository). */
export function fakePlaylistsApi() {
  let nextId = 1;
  let clock = 1000;
  const lists = new Map<number, { name: string; createdAt: number; updatedAt: number; ids: number[] }>();
  const playlists = {
    list: vi.fn(async (): Promise<PlaylistRow[]> =>
      [...lists.entries()]
        .map(([id, p]) => ({ id, name: p.name, trackCount: p.ids.length, createdAt: p.createdAt, updatedAt: p.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    ),
    create: vi.fn(async (name: string) => {
      const id = nextId++;
      clock++;
      lists.set(id, { name, createdAt: clock, updatedAt: clock, ids: [] });
      return id;
    }),
    rename: vi.fn(async (id: number, name: string) => {
      lists.get(id)!.name = name;
      lists.get(id)!.updatedAt = ++clock;
    }),
    remove: vi.fn(async (id: number) => {
      lists.delete(id);
    }),
    tracks: vi.fn(async (id: number) => (lists.get(id)?.ids ?? []).map((t) => track(t))),
    add: vi.fn(async (id: number, ids: readonly number[]) => {
      lists.get(id)!.ids.push(...ids);
      lists.get(id)!.updatedAt = ++clock;
    }),
    removeTrack: vi.fn(async (id: number, position: number) => {
      lists.get(id)!.ids.splice(position, 1);
      lists.get(id)!.updatedAt = ++clock;
    }),
    reorder: vi.fn(async (id: number, from: number, to: number) => {
      const ids = lists.get(id)!.ids;
      const [m] = ids.splice(from, 1);
      ids.splice(to, 0, m!);
      lists.get(id)!.updatedAt = ++clock;
    }),
    insertAt: vi.fn(async (id: number, trackId: number, position: number) => {
      const ids = lists.get(id)!.ids;
      ids.splice(Math.min(position, ids.length), 0, trackId);
      lists.get(id)!.updatedAt = ++clock;
    }),
  };
  return { api: { playlists } as unknown as BentenApi, playlists, lists };
}
