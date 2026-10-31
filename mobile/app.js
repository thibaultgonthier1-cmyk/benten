/**
 * Benten Mobile — lecteur autonome pour iPhone.
 *
 * POURQUOI PAS UNE APP iOS
 * iOS n'exécute pas Electron, et fabriquer un `.ipa` exige un Mac avec Xcode. Cette page est donc
 * une application web installable : on l'ouvre une fois depuis Safari, « Partager ▸ Sur l'écran
 * d'accueil », et elle s'ouvre ensuite comme une app, hors-ligne, sans PC allumé.
 *
 * CE QU'ELLE FAIT
 * - import de fichiers audio depuis Fichiers / iCloud (sélecteur natif) ;
 * - stockage DANS l'appareil (IndexedDB : les fichiers restent sur le téléphone) ;
 * - lecture, pause, suivant/précédent, déplacement dans la piste, reprise automatique ;
 * - hors-ligne complet une fois installée (service worker).
 *
 * CE QU'ELLE NE FAIT PAS — et c'est structurel, pas un manque de travail
 * - scanner un dossier : iOS l'interdit à toute app ;
 * - télécharger depuis Apple Music ou YouTube : pas de processus externe possible sur iOS.
 */

const DB_NAME = "benten-mobile";
const DB_STORE = "tracks";
const DB_VERSION = 1;

const audio = document.getElementById("audio");
const library = document.getElementById("library");
const player = document.getElementById("player");
const titleEl = document.getElementById("title");
const artistEl = document.getElementById("artist");
const seekEl = document.getElementById("seek");
const curEl = document.getElementById("t-cur");
const durEl = document.getElementById("t-dur");
const toggleBtn = document.getElementById("toggle");
const nextBtn = document.getElementById("next");
const prevBtn = document.getElementById("prev");
const filesInput = document.getElementById("files");

let tracks = []; // { id, title, artist, blob, addedAt }
let currentIndex = -1;
let objectUrl = null;

/* ------------------------------- Stockage ------------------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { artist: "Fichier importé", title: clean };
}

function render() {
  if (tracks.length === 0) {
    library.innerHTML =
      '<p class="empty">Aucune musique sur cet appareil.<br />Touche <b>importer</b> et choisis des fichiers depuis Fichiers ou iCloud.</p>';
    player.hidden = true;
    return;
  }
  library.innerHTML = "";
  tracks.forEach((track, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track" + (index === currentIndex ? " is-playing" : "");
    button.innerHTML = `
      <span class="track__index">${index === currentIndex ? "♪" : index + 1}</span>
      <span class="track__text">
        <span class="track__title"></span>
        <span class="track__artist"></span>
      </span>`;
    // textContent : un nom de fichier ne doit jamais être interprété comme du HTML.
    button.querySelector(".track__title").textContent = track.title;
    button.querySelector(".track__artist").textContent = track.artist;
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
  void audio.play().catch(() => undefined);
  render();
}

function next(delta) {
  if (tracks.length === 0) return;
  const index = (currentIndex + delta + tracks.length) % tracks.length;
  play(index);
}

/* -------------------------------- Événements -------------------------------- */

filesInput.addEventListener("change", async () => {
  const files = [...(filesInput.files ?? [])];
  if (files.length === 0) return;
  for (const file of files) {
    const { artist, title } = splitName(file.name);
    await saveTrack({
      id: `${file.name}:${file.size}:${file.lastModified}`,
      title,
      artist,
      blob: file,
      addedAt: Date.now(),
    });
  }
  tracks = await loadTracks();
  render();
  filesInput.value = "";
});

toggleBtn.addEventListener("click", () => {
  if (audio.paused) void audio.play().catch(() => undefined);
  else audio.pause();
});

nextBtn.addEventListener("click", () => next(1));
prevBtn.addEventListener("click", () => next(-1));

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
audio.addEventListener("ended", () => next(1));

seekEl.addEventListener("input", () => {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = (Number(seekEl.value) / 1000) * audio.duration;
});

/* ------------------------------ Démarrage ------------------------------ */

tracks = await loadTracks().catch(() => []);
render();

// Service worker : c'est lui qui rend l'app disponible hors-ligne une fois installée.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
