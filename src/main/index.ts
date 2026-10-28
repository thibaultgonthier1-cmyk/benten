import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerArtProtocol, registerArtScheme } from "./artprotocol";
import { registerIpc } from "./ipc";
import { openDb } from "./library/db";

// Le schema doit etre declare avant que l'app soit prete.
registerArtScheme();

// Lecteur de musique : la lecture demarre sans geste utilisateur prealable. Sans cela, la
// politique d'autoplay de Chromium laisserait l'AudioContext suspendu et « play » resterait muet.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: "Benten",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Le transport est pompe par une boucle requestAnimationFrame (engine.tick()) ; Chromium
      // etrangle les timers/rAF des fenetres cachees/minimisees, ce qui stopperait le
      // prechargement et la programmation gapless (trou audible pendant une minimisation). On
      // desactive cet etranglement pour garantir un enchainement sans silence en arriere-plan.
      backgroundThrottling: false,
    },
  });

  win.on("ready-to-show", () => win.show());

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerArtProtocol();
  registerIpc(openDb(join(app.getPath("userData"), "benten.db")));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
