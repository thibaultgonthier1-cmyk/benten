import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { existsSync, mkdirSync, promises as fs, readdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import chokidar from "chokidar";
import { CHANNELS } from "../shared/channels";
import { registerArtProtocol, registerArtScheme, setArtSourceResolver } from "./artprotocol";
import { registerDiagnosticsIpc, registerIpc } from "./ipc";
import { YoutubeManager } from "./youtube/manager";
import { AppleRunner, resolveCollection } from "./apple/index";
import { existingCookiesPath, saveCookies, cookiesStatus, saveCookieFile, existingCookieFile } from "./apple/cookies";
import { matchTracks } from "./importer/matcher";
import { queryLibrary } from "./ipc";
import { ensureYtDlp, readYtDlpVersion } from "./youtube/ytdlp";
import { parseYoutubePlaylistUrl, resolveYoutubePlaylist } from "./youtube/playlist";
import { cookieArgs, readCookieSource, writeCookieSource } from "./youtube/cookieSource";
import { attachMainJournal, createJournalWriter, watchWindowJournal, type JournalWriter } from "./journal";
import { enforceSingleInstance, focusWindow, reportFatalStartup } from "./instance";
import { backfillAddedAt } from "./library/addedAt";
import { addSource } from "./library/repository";
import { indexLibrary } from "./library/indexer";
import { backupDb, openDbSafe, wireDbClose } from "./library/dbsafety";
import { indexOne } from "./library/indexer";
import { getSources, removeTracks } from "./library/repository";
import { createWatcher, type WatchFactory, type WatcherHandle } from "./library/watcher";

// Le schema doit etre declare avant que l'app soit prete.
registerArtScheme();

// Lecteur de musique : la lecture demarre sans geste utilisateur prealable. Sans cela, la
// politique d'autoplay de Chromium laisserait l'AudioContext suspendu et « play » resterait muet.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// App mobile : un petit serveur local sert la page installable sur l'iPhone.
import { bindMobileLibrary, mobileUrl, startMobileServer, stopMobileServer } from "./mobileServer";
import { ensureMobileToken, mobileToken, setMobileToken } from "./library/mobileToken";

// Identité Windows : sans ça, la barre des tâches regroupe l'app sous « Electron » et
// certaines fonctions (notifications, épinglage) l'attribuent au mauvais programme.
app.setAppUserModelId("com.benten.player");
startMobileServer();
setMobileToken(ensureMobileToken(app.getPath("userData")));
app.on("before-quit", () => stopMobileServer());

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
  // ffmpeg : on résout un VRAI chemin (variable d''environnement, sinon `where`). S''il reste
  // inconnu, on n''impose rien à yt-dlp : il le trouvera dans le PATH. Passer le mot « ffmpeg »
  // comme chemin laissait des .webm non convertis.
  const ffmpegPath = (() => {
    const explicit = process.env.BENTEN_FFMPEG;
    if (explicit && existsSync(explicit)) return explicit;
    try {
      const found = execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8", timeout: 8000 })
        .split(/\r?\n/)[0]
        ?.trim();
      return found && existsSync(found) ? found : null;
    } catch {
      return null;
    }
  })();
  journal?.log({ kind: "process", event: "youtube.ffmpeg", path: ffmpegPath });

  // Runtime JS pour yt-dlp : node, s'il est installé. Sans lui, chaque titre porte
  // « No supported JavaScript runtime could be found » et certains formats sont limités.
  const jsRuntimePath = (() => {
    try {
      const found = execFileSync("where.exe", ["node"], { encoding: "utf8", timeout: 8000 })
        .split(/\r?\n/)[0]
        ?.trim();
      return found && existsSync(found) ? found : null;
    } catch {
      return null;
    }
  })();
  const youtubeManager = new YoutubeManager({
    binaryPath: ytBin,
    outputDir: youtubeDir,
    ffmpegPath,
    jsRuntimePath,
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

  // ── Apple Music : cookies, aperçu, téléchargement ───────────────────────────────────────────
  // Sortie : `Musique\Benten\Apple`, indexée après coup par la veille. `gamdl` est un outil
  // externe lancé en local ; les cookies restent dans le dossier de données de l'app.
  const appleDir = join(app.getPath("music"), "Benten", "Apple");
  let appleRunner: AppleRunner | null = null;

  const appleStatus = async (): Promise<{
    cookies: boolean;
    cookiesUpdatedAt: number | null;
    cookieEntries: number;
    gamdl: boolean;
    gamdlVersion: string | null;
  }> => {
    const status = await cookiesStatus(userData);
    const gamdlVersion = await new Promise<string | null>((resolve) => {
      execFile("gamdl", ["--version"], { timeout: 10_000 }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? "").trim().split(/\r?\n/)[0] || null);
      });
    });
    return {
      cookies: status.present,
      cookiesUpdatedAt: status.updatedAt,
      cookieEntries: status.entries,
      gamdl: gamdlVersion !== null,
      gamdlVersion,
    };
  };

  const applePreview = async (url: string) => {
    const collection = await resolveCollection(url);
    if (!collection.ok) {
      return { ok: false, name: "", reason: collection.reason, total: 0, missing: 0, items: [] };
    }
    const library = queryLibrary(db, { view: "tracks", limit: 20000 });
    const imported = collection.tracks.map((track) => ({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSec: track.duration,
    }));
    const matched = matchTracks(imported, library.rows as never);
    const items = collection.tracks.map((track, index) => ({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      url: track.url,
      inLibrary: Boolean(matched[index]?.track),
      matchedTrackId: matched[index]?.track?.id ?? null,
    }));
    return {
      ok: true,
      name: collection.playlistName,
      reason: "",
      total: items.length,
      missing: items.filter((item) => !item.inLibrary).length,
      items,
    };
  };

  const appleStart = async (urls: readonly string[]) => {
    const cookies = existingCookiesPath(userData);
    if (!cookies) throw new Error("cookies.txt manquant — colle ton export Apple Music d'abord.");
    mkdirSync(appleDir, { recursive: true });
    appleRunner?.cancel();
    appleRunner = new AppleRunner({
      cookiesPath: cookies,
      outputPath: appleDir,
      databasePath: join(userData, "gamdl.db"),
      workers: 3,
      onProgress: (progress) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send(CHANNELS.APPLE_PROGRESS, progress);
      },
    });
    const result = await appleRunner.start(urls);
    // Indexation de ce qui vient d'arriver (la veille ne couvre pas ce dossier).
    try {
      for (const name of readdirSync(appleDir)) {
        if (!/\.(flac|m4a|mp3|aac|wav)$/i.test(name)) continue;
        await indexOne(db, join(appleDir, name));
      }
      broadcastLibraryChanged();
    } catch (error) {
      journal?.log({ kind: "process", event: "apple.index-failed", message: String(error) });
    }
    return result;
  };
  const youtubePlaylistPreview = async (rawUrl: string) => {
    const link = parseYoutubePlaylistUrl(rawUrl);
    if (!link) {
      return { ok: false, name: "", reason: "Ce lien n'est pas une playlist YouTube.", total: 0, missing: 0, items: [] };
    }
    if (!existsSync(ytBin)) await ensureYtDlp(join(userData, "bin"));
    const source = await readCookieSource(userData);
    const tracks = await resolveYoutubePlaylist(ytBin, link.url, {
      cookieArgs: cookieArgs(source, existingCookieFile(userData, "youtube-cookies.txt")),
    });
    const library = queryLibrary(db, { view: "tracks", limit: 20000 });
    const matched = matchTracks(
      tracks.map((track) => ({ title: track.title, artist: track.artist, durationSec: track.duration || undefined })),
      library.rows as never,
    );
    const items = tracks.map((track, index) => ({
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      url: track.url,
      inLibrary: Boolean(matched[index]?.track),
      matchedTrackId: matched[index]?.track?.id ?? null,
    }));
    return {
      ok: true,
      name: "",
      reason: "",
      total: items.length,
      missing: items.filter((item) => !item.inLibrary).length,
      items,
    };
  };

  const youtubePlaylistStart = async (urls: readonly string[]) => {
    if (!existsSync(ytBin)) await ensureYtDlp(join(userData, "bin"));
    let queued = 0;
    for (const url of urls) {
      if (youtubeManager.enqueue(url)) queued += 1;
    }
    return { queued };
  };
  // Les dossiers de téléchargement sont des SOURCES de la bibliothèque : sans cela, un fichier
  // téléchargé n''apparaît jamais (seul l''indexage à l''unité le faisait, et il échoue sur les
  // formats non convertis). Comme sources, la veille les prend en compte, y compris après un
  // redémarrage — c''est ce qui manquait pour que la playlist se remplisse « en direct ».
  for (const folder of [youtubeDir, appleDir]) {
    try {
      mkdirSync(folder, { recursive: true });
      const known = getSources(db).some((source) => source.path === folder);
      if (!known) addSource(db, folder);
    } catch (error) {
      journal?.log({ kind: "process", event: "sources.add-failed", folder, message: String(error) });
    }
  }

  // Synchronisation téléphone : le serveur mobile lit la bibliothèque par cette fonction.
  bindMobileLibrary({
    list: () =>
      db
        .prepare("select id, title, artist, album, duration_sec as durationSec, size_bytes as sizeBytes, added_at_ms as addedAt, path from tracks where playable = 1 order by added_at_ms desc")
        .all()
        .map((raw) => {
          const row = raw as {
            id: number;
            title: string;
            artist: string;
            album: string;
            durationSec: number;
            sizeBytes: number | null;
            addedAt: number | null;
            path: string;
          };
          return {
            id: row.id,
            title: row.title,
            artist: row.artist,
            album: row.album,
            durationSec: row.durationSec,
            sizeBytes: row.sizeBytes ?? null,
            addedAt: row.addedAt ?? null,
            path: row.path,
          };
        }),
  });

  registerIpc(db, {
    mobileUrl: () => mobileUrl(),
    mobileToken: () => mobileToken(),
    apple: {
      status: appleStatus,
      saveCookies: (text: string) => saveCookies(userData, text).then(() => appleStatus()),
      preview: applePreview,
      start: appleStart,
      cancel: async () => {
        appleRunner?.cancel();
      },
    },
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
      playlistPreview: youtubePlaylistPreview,
      playlistStart: youtubePlaylistStart,
      saveCookies: async (text: string) => {
        const entries = await saveCookieFile(userData, "youtube-cookies.txt", text);
        // Enregistrer un fichier bascule la source en mode « fichier » : c'est ce que vient de faire l'utilisateur.
        await writeCookieSource(userData, { mode: "file" });
        return { entries };
      },
      cookieSource: async () => ({
        ...(await readCookieSource(userData)),
        file: Boolean(existingCookieFile(userData, "youtube-cookies.txt")),
      }),
      setCookieSource: async (value: unknown) => writeCookieSource(userData, value),
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

  // Rattrapage au démarrage : la veille a `ignoreInitial: true`, donc les fichiers arrivés pendant
  // que l'app était fermée (téléchargements terminés la nuit, dossier copié à la main…) ne sont
  // JAMAIS vus. On scanne une fois, en arrière-plan, après un court délai pour ne pas retarder
  // l'affichage de la fenêtre.
  setTimeout(() => {
    const roots = getSources(db).map((source) => source.path);
    if (roots.length === 0) return;
    journal?.log({ kind: "process", event: "library.startup-scan", sources: roots.length });
    void indexLibrary(db, roots)
      .then((result) => {
        if (result.added > 0) broadcastLibraryChanged();
        journal?.log({ kind: "process", event: "library.startup-scan-done", added: result.added, skipped: result.skipped });
      })
      .catch((error: unknown) => {
        journal?.log({ kind: "process", event: "library.startup-scan-failed", message: String(error) });
      });
  }, 4000);

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

































