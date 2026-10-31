/**
 * Benten Mobile — lecteur autonome pour iPhone, à la DA du bureau.
 *
 * PRINCIPES
 * - Rien n'échoue en silence : chaque erreur s'affiche dans la ligne d'état.
 * - Aucun `await` de premier niveau : le démarrage est une fonction attrapée.
 * - Les morceaux vivent sur le téléphone (IndexedDB), ou en mémoire si le stockage est refusé.
 *
 * LIMITES iOS (structurelles)
 * - pas de parcours de dossier : import par le sélecteur Fichiers ;
 * - pas de téléchargement autonome : le PC sert la source (voir Synchronisation).
 */

const DB_NAME = "benten-mobile";
const DB_STORE = "tracks";
const DB_VERSION = 1;
const VERSION = "1.3.0"; // affichée dans les réglages : permet de vérifier la version installée

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const library = $("library");
const stage = $("stage");
const titleEl = $("title");
const artistEl = $("artist");
const coverEl = $("cover");
const coverText = $("coverText");
const seekEl = $("seek");
const curEl = $("t-cur");
const durEl = $("t-dur");
const toggleBtn = $("toggle");
const nextBtn = $("next");
const prevBtn = $("prev");
const filesInput = $("files");
const statusEl = $("status");
const sheet = $("sheet");
const syncInfo = $("syncInfo");
const sheetInfo = $("sheetInfo");

let tracks = [];
let currentIndex = -1;
let objectUrl = null;
let persistent = false;
let dbPromise = null;
let repeatMode = "all";
let shuffle = false;
let playOrder = [];

/* ------------------------------- Messages ------------------------------- */

function say(message, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function fail(where, error) {
  const message = error && error.message ? error.message : String(error);
  console.error(`[benten] ${where}`, error);
  say(`${where} : ${message}`, "error");
}

/* ------------------------------- Stockage ------------------------------- */

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("stockage local indisponible (navigation privée ?)"));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("ouverture impossible"));
  });
  return dbPromise;
}

async function loadTracks() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.addedAt - b.addedAt));
    request.onerror = () => reject(request.error);
  });
}

async function saveTrack(track) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(track);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------- Affichage ------------------------------- */

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function splitName(name) {
  const clean = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const parts = clean.split(" - ");
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { artist: "Fichier importé", title: clean };
}

/** Teinte stable dérivée du titre : chaque morceau a sa pochette, sans image à charger. */
function tintFor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${hash} 42% 62%), hsl(${(hash + 28) % 360} 38% 44%))`;
}

function render() {
  if (tracks.length === 0) {
    library.innerHTML =
      '<p class="empty">Aucune musique sur cet appareil.<br />Touche <b>importer</b>, ou synchronise avec le PC (⚙).</p>';
    return;
  }
  library.innerHTML = "";
  tracks.forEach((track, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track" + (index === currentIndex ? " is-playing" : "");
    const art = document.createElement("span");
    art.className = "track__art";
    art.style.background = tintFor(track.title);
    art.textContent = index === currentIndex ? "♪" : String(index + 1);
    const text = document.createElement("span");
    text.className = "track__text";
    const title = document.createElement("span");
    title.className = "track__title";
    title.textContent = track.title;
    const artist = document.createElement("span");
    artist.className = "track__artist";
    artist.textContent = track.artist;
    text.append(title, artist);
    const time = document.createElement("span");
    time.className = "track__time";
    time.textContent = formatTime(track.durationSec ?? NaN);
    button.append(art, text, time);
    button.addEventListener("click", () => play(index));
    library.appendChild(button);
  });
}

function showView(name) {
  library.hidden = name !== "library";
  stage.hidden = name !== "playing";
  for (const button of document.querySelectorAll(".tabs button")) {
    button.setAttribute("aria-pressed", String(button.dataset.tab === name));
  }
}

function paintStage(track) {
  if (!track) return;
  titleEl.textContent = track.title;
  artistEl.textContent = track.artist;
  coverEl.style.background = tintFor(track.title);
  coverText.textContent = (track.title[0] ?? "♪").toUpperCase();
}

/* -------------------------------- Lecture -------------------------------- */

function play(index) {
  const track = tracks[index];
  if (!track) return;
  currentIndex = index;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(track.blob);
  audio.src = objectUrl;
  paintStage(track);
  showView("playing");
  audio.play().catch((error) => fail("lecture refusée", error));
  render();
}

function buildOrder() {
  const indices = tracks.map((_, i) => i);
  if (!shuffle) {
    playOrder = indices;
    return;
  }
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  if (currentIndex >= 0) {
    const at = indices.indexOf(currentIndex);
    if (at > 0) [indices[0], indices[at]] = [indices[at], indices[0]];
  }
  playOrder = indices;
}

function nextIndex(delta) {
  if (tracks.length === 0) return null;
  if (repeatMode === "one" && delta > 0 && currentIndex >= 0) return currentIndex;
  const order = playOrder.length === tracks.length ? playOrder : tracks.map((_, i) => i);
  const position = order.indexOf(currentIndex);
  const target = position + delta;
  if (target >= 0 && target < order.length) return order[target];
  if (repeatMode === "off") return null;
  if (shuffle) buildOrder();
  const wrapped = ((target % order.length) + order.length) % order.length;
  return order[wrapped] ?? null;
}

function step(delta) {
  const index = nextIndex(delta);
  if (index === null) {
    audio.pause();
    say("fin de la liste");
    return;
  }
  play(index);
}

/* -------------------------------- Événements -------------------------------- */

filesInput.addEventListener("change", async () => {
  const files = [...(filesInput.files ?? [])];
  filesInput.value = "";
  if (files.length === 0) return;
  say(`import de ${files.length} fichier(s)…`);
  for (const file of files) {
    const { artist, title } = splitName(file.name);
    const record = {
      id: `${file.name}:${file.size}:${file.lastModified}`,
      title,
      artist,
      blob: file,
      addedAt: Date.now(),
    };
    try {
      if (persistent) await saveTrack(record);
    } catch (error) {
      persistent = false;
      fail("enregistrement", error);
    }
    tracks = [...tracks.filter((item) => item.id !== record.id), record];
  }
  buildOrder();
  render();
  say(
    persistent
      ? `${tracks.length} morceau(x) sur l'appareil`
      : `${tracks.length} morceau(x) — session seulement (stockage indisponible)`,
    persistent ? "info" : "error",
  );
});

toggleBtn.addEventListener("click", () => {
  if (audio.paused) audio.play().catch((error) => fail("lecture refusée", error));
  else audio.pause();
});
nextBtn.addEventListener("click", () => step(1));
prevBtn.addEventListener("click", () => step(-1));

audio.addEventListener("play", () => {
  toggleBtn.textContent = "❚❚";
  toggleBtn.setAttribute("aria-label", "Pause");
  stage.classList.add("is-playing");
});
audio.addEventListener("pause", () => {
  toggleBtn.textContent = "▶";
  toggleBtn.setAttribute("aria-label", "Lecture");
  stage.classList.remove("is-playing");
});
audio.addEventListener("loadedmetadata", () => {
  durEl.textContent = formatTime(audio.duration);
});
audio.addEventListener("timeupdate", () => {
  curEl.textContent = formatTime(audio.currentTime);
  const ratio = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  seekEl.value = String(Math.round(ratio * 1000));
});
audio.addEventListener("error", () => fail("audio", audio.error ?? new Error("format illisible")));
audio.addEventListener("ended", () => step(1));

seekEl.addEventListener("input", () => {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = (Number(seekEl.value) / 1000) * audio.duration;
});

for (const button of document.querySelectorAll(".tabs button")) {
  button.addEventListener("click", () => {
    if (button.dataset.tab === "playing" && currentIndex < 0) {
      say("aucun morceau en lecture");
      return;
    }
    showView(button.dataset.tab);
  });
}

/* ------------------------------ Réglages ------------------------------ */

const SYNC_KEY = "benten-sync";
const syncHost = $("syncHost");
const syncToken = $("syncToken");
const syncLimit = $("syncLimit");
const syncRun = $("syncRun");
const syncTest = $("syncTest");

function syncSettings() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSyncSettings(host, token, limit) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ host, token, limit }));
  } catch (error) {
    console.warn("[benten] réglages de synchro non enregistrés", error);
  }
}

function refreshSheet() {
  if (!sheet) return;
  for (const button of sheet.querySelectorAll("[data-repeat]")) {
    button.setAttribute("aria-pressed", String(button.dataset.repeat === repeatMode));
  }
  const shuffleBtn = $("shuffle");
  if (shuffleBtn) shuffleBtn.setAttribute("aria-pressed", String(shuffle));
  if (sheetInfo) {
    sheetInfo.textContent = `v${VERSION} · ${tracks.length} morceau(x) · stockage ${
      persistent ? "sur l'appareil" : "en mémoire"
    }`;
  }
}

function openSheet() {
  if (!sheet) return;
  refreshSheet();
  sheet.hidden = false;
}
function closeSheet() {
  if (sheet) sheet.hidden = true;
}

function syncTargets() {
  const host = (syncHost?.value ?? "").trim().replace(/\/+$/, "");
  const token = (syncToken?.value ?? "").trim();
  return { host, token };
}

$("settingsOpen")?.addEventListener("click", openSheet);
$("sheetClose")?.addEventListener("click", closeSheet);
sheet?.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});

for (const button of sheet?.querySelectorAll("[data-repeat]") ?? []) {
  button.addEventListener("click", () => {
    repeatMode = button.dataset.repeat ?? "all";
    refreshSheet();
  });
}

$("shuffle")?.addEventListener("click", () => {
  shuffle = !shuffle;
  buildOrder();
  refreshSheet();
});

$("clear")?.addEventListener("click", async () => {
  tracks = [];
  currentIndex = -1;
  audio.pause();
  audio.removeAttribute("src");
  if (persistent) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const request = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      fail("vidage", error);
    }
  }
  render();
  refreshSheet();
  say("bibliothèque vidée");
});

/** Test de connexion : affiche le code HTTP ou l'erreur exacte, sans rien télécharger. */
syncTest?.addEventListener("click", () => {
  void (async () => {
    const { host, token } = syncTargets();
    try {
      if (!host) throw new Error("adresse vide");
      if (!token) throw new Error("jeton vide");
      syncInfo.textContent = "test en cours…";
      const response = await fetch(`${host}/api/library?token=${encodeURIComponent(token)}`);
      if (response.status === 403) throw new Error("jeton refusé par le PC (403)");
      if (!response.ok) throw new Error(`le PC a répondu ${response.status}`);
      const payload = await response.json();
      const count = Array.isArray(payload.tracks) ? payload.tracks.length : 0;
      syncInfo.textContent = `connexion OK — ${count} morceau(x) sur le PC`;
    } catch (error) {
      syncInfo.textContent = `échec : ${error instanceof Error ? error.message : String(error)}`;
    }
  })();
});

syncRun?.addEventListener("click", () => {
  void (async () => {
    try {
      const { host, token } = syncTargets();
      if (!host || !token) {
        syncInfo.textContent = "adresse et jeton obligatoires";
        say("renseigne l'adresse ET le jeton du PC", "error");
        return;
      }
      const rawLimit = Number(syncLimit?.value);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(5000, Math.floor(rawLimit)) : 5000;
      saveSyncSettings(host, token, limit);
      if (syncRun) syncRun.disabled = true;
      syncInfo.textContent = "récupération de la liste…";
      const response = await fetch(`${host}/api/library?token=${encodeURIComponent(token)}`);
      if (!response.ok) throw new Error(`le PC a répondu ${response.status}`);
      const payload = await response.json();
      const remote = Array.isArray(payload.tracks) ? payload.tracks : [];
      const known = new Set(tracks.map((track) => track.id));
      const missingAll = remote.filter((item) => !known.has(`pc:${item.id}`));
      const missing = missingAll.slice(0, limit);
      const planned = missing.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
      syncInfo.textContent = `${missing.length} à récupérer (~${(planned / 1048576).toFixed(0)} Mo) sur ${missingAll.length}`;
      let added = 0;
      for (const item of missing) {
        const audioResponse = await fetch(`${host}${item.audio}`);
        if (!audioResponse.ok) continue;
        const blob = await audioResponse.blob();
        const record = {
          id: `pc:${item.id}`,
          title: item.title,
          artist: item.artist,
          blob,
          addedAt: Date.now(),
          durationSec: item.durationSec,
        };
        try {
          if (persistent) await saveTrack(record);
        } catch (error) {
          persistent = false;
          fail("enregistrement", error);
        }
        tracks = [...tracks.filter((track) => track.id !== record.id), record];
        added += 1;
        syncInfo.textContent = `${added}/${missing.length} récupéré(s)…`;
      }
      buildOrder();
      render();
      refreshSheet();
      syncInfo.textContent = `${added} morceau(x) récupéré(s)`;
      say(added === 0 ? "rien de nouveau sur le PC" : `${added} morceau(x) récupéré(s)`);
    } catch (error) {
      syncInfo.textContent = `échec : ${error instanceof Error ? error.message : String(error)}`;
      fail("synchronisation", error);
    } finally {
      if (syncRun) syncRun.disabled = false;
    }
  })();
});

/* ------------------------------ Démarrage ------------------------------ */

async function start() {
  render();
  say("prêt");
  const saved = syncSettings();
  if (saved.host && syncHost) syncHost.value = saved.host;
  if (saved.token && syncToken) syncToken.value = saved.token;
  if (saved.limit && syncLimit) syncLimit.value = String(saved.limit);
  showView("library");
  try {
    tracks = await loadTracks();
    persistent = true;
    buildOrder();
    render();
    say(tracks.length === 0 ? `prêt — v${VERSION}` : `${tracks.length} morceau(x) · v${VERSION}`);
  } catch (error) {
    persistent = false;
    fail("stockage local", error);
    say("stockage indisponible — import possible, mais perdu à la fermeture", "error");
  }
  // Service worker : uniquement dans la PWA (page servie par le PC). Dans l'app native
  // (Capacitor, protocole `capacitor:`), les fichiers sont déjà embarqués : un service worker
  // n'y apporte rien et peut servir une ANCIENNE version — c'est exactement le piège qui a
  // rendu l'app muette après une mise à jour.
  const isNativeShell = location.protocol === "capacitor:" || typeof window.Capacitor !== "undefined";
  if ("serviceWorker" in navigator && !isNativeShell) {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("[benten] service worker non enregistré", error);
    });
  }
}

start().catch((error) => fail("démarrage", error));

