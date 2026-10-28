import { ipcMain } from "electron";
import { CHANNELS } from "../shared/channels";

/** Enregistre les handlers IPC du process Main. library:* et audio:* arrivent avec leurs tâches. */
export function registerIpc(): void {
  ipcMain.handle(CHANNELS.PING, (): "pong" => "pong");
}
