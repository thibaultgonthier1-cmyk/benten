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
  },
  audio: {
    defaultDevice: () => invoke(CHANNELS.AUDIO_DEFAULT_DEVICE),
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
};

contextBridge.exposeInMainWorld("benten", api);
