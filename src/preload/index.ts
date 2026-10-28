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
  },
  audio: {
    defaultDevice: () => invoke(CHANNELS.AUDIO_DEFAULT_DEVICE),
  },
};

contextBridge.exposeInMainWorld("benten", api);
