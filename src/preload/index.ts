import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels";
import type { BentenApi } from "../shared/types";

const api: BentenApi = {
  ping: () => ipcRenderer.invoke(CHANNELS.PING),
  library: {
    query: (args) => ipcRenderer.invoke(CHANNELS.LIBRARY_QUERY, args),
    scan: (paths) => ipcRenderer.invoke(CHANNELS.LIBRARY_SCAN, paths),
  },
  audio: {
    defaultDevice: () => ipcRenderer.invoke(CHANNELS.AUDIO_DEFAULT_DEVICE),
  },
};

contextBridge.exposeInMainWorld("benten", api);
