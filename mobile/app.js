/**
 * Benten Mobile — lecteur autonome pour iPhone.
 *
 * POURQUOI PAS UNE APP iOS
 * iOS n'exécute pas Electron, et fabriquer un `.ipa` exige un Mac avec Xcode. Cette page est donc
 * une application web installable : on l'ouvre une fois depuis Safari, « Partager ▸ Sur l'écran
 * d'accueil », et elle s'ouvre ensuite comme une app, sans PC allumé.
 *
 * CE QU'ELLE FAIT
 * - import de fichiers audio depuis Fichiers / iCloud (sélecteur natif) ;
 * - stockage DANS l'appareil (IndexedDB) quand c'est possible, sinon en mémoire pour la session ;
 * - lecture, pause, suivant/précédent, déplacement dans la piste ;
 * - hors-ligne une fois installée (service worker).
 *
 * RIEN NE DOIT MOURIR EN SILENCE : chaque échec est affiché à l'écran. Un module qui plante sans
 * message donne exactement ce que l'utilisateur a signalé — « ça charge et ça ne fait rien ».
 */

const DB_NAME = "benten-mobile";
const DB_STORE = "tracks";
const DB_VERSION = 1;

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const library = $("library");
const player = $("player");
const titleEl = $("title");
const artistEl = $("artist");
const seekEl = $("seek");
const curEl = $("t-cur");
const durEl = $("t-dur");
const toggleBtn = $("toggle");
const nextBtn = $("next");
const prevBtn = $("prev");
const filesInput = $("files");
const statusEl = $("status");

let tracks = [];
/** `off` = arrêt en fin de liste, `all` = on recommence, `one` = le même titre en boucle. */
let repeatMode = "all";
let shuffle = false;
/** Ordre de lecture : la liste, ou une permutation mélangée (recalculée à chaque tour). */
let playOrder = [];
let currentIndex = -1;
let objectUrl = null;
/** `true` quand le stockage persistant fonctionne ; sinon on reste en mémoire (session seulement). */
let persistent = false;
let dbPromise = null;

/* ------------------------------- Messages ------------------------------- */

function say(message, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

/** Affiche une erreur à l'écran ET dans la console : jamais d'échec muet. */
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
    request.onblocked = () => reject(new Error("base verrouillée par un autre onglet"));
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

/** « Artiste - Titre » quand le nom de fichier suit cette convention, sinon le nom brut. */
function splitName(name) {
  const clean = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const parts = clean.split(" - ");
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { artist: "Fichier importé", title: clean };
}

function render() {
  if (tracks.length === 0) {
    library.innerHTML =
      '<p class="empty">Aucune musique sur cet appareil.<br />Touche <b>importer</b> et choisis des fichiers dans Fichiers ou iCloud.</p>';
    player.hidden = true;
    return;
  }
  library.innerHTML = "";
  tracks.forEach((track, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track" + (index === currentIndex ? " is-playing" : "");
    const indexEl = document.createElement("span");
    indexEl.className = "track__index";
    indexEl.textContent = index === currentIndex ? "♪" : String(index + 1);
    const text = document.createElement("span");
    text.className = "track__text";
    const title = document.createElement("span");
    title.className = "track__title";
    title.textContent = track.title; // jamais interprété comme du HTML
    const artist = document.createElement("span");
    artist.className = "track__artist";
    artist.textContent = track.artist;
    text.append(title, artist);
    button.append(indexEl, text);
    button.addEventListener("click", () => play(index));
    library.appendChild(button);
  });
}

/* -------------------------------- Lecture -------------------------------- */

function play(index) {
  const track = tracks[index];
  if (!track) return;
  currentIndex = index;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(track.blob);
  audio.src = objectUrl;
  titleEl.textContent = track.title;
  artistEl.textContent = track.artist;
  player.hidden = false;
  audio.play().catch((error) => fail("lecture refusée", error));
  render();
}

/** Position suivante/précédente selon l''ordre courant et le mode de répétition. */
function nextIndex(delta) {
  if (tracks.length === 0) return null;
  if (repeatMode === "one" && delta > 0 && currentIndex >= 0) return currentIndex;
  const order = playOrder.length === tracks.length ? playOrder : tracks.map((_, i) => i);
  const position = order.indexOf(currentIndex);
  const target = position + delta;
  if (target >= 0 && target < order.length) return order[target];
  if (repeatMode === "off") return null;
  // Rebouchon : on repart de l''autre bout (et on remélange si l''aléatoire est actif).
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

/** Reconstruit l''ordre de lecture (mélangé si demandé), en gardant la piste courante en tête. */
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

/* -------------------------------- Événements -------------------------------- */

filesInput.addEventListener("change", async () => {
  const files = [...(filesInput.files ?? [])];
  filesInput.value = "";
  if (files.length === 0) return;
  say(`import de ${files.length} fichier(s)…`);
  let stored = 0;
  for (const file of files) {
    const { artist, title } = splitName(file.name);
    const track = {
      id: `${file.name}:${file.size}:${file.lastModified}`,
      title,
      artist,
      blob: file,
      addedAt: Date.now(),
    };
    try {
      if (persistent) await saveTrack(track);
      stored += 1;
      // En mémoire, on remplace un éventuel doublon pour ne pas empiler deux fois le même fichier.
      tracks = [...tracks.filter((item) => item.id !== track.id), track];
    } catch (error) {
      persistent = false;
      fail("enregistrement", error);
      tracks = [...tracks.filter((item) => item.id !== track.id), track];
      stored += 1;
    }
  }
  buildOrder();
  render();
  say(
    stored === 0
      ? "aucun fichier importé"
      : persistent
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
});
audio.addEventListener("pause", () => {
  toggleBtn.textContent = "▶";
  toggleBtn.setAttribute("aria-label", "Lecture");
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

/* ------------------------------ Démarrage ------------------------------ */

async function start() {
  // Le sélecteur doit répondre même si le stockage ne fonctionne pas.
  render();
  say("prêt");
  try {
    tracks = await loadTracks();
    persistent = true;
    render();
    say(tracks.length === 0 ? "prêt — importe tes morceaux" : `${tracks.length} morceau(x) sur l'appareil`);
  } catch (error) {
    persistent = false;
    fail("stockage local", error);
    say("stockage local indisponible — import possible, mais perdu à la fermeture", "error");
  }

  // Service worker : hors-ligne une fois installée. Son échec (HTTP sans TLS) n'empêche rien.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("[benten] service worker non enregistré", error);
    });
  }
}

/* -------------------------------- Réglages -------------------------------- */

const sheet = $("sheet");
const sheetInfo = $("sheetInfo");
const shuffleBtn = $("shuffle");
const clearBtn = $("clear");

function refreshSheet() {
  if (!sheet) return;
  for (const button of sheet.querySelectorAll("[data-repeat]")) {
    button.setAttribute("aria-pressed", String(button.dataset.repeat === repeatMode));
  }
  if (shuffleBtn) shuffleBtn.setAttribute("aria-pressed", String(shuffle));
  if (sheetInfo) {
    sheetInfo.textContent = `${tracks.length} morceau(x) · stockage ${persistent ? "sur l'appareil" : "en mémoire (temporaire)"}`;
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

$("settingsOpen")?.addEventListener("click", openSheet);
$("sheetClose")?.addEventListener("click", closeSheet);
sheet?.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet(); // toucher le fond ferme la feuille
});

for (const button of sheet?.querySelectorAll("[data-repeat]") ?? []) {
  button.addEventListener("click", () => {
    repeatMode = button.dataset.repeat ?? "all";
    refreshSheet();
  });
}

shuffleBtn?.addEventListener("click", () => {
  shuffle = !shuffle;
  buildOrder();
  refreshSheet();
});

clearBtn?.addEventListener("click", async () => {
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

/* ------------------------------ Synchronisation ------------------------------ */

/**
 * Récupère depuis le PC les morceaux absents du téléphone.
 *
 * Le PC doit être allumé et Benten ouvert ; l'adresse et le jeton sont affichés dans ses Réglages.
 * Sans ce mécanisme, un iPhone ne peut RIEN récupérer tout seul : iOS interdit à une app de lancer
 * yt-dlp ou d'écrire où que ce soit hors de son bac à sable.
 */
const SYNC_KEY = "benten-sync";

function syncSettings() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSyncSettings(host, token, limit) {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ host, token, limit }));
}

const syncHost = $("syncHost");
const syncToken = $("syncToken");
const syncRun = $("syncRun");
const syncLimit = $("syncLimit");

if (syncHost && syncToken) {
  const saved = syncSettings();
  if (saved.host) syncHost.value = saved.host;
  if (saved.token) syncToken.value = saved.token;
  if (saved.limit && syncLimit) syncLimit.value = String(saved.limit);
}

syncRun?.addEventListener("click", async () => {
  const host = (syncHost?.value ?? "").trim().replace(/\/+$/, "");
  const token = (syncToken?.value ?? "").trim();
  if (!host || !token) {
    say("renseigne l'adresse et le jeton du PC", "error");
    return;
  }
  // Pas de plafond arbitraire : si l'utilisateur a la place, il a le droit. Vide = tout.
  const rawLimit = Number(syncLimit?.value);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(5000, Math.floor(rawLimit)) : 5000;
  saveSyncSettings(host, token, limit);
  syncRun.disabled = true;
  try {
    say("connexion au PC…");
    const response = await fetch(`${host}/api/library?token=${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error(`le PC a répondu ${response.status} (jeton ou adresse ?)`);
    const payload = await response.json();
    const remote = Array.isArray(payload.tracks) ? payload.tracks : [];
    const known = new Set(tracks.map((track) => track.id));
    const all = remote.filter((item) => !known.has(`pc:${item.id}`));
    const missing = all.slice(0, limit);
    const planned = missing.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
    say(`${missing.length} morceau(x) à récupérer (~${(planned / 1048576).toFixed(0)} Mo), ${all.length} disponible(s)`);
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
      };
      try {
        if (persistent) await saveTrack(record);
        tracks = [...tracks.filter((track) => track.id !== record.id), record];
        added += 1;
      } catch (error) {
        fail("enregistrement", error);
      }
      say(`${added}/${missing.length} récupéré(s)…`);
    }
    buildOrder();
    render();
    refreshSheet();
    say(added === 0 ? "rien de nouveau sur le PC" : `${added} morceau(x) récupéré(s)`);
  } catch (error) {
    fail("synchronisation", error);
  } finally {
    syncRun.disabled = false;
  }
});

start().catch((error) => fail("démarrage", error));







