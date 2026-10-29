import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import chokidar from "chokidar";
import { CHANNELS } from "../shared/channels";
import { registerArtProtocol, registerArtScheme } from "./artprotocol";
import { registerIpc } from "./ipc";
import { openDb } from "./library/db";
import { indexOne } from "./library/indexer";
import { getSources, removeTracks } from "./library/repository";
import { createWatcher, type WatchFactory, type WatcherHandle } from "./library/watcher";

// Le schema doit etre declare avant que l'app soit prete.
registerArtScheme();

// Lecteur de musique : la lecture demarre sans geste utilisateur prealable. Sans cela, la
// politique d'autoplay de Chromium laisserait l'AudioContext suspendu et « play » resterait muet.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Harnais de vérification CDP : en dev uniquement, ouvre le port de debogage distant pour que
// `scripts/cdp-smoke.mjs` puisse piloter le vrai renderer. Garde sur ELECTRON_RENDERER_URL afin
// de ne jamais exposer ce port dans un build de production.
if (process.env["ELECTRON_RENDERER_URL"]) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Plancher de mise en page : la barre latérale de 248 px n'écrase jamais le contenu.
    minWidth: 960,
    minHeight: 620,
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
  const db = openDb(join(app.getPath("userData"), "benten.db"));

  // ── Veille de dossiers (Task 14B) ────────────────────────────────────────────────────────────
  // Un seul watcher a la fois, pose sur l'ENSEMBLE des sources persistees. A chaque lot de re-scan
  // incremental, on pousse `library:changed` aux fenetres : le Renderer re-interroge la DB sans
  // jamais toucher au moteur (lecture ininterrompue). Les fichiers restent en LECTURE SEULE — le
  // watcher ne mute que l'index SQLite via `indexOne` / `removeTracks`.
  let watcher: WatcherHandle | null = null;

  const broadcastLibraryChanged = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.LIBRARY_CHANGED);
    }
  };

  const startWatcher = (): void => {
    const roots = getSources(db).map((s) => s.path);
    // Ferme proprement l'ancien watcher (sans bloquer) avant d'en poser un nouveau.
    const previous = watcher;
    watcher = null;
    if (previous) void previous.close();
    if (roots.length === 0) return; // aucune source : rien a surveiller (1er lancement).
    watcher = createWatcher(roots, {
      // On attend l'indexation (pour que le lot soit serialise) et on jette le booleen de retour :
      // l'option attend `Promise<void>`. Une erreur remonte au try/catch par-fichier du watcher.
      indexOne: async (path) => {
        await indexOne(db, path);
      },
      removeOne: (path) => {
        removeTracks(db, [path]);
      },
      onChanged: broadcastLibraryChanged,
      watch: chokidar.watch as unknown as WatchFactory,
    });
  };

  registerIpc(db, { onSourcesChanged: startWatcher });
  createWindow();
  // Demarre la veille sur les sources deja persistees (apres la creation de la fenetre).
  startWatcher();

  // Fermeture propre de la veille a l'arret de l'app.
  app.on("will-quit", () => {
    const previous = watcher;
    watcher = null;
    if (previous) void previous.close();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
