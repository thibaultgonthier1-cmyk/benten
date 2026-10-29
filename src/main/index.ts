import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { join } from "node:path";
import chokidar from "chokidar";
import { CHANNELS } from "../shared/channels";
import { registerArtProtocol, registerArtScheme } from "./artprotocol";
import { registerDiagnosticsIpc, registerIpc } from "./ipc";
import { attachMainJournal, createJournalWriter, watchWindowJournal, type JournalWriter } from "./journal";
import { enforceSingleInstance, focusWindow, reportFatalStartup } from "./instance";
import { backupDb, openDbSafe, wireDbClose } from "./library/dbsafety";
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

/** Journal audio (cree a `whenReady`, une fois `userData` connu). */
let journal: JournalWriter | null = null;
/** Fenetre principale (ramenee au premier plan sur un second lancement). */
let mainWindow: BrowserWindow | null = null;

// ── Instance unique ──────────────────────────────────────────────────────────────────────────
// La build de dev (`benten`) et l'exe (`Benten`) partagent le meme %APPDATA% sous Windows : deux
// processus ecrivant la meme base SQLite est une cause plausible de corruption. Un second
// lancement rend la main a la fenetre existante et quitte SANS jamais ouvrir la base.
const isPrimaryInstance = enforceSingleInstance(app, () => {
  void journal?.log({ kind: "process", event: "second-instance" });
  focusWindow(mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0]);
});

function createWindow(): BrowserWindow {
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
  // Journal audio : fenetre bloquee / debloquee (thread principal du renderer).
  const j = journal;
  if (j) watchWindowJournal(win, (e) => j.log(e));

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow = win;
  return win;
}

/** Delai apres l'affichage de la fenetre avant la sauvegarde de la base (demarrage jamais ralenti). */
const BACKUP_DELAY_MS = 5000;

app.whenReady().then(() => {
  // Seconde instance : `app.quit()` est deja demande ; elle n'ouvre NI la base NI de fenetre.
  if (!isPrimaryInstance) return;
  registerArtProtocol();
  const userData = app.getPath("userData");

  // ── Journal audio (diagnostic des micro-coupures) ──────────────────────────────────────────
  // `userData/logs/audio-journal.log` (+ un seul ancien `.1.log` apres 1 Mo). Le Renderer y
  // ajoute ses entrees via `diagnostics:append` ; le Main y consigne lui-meme les evenements
  // processus (service audio Chromium, renderer, fenetre, veille/reprise, recuperation de base).
  // Cree AVANT l'ouverture de la base pour qu'une recuperation y soit consignee.
  const j = createJournalWriter(join(userData, "logs"));
  journal = j;
  registerDiagnosticsIpc(j, {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  });
  attachMainJournal({ app, powerMonitor, log: (e) => j.log(e) });

  // ── Base de bibliotheque crash-safe ────────────────────────────────────────────────────────
  // Copie pre-ouverture apres arret non propre ; ouverture verifiee (quick_check) ; corruption
  // averee -> copie verifiee dans `db-corrupted-<horodatage>/`, restauration de la derniere
  // sauvegarde saine (ou base neuve), `app_state.dbRecovered`, entree de journal. L'app demarre
  // normalement : la veille re-indexe. Echec irrecuperable -> message clair puis sortie (exit 1).
  let opened: ReturnType<typeof openDbSafe>["db"];
  try {
    opened = openDbSafe(userData, { log: (e) => j.log(e) }).db;
  } catch (err) {
    // Synchrone : la ligne est sur disque AVANT `app.exit(1)` (pas de perte en vol).
    j.logSync({
      kind: "process",
      event: "db",
      action: "fatal",
      reason: err instanceof Error ? err.message : String(err),
    });
    reportFatalStartup({ app, dialog }, err, j.file);
    return;
  }
  const db = opened;

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

  const win = createWindow();
  // Sauvegarde de lancement, apres l'affichage de la fenetre (asynchrone, differee) :
  // `userData/db-backups/benten-<horodatage>.db`, sautee si la derniere a moins de 20 h ;
  // retention = 3 plus recentes + une par jour sur 7 jours.
  win.once("show", () => {
    setTimeout(() => {
      void backupDb(db, userData);
    }, BACKUP_DELAY_MS);
  });
  // Demarre la veille sur les sources deja persistees (apres la creation de la fenetre).
  startWatcher();

  // Fermeture propre de la veille a l'arret de l'app.
  app.on("will-quit", () => {
    const previous = watcher;
    watcher = null;
    if (previous) void previous.close();
  });
  // Puis fermeture ORDONNEE de la base (checkpoint WAL final propre) sur `will-quit` — enregistree
  // APRES la veille pour que celle-ci soit arretee d'abord — ou sur `session-end` (Windows).
  wireDbClose(app, db);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
