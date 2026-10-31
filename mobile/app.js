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

function step(delta) {
  if (tracks.length === 0) return;
  play((currentIndex + delta + tracks.length) % tracks.length);
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

start().catch((error) => fail("démarrage", error));
