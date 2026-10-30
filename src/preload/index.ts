import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type ChannelName } from "../shared/channels";
import type { BentenApi } from "../shared/types";

/** `ipcRenderer.invoke` type : le type de retour vient de la signature de `BentenApi`. */
const invoke = <T>(channel: ChannelName, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: BentenApi = {
  ping: () => invoke(CHANNELS.PING),
  library: {
    query: (args) => invoke(CHANNELS.LIBRARY_QUERY, args),
    scan: (paths) => invoke(CHANNELS.LIBRARY_SCAN, paths),
    search: (args) => invoke(CHANNELS.LIBRARY_SEARCH, args),
    tracksByIds: (ids) => invoke(CHANNELS.LIBRARY_TRACKS_BY_IDS, ids),
  },
  audio: {
    defaultDevice: () => invoke(CHANNELS.AUDIO_DEFAULT_DEVICE),
    listDevices: () => invoke(CHANNELS.AUDIO_LIST_DEVICES),
    readFile: (path) => invoke(CHANNELS.AUDIO_READ_FILE, path),
  },
  dialog: {
    pickFolder: () => invoke(CHANNELS.DIALOG_PICK_FOLDER),
  },
  sources: {
    list: () => invoke(CHANNELS.SOURCES_LIST),
    remove: (id) => invoke(CHANNELS.SOURCES_REMOVE, id),
  },
  favorites: {
    toggle: (trackId, on) => invoke(CHANNELS.FAVORITES_TOGGLE, trackId, on),
    list: () => invoke(CHANNELS.FAVORITES_LIST),
  },
  playlists: {
    list: () => invoke(CHANNELS.PLAYLISTS_LIST),
    create: (name) => invoke(CHANNELS.PLAYLISTS_CREATE, name),
    rename: (id, name) => invoke(CHANNELS.PLAYLISTS_RENAME, id, name),
    remove: (id) => invoke(CHANNELS.PLAYLISTS_DELETE, id),
    tracks: (id) => invoke(CHANNELS.PLAYLISTS_TRACKS, id),
    add: (id, trackIds) => invoke(CHANNELS.PLAYLISTS_ADD, id, trackIds),
    removeTrack: (id, position) => invoke(CHANNELS.PLAYLISTS_REMOVE, id, position),
    reorder: (id, from, to) => invoke(CHANNELS.PLAYLISTS_REORDER, id, from, to),
    insertAt: (id, trackId, position) => invoke(CHANNELS.PLAYLISTS_INSERT_AT, id, trackId, position),
  },
  state: {
    get: (key) => invoke(CHANNELS.STATE_GET, key),
    set: (key, value) => invoke(CHANNELS.STATE_SET, key, value),
  },
  diagnostics: {
    append: (entries) => invoke(CHANNELS.DIAGNOSTICS_APPEND, entries),
  },
  // Abonnement au push « library:changed » (Task 14B). On enveloppe un listener qui ignore les
  // arguments IPC (event/payload) et n'expose au Renderer qu'un callback sans argument. La valeur
  // de retour est une fonction de desabonnement (retire le listener).
  apple: {
    status: () => invoke(CHANNELS.APPLE_STATUS),
    saveCookies: (text) => invoke(CHANNELS.APPLE_SAVE_COOKIES, text),
    preview: (url) => invoke(CHANNELS.APPLE_PREVIEW, url),
    start: (urls) => invoke(CHANNELS.APPLE_START, urls),
    cancel: () => invoke(CHANNELS.APPLE_CANCEL),
    onProgress: (cb) => {
      const listener = (_e: unknown, progress: Parameters<typeof cb>[0]): void => cb(progress);
      ipcRenderer.on(CHANNELS.APPLE_PROGRESS, listener);
      return () => {
        ipcRenderer.removeListener(CHANNELS.APPLE_PROGRESS, listener);
      };
    },
  },
  window: {
    setCompact: (on) => invoke(CHANNELS.WINDOW_SET_COMPACT, on),
  },
  importer: {
    pickFile: () => invoke(CHANNELS.DIALOG_PICK_FILE),
    preview: (path) => invoke(CHANNELS.IMPORT_PREVIEW, path),
    commit: (args) => invoke(CHANNELS.IMPORT_COMMIT, args),
  },
  youtube: {
    enqueue: (url) => invoke(CHANNELS.YOUTUBE_ENQUEUE, url),
    jobs: () => invoke(CHANNELS.YOUTUBE_JOBS),
    status: () => invoke(CHANNELS.YOUTUBE_STATUS),
    update: () => invoke(CHANNELS.YOUTUBE_UPDATE),
    playlistPreview: (url) => invoke(CHANNELS.YOUTUBE_PLAYLIST_PREVIEW, url),
    playlistStart: (urls) => invoke(CHANNELS.YOUTUBE_PLAYLIST_START, urls),
    onProgress: (cb) => {
      const listener = (_e: unknown, job: Parameters<typeof cb>[0]): void => cb(job);
      ipcRenderer.on(CHANNELS.YOUTUBE_PROGRESS, listener);
      return () => {
        ipcRenderer.removeListener(CHANNELS.YOUTUBE_PROGRESS, listener);
      };
    },
  },  onLibraryChanged: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on(CHANNELS.LIBRARY_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.LIBRARY_CHANGED, listener);
    };
  },
};

contextBridge.exposeInMainWorld("benten", api);





