import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import { CHANNELS } from "../shared/channels";
import { registerArtProtocol, registerArtScheme, setArtSourceResolver } from "./artprotocol";
import { registerDiagnosticsIpc, registerIpc } from "./ipc";
import { YoutubeManager } from "./youtube/manager";
import { ensureYtDlp, readYtDlpVersion } from "./youtube/ytdlp";
import { attachMainJournal, createJournalWriter, watchWindowJournal, type JournalWriter } from "./journal";
import { enforceSingleInstance, focusWindow, reportFatalStartup } from "./instance";
import { backfillAddedAt } from "./library/addedAt";
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
    // Plancher de mise en page : la barre latérale de 248 px n'écrase jamais le contenu.
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: "Benten",
    // Icône de fenêtre et de barre des tâches (or sur laque, lisible à 16 px).
    icon: join(__dirname, "..", "icon.ico"),
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

  // ── T15 — téléchargeur YouTube → MP3 ────────────────────────────────────────────────────────
  // Sortie : `Musique\Benten\YouTube`, ajoutée comme source pour que la veille indexe le fichier.
  // Le binaire `yt-dlp.exe` vit sous `userData/bin` et n'est téléchargé qu'au premier usage, après
  // vérification de son empreinte. `ffmpeg` : celui du PATH, ou `BENTEN_FFMPEG` s'il est ailleurs.
  const youtubeDir = join(app.getPath("music"), "Benten", "YouTube");
  const ytBin = join(userData, "bin", "yt-dlp.exe");
  const ffmpegPath = process.env.BENTEN_FFMPEG ?? "ffmpeg";
  const youtubeManager = new YoutubeManager({
    binaryPath: ytBin,
    outputDir: youtubeDir,
    ffmpegPath,
    onProgress: (job) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(CHANNELS.YOUTUBE_PROGRESS, job);
    },
    onDone: async (job) => {
      if (!job.filePath) return;
      try {
        await indexOne(db, job.filePath);
        broadcastLibraryChanged();
      } catch (e) {
        journal?.log({ kind: "process", event: "youtube.index-failed", path: job.filePath, message: String(e) });
      }
    },
  });
  // T17 — mode compact : 420×132, toujours au premier plan, non redimensionnable. On mémorise la
  // géométrie d'avant pour la restaurer exactement (taille ET position).
  let compactBefore: {
    bounds: Electron.Rectangle;
    resizable: boolean;
    maximized: boolean;
    minSize: [number, number];
  } | null = null;
  // Ré-extraire une pochette à la demande (cache vidé, première lecture) : on retrouve le fichier
  // par sa clé, sans quoi les pochettes resteraient génératives.
  setArtSourceResolver((artKey) => {
    try {
      const row = db.prepare("SELECT path FROM tracks WHERE art_key = ? LIMIT 1").get(artKey) as
        | { path: string }
        | undefined;
      return row?.path ?? null;
    } catch {
      return null;
    }
  });

  registerIpc(db, {
    setCompact: (on: boolean) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (on && !compactBefore) {
        // Une fenêtre MAXIMISÉE ignore `setBounds` : on la démaximise d'abord (et on le note pour
        // la restaurer, sinon l'utilisateur perd son plein écran en revenant).
        const maximized = win.isMaximized();
        compactBefore = {
          bounds: win.getNormalBounds(),
          resizable: win.isResizable(),
          maximized,
          minSize: win.getMinimumSize() as [number, number],
        };
        if (maximized) win.unmaximize();
        // ORDRE IMPORTANT : sur Windows, `setBounds` est ignoré sur une fenêtre non redimensionnable.
        // On redimensionne donc D'ABORD, puis on verrouille.
        // Le plancher de mise en page (960×620) empêcherait la fenêtre de rétrécir : on le lève.
        win.setMinimumSize(320, 120);
        win.setAlwaysOnTop(true);
        // Hauteur extérieure : barre de titre + facteur d'échelle consomment ~65 px.
        win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: 420, height: 180 });
        win.setResizable(false);
        journal?.log({ kind: "process", event: "compact.on", bounds: win.getBounds(), inner: win.getContentBounds() });
      } else if (!on && compactBefore) {
        const previous = compactBefore;
        compactBefore = null;
        win.setAlwaysOnTop(false);
        win.setResizable(previous.resizable);
        win.setBounds(previous.bounds);
        win.setMinimumSize(previous.minSize[0], previous.minSize[1]);
        if (previous.maximized) win.maximize();
      }
    },
    onSourcesChanged: startWatcher,
    youtube: {
      enqueue: (url: unknown) => youtubeManager.enqueue(String(url ?? "")),
      jobs: () => youtubeManager.jobsList(),
      status: () => ({ installed: existsSync(ytBin), version: null }),
      update: async () => {
        await ensureYtDlp(join(userData, "bin"));
        return { installed: true, version: await readYtDlpVersion(ytBin) };
      },
    },
  });

  const win = createWindow();
  // Sauvegarde de lancement, apres l'affichage de la fenetre (asynchrone, differee) :
  // `userData/db-backups/benten-<horodatage>.db`, sautee si la derniere a moins de 20 h ;
  // retention = 3 plus recentes + une par jour sur 7 jours.
  win.once("show", () => {
    setTimeout(() => {
      void backupDb(db, userData);
    }, BACKUP_DELAY_MS);
  });

  // Rattrapage unique de la date d'ajout (pistes indexées avant la v3) : stats en parallèle, une
  // seule transaction ; la vue Titres se recharge si des dates ont été complétées. Best-effort.
  void backfillAddedAt(db, (path) => fs.stat(path))
    .then((n) => {
      if (n > 0) broadcastLibraryChanged();
    })
    .catch(() => {
      /* la date reste NULL : retentée au prochain démarrage. */
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












