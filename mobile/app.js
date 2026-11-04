/**
 * Benten Mobile — lecteur autonome pour iPhone, à la DA du bureau, finition Apple Music.
 *
 * CE QUI VIT OÙ
 * - Les morceaux (audio + pochette) vivent sur le téléphone, dans IndexedDB.
 * - Le PC ne sert qu'à la synchronisation : il envoie la liste, l'audio et les pochettes.
 * - Tout le reste (lecture, favoris, vue lecture, couleur dominante) est local et hors-ligne.
 *
 * PRINCIPES
 * - Rien n'échoue en silence : chaque erreur passe par `say()` ou la ligne d'info des réglages.
 * - Aucun `await` de premier niveau : `start()` est attrapée.
 * - Les pochettes sont de VRAIES images (servies par le PC), affichées en <img> ; à défaut,
 *   un dégradé stable dérivé du nom de l'album prend le relais.
 */

const DB_NAME = "benten-mobile";
const DB_VERSION = 3; // v3 : métadonnées et audio dans deux magasins séparés (tenir 1000+ morceaux).
const VERSION = "2.0.0";
const SYNC_KEY = "benten-sync";
const PREFS_KEY = "benten-prefs";
const DEMO = new URLSearchParams(location.search).get("demo") === "1";

const $ = (id) => document.getElementById(id);
const audio = $("audio");

/* ------------------------------- État ------------------------------- */

const state = {
  tracks: [],
  tab: "library",
  mode: "albums",
  current: null,
  queue: [],
  index: 0,
  order: [],
  pos: 0,
  detail: null, // { type: "album" | "artist", key } — page détail façon Apple Music
  playing: false,
  shuffle: false,
  repeat: "all",
  favorites: new Set(),
  palette: "or",
  style: "apple",
  persistent: false,
};

const PALETTES = {
  or: ["#d4aa50", "#f0d38a", "#8a6420", "Or"],
  rose: ["#fa2b56", "#ff6d8b", "#bd1436", "Rosé (Apple Music)"],
  argent: ["#c9cfd6", "#eef2f6", "#6f757c", "Argent"],
  indigo: ["#6f86d6", "#a8b8f0", "#3c4d94", "Indigo"],
  jade: ["#63c9a0", "#9ce8c8", "#2f7d5e", "Jade"],
  vermillon: ["#e0573f", "#f5927c", "#8e2a1a", "Vermillon"],
  brume: ["#b9b2a6", "#e3ddd2", "#6d675d", "Brume"],
};

let lastSearchResults = [];

/* ------------------------------- Messages ------------------------------- */

function say(message, kind = "info") {
  const el = $("status");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message ?? "";
  el.dataset.kind = kind;
}

function explainNetworkError(error) {
  const message = error && error.message ? error.message : String(error);
  if (/load failed|network connection was lost|failed to fetch/i.test(message)) {
    return "iOS a refusé la connexion. Réglages iPhone ▸ Benten ▸ Réseau local : autorise. Puis vérifie que le PC est allumé sur le même Wi-Fi et que l'adresse est la bonne.";
  }
  return message;
}

function fail(where, error) {
  console.error(`[benten] ${where}`, error);
  say(`${where} : ${explainNetworkError(error)}`, "error");
}

/* ------------------------------- Stockage ------------------------------- */

// DEUX magasins séparés — c'est ce qui permet de tenir 1000+ morceaux sans saturer :
//   META  : identité + pochette (léger) → tout chargé au démarrage.
//   AUDIO : le fichier son (lourd)      → lu UNIQUEMENT quand on lance le morceau.
const META = "meta";
const AUDIO = "audio";
const LEGACY = "tracks"; // ancien magasin « tout-en-un » (v1/v2), migré à la volée.

let dbPromise = null;
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
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: "id" });
      // L'ancien magasin `tracks` est conservé tel quel : on le vide par migration au chargement.
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("ouverture impossible"));
  });
  return dbPromise;
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Seules les métadonnées (sans l'audio) montent en mémoire : léger même à 1000+ morceaux. */
async function loadMeta() {
  const db = await openDb();
  await migrateLegacy(db);
  const rows = await reqPromise(db.transaction(META, "readonly").objectStore(META).getAll());
  return rows.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

/** Les octets audio, lus à la demande au lancement d'un morceau. */
async function getAudio(id) {
  const db = await openDb();
  const row = await reqPromise(db.transaction(AUDIO, "readonly").objectStore(AUDIO).get(id));
  return row ? row.blob : null;
}

/** Écrit un morceau : la pochette va dans META, le fichier audio dans AUDIO (deux transactions). */
async function saveTrack(record) {
  const db = await openDb();
  await reqPromise(db.transaction(META, "readwrite").objectStore(META).put(metaOf(record)));
  if (record.blob) await reqPromise(db.transaction(AUDIO, "readwrite").objectStore(AUDIO).put({ id: record.id, blob: record.blob }));
}

/** La version « légère » d'un morceau : tout sauf l'audio. C'est elle qui vit en mémoire. */
function metaOf(record) {
  return {
    id: record.id,
    title: record.title,
    artist: record.artist,
    album: record.album || "",
    cover: record.cover ?? null,
    durationSec: record.durationSec,
    addedAt: record.addedAt,
  };
}

async function clearTracks() {
  const db = await openDb();
  await reqPromise(db.transaction(META, "readwrite").objectStore(META).clear());
  await reqPromise(db.transaction(AUDIO, "readwrite").objectStore(AUDIO).clear());
}

/** Migration douce depuis l'ancien magasin « tout-en-un » : un morceau à la fois, pour ne
 *  jamais charger les 1000 fichiers d'un coup. Ne tourne que si l'ancien magasin existe. */
async function migrateLegacy(db) {
  if (!db.objectStoreNames.contains(LEGACY)) return;
  const ids = await reqPromise(db.transaction(LEGACY, "readonly").objectStore(LEGACY).getAllKeys());
  for (const id of ids) {
    const old = await reqPromise(db.transaction(LEGACY, "readonly").objectStore(LEGACY).get(id));
    if (!old) continue;
    await reqPromise(db.transaction(META, "readwrite").objectStore(META).put(metaOf(old)));
    if (old.blob) await reqPromise(db.transaction(AUDIO, "readwrite").objectStore(AUDIO).put({ id: old.id, blob: old.blob }));
    await reqPromise(db.transaction(LEGACY, "readwrite").objectStore(LEGACY).delete(id));
  }
}

/* ------------------------------- Pochettes ------------------------------- */

// Un seul ObjectURL par morceau, gardé en cache : recréer à chaque rendu fuirait la mémoire.
const coverUrls = new Map();
function coverUrl(track) {
  if (!track || !track.cover) return null;
  if (coverUrls.has(track.id)) return coverUrls.get(track.id);
  const url = URL.createObjectURL(track.cover);
  coverUrls.set(track.id, url);
  return url;
}

function hue(text) {
  let h = 0;
  for (let i = 0; i < String(text).length; i += 1) h = (h * 31 + String(text).charCodeAt(i)) % 360;
  return h;
}
function coverGradient(seed) {
  const h = hue(seed);
  return `background:linear-gradient(150deg, hsl(${h} 38% 34%), hsl(${h} 42% 12%))`;
}
function glowColor(seed) {
  return `hsl(${hue(seed)} 45% 32% / 0.6)`;
}

/** Vignette d'une pochette : vraie image si on l'a, sinon dégradé + note. */
function coverInner(track) {
  const url = coverUrl(track);
  if (url) return `<img src="${url}" alt="" loading="lazy" />`;
  return `<span class="glyph">♪</span>`;
}

/**
 * Couleur dominante d'une pochette, échantillonnée sur un petit canvas (64×64).
 * Les pochettes locales (ObjectURL) ne tachent pas le canvas : lecture possible.
 * Sert à teindre la vue lecture (--cover) pour la rendre « vivante ».
 */
function applyCoverColor(track) {
  const fallback = () => {
    const h = hue(track ? track.album || track.title : "x");
    setCoverColor(`hsl(${h} 42% 26%)`);
  };
  const url = coverUrl(track);
  if (!url) return fallback();
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 64, 64);
      const { data } = ctx.getImageData(0, 0, 64, 64);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 16) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
      }
      // Assombri un peu pour rester un FOND, pas une couleur criarde.
      const dim = 0.72;
      setCoverColor(`rgb(${Math.round((r / n) * dim)}, ${Math.round((g / n) * dim)}, ${Math.round((b / n) * dim)})`);
    } catch {
      fallback();
    }
  };
  img.onerror = fallback;
  img.src = url;
}

function setCoverColor(color) {
  document.documentElement.style.setProperty("--cover", color);
}

/* ------------------------------- Dérivés ------------------------------- */

function albums() {
  const map = new Map();
  for (const track of state.tracks) {
    const album = track.album || "Sans album";
    const key = `${album}||${track.artist}`;
    if (!map.has(key)) map.set(key, { key, album, artist: track.artist, tracks: [] });
    map.get(key).tracks.push(track);
  }
  return [...map.values()].sort((a, b) => a.album.localeCompare(b.album));
}

function artists() {
  const map = new Map();
  for (const group of albums()) {
    if (!map.has(group.artist)) map.set(group.artist, { name: group.artist, albums: [] });
    map.get(group.artist).albums.push(group);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------- Rendu ------------------------------- */

function render() {
  const view = $("view");
  if (!view) return;
  if (state.detail) { view.innerHTML = renderDetail(); bind(); updateMini(); return; }
  if (state.tab === "library") view.innerHTML = renderLibrary();
  else if (state.tab === "favorites") view.innerHTML = renderFavorites();
  else if (state.tab === "playlists") view.innerHTML = renderPlaylists();
  else if (state.tab === "search") view.innerHTML = renderSearch();
  else view.innerHTML = renderSettings();
  bind();
  updateMini();
}

function renderHeader(count) {
  return `
    <div class="eyebrow">今宵 · CE SOIR</div>
    <div class="title">Ta bibliothèque,<br>en local</div>
    <div class="sub">${count} morceau${count > 1 ? "x" : ""} · ${albums().length} album${albums().length > 1 ? "s" : ""}</div>
    <button class="filter-menu" id="filterMenu">${modeLabel()} ⌄</button>
    <div class="segmented">
      <button data-mode="albums" class="${state.mode === "albums" ? "on" : ""}">Albums</button>
      <button data-mode="artists" class="${state.mode === "artists" ? "on" : ""}">Artistes</button>
      <button data-mode="tracks" class="${state.mode === "tracks" ? "on" : ""}">Titres</button>
    </div>`;
}
function modeLabel() {
  return state.mode === "albums" ? "Albums" : state.mode === "artists" ? "Artistes" : "Titres";
}

function renderLibrary() {
  if (!state.tracks.length) {
    return `<div class="empty">Aucune musique sur cet appareil.<br>Touche <b>+</b> pour importer, ou va dans <b>Réglages</b> pour récupérer depuis le PC.</div>`;
  }
  const head = renderHeader(state.tracks.length);

  if (state.mode === "albums") {
    return head + `<div class="grid">` + albums().map((group) => {
      const art = group.tracks.find((t) => t.cover) || group.tracks[0];
      const playing = state.current && group.tracks.some((t) => t.id === state.current.id);
      return `<div class="cell">
        <div class="cover-wrap">
          <div class="glow" style="background:${glowColor(group.album)}"></div>
          <div class="cover" data-play-album="${escapeAttr(group.key)}" style="${coverGradient(group.album)}">
            ${coverInner(art)}${playing ? `<div class="badge">◉</div>` : ""}
          </div>
        </div>
        <div class="t-name">${escapeHtml(group.album)}</div>
        <div class="t-sub">${escapeHtml(group.artist)} · ${group.tracks.length} titre${group.tracks.length > 1 ? "s" : ""}</div>
      </div>`;
    }).join("") + `</div>`;
  }

  if (state.mode === "artists") {
    return head + `<div class="grid">` + artists().map((artist) => {
      const art = artist.albums.flatMap((a) => a.tracks).find((t) => t.cover);
      return `<div class="cell">
        <div class="cover-wrap">
          <div class="glow" style="background:${glowColor(artist.name)}"></div>
          <div class="cover round" data-play-artist="${escapeAttr(artist.name)}" style="${coverGradient(artist.name)}">
            ${art ? coverInner(art) : `<span class="glyph">♪</span>`}
          </div>
        </div>
        <div class="t-name">${escapeHtml(artist.name)}</div>
        <div class="t-sub">${artist.albums.length} album${artist.albums.length > 1 ? "s" : ""}</div>
      </div>`;
    }).join("") + `</div>`;
  }

  const sorted = [...state.tracks].sort((a, b) => a.title.localeCompare(b.title));
  return head + `<div class="rows">` + sorted.map((track, i) => renderRow(track, i)).join("") + `</div>`;
}

function renderRow(track, index) {
  const fav = state.favorites.has(track.id);
  const current = state.current && state.current.id === track.id;
  return `
    <div class="row ${current ? "current" : ""}" data-play-index="${index}" data-id="${escapeAttr(track.id)}">
      <div class="thumb" style="${coverGradient(track.album)}">${coverInner(track)}</div>
      <div class="meta">
        <div class="n">${escapeHtml(track.title)}</div>
        <div class="s">${escapeHtml(track.artist)} · ${fmt(track.durationSec)}</div>
      </div>
      <button class="heart ${fav ? "on" : ""}" data-fav="${track.id}">${fav ? "♥" : "♡"}</button>
    </div>`;
}

function renderFavorites() {
  const list = state.tracks.filter((track) => state.favorites.has(track.id));
  if (!list.length) return `<div class="empty">Aucun favori.<br>Touche le <b>♡</b> sur un morceau.</div>`;
  return `<div class="eyebrow">♥ · TES MORCEAUX</div>
    <div class="title">Favoris</div>
    <div class="sub">${list.length} morceau${list.length > 1 ? "x" : ""}</div>
    <div class="rows" style="padding-top:12px">` + list.map((track, i) => renderRow(track, i)).join("") + `</div>`;
}

function renderPlaylists() {
  return `<div class="empty">Les playlists arrivent depuis le PC avec la synchro.<br>Pour l'instant : <b>Bibliothèque</b> et <b>Favoris</b>.</div>`;
}

/* ---- Page détail (album / artiste) façon Apple Music ---- */

function detailTracks() {
  if (!state.detail) return [];
  if (state.detail.type === "album") {
    const g = albums().find((x) => x.key === state.detail.key);
    return g ? g.tracks : [];
  }
  const a = artists().find((x) => x.name === state.detail.key);
  return a ? a.albums.flatMap((z) => z.tracks) : [];
}

function openDetail(type, key) {
  state.detail = { type, key };
  render();
  const view = $("view");
  if (view) view.scrollTop = 0;
  // Teinte l'écran avec la couleur dominante de la pochette de l'album ouvert (comme Apple Music).
  const tracks = detailTracks();
  const art = tracks.find((t) => t.cover) || tracks[0];
  if (art) applyCoverColor(art);
}

function renderDetail() {
  const tracks = detailTracks();
  if (!tracks.length) { state.detail = null; return renderLibrary(); }
  const isAlbum = state.detail.type === "album";
  const group = isAlbum ? albums().find((x) => x.key === state.detail.key) : null;
  const artist = isAlbum ? null : artists().find((x) => x.name === state.detail.key);
  const title = isAlbum ? group.album : artist.name;
  const sub = isAlbum
    ? `${escapeHtml(group.artist)} · ${tracks.length} titre${tracks.length > 1 ? "s" : ""}`
    : `${artist.albums.length} album${artist.albums.length > 1 ? "s" : ""} · ${tracks.length} titre${tracks.length > 1 ? "s" : ""}`;
  const art = tracks.find((t) => t.cover) || tracks[0];
  return `
    <div class="detail">
      <button class="back" data-back type="button">‹ Retour</button>
      <div class="detail-hero">
        <div class="detail-art ${isAlbum ? "" : "round"}" style="${coverGradient(title)}">${coverInner(art)}</div>
        <h1 class="detail-title">${escapeHtml(title)}</h1>
        <p class="detail-sub">${sub}</p>
        <div class="detail-actions">
          <button class="pill" data-play-detail type="button"><span>▶</span> Lecture</button>
          <button class="pill ghost" data-shuffle-detail type="button"><span>⤨</span> Aléatoire</button>
        </div>
      </div>
      <div class="rows">${tracks.map((t, i) => renderDetailRow(t, i)).join("")}</div>
    </div>`;
}

function renderDetailRow(track, index) {
  const fav = state.favorites.has(track.id);
  const current = state.current && state.current.id === track.id;
  return `
    <div class="row drow ${current ? "current" : ""}" data-play-index="${index}" data-id="${escapeAttr(track.id)}">
      <div class="rownum">${current ? "▶" : index + 1}</div>
      <div class="meta">
        <div class="n">${escapeHtml(track.title)}</div>
        <div class="s">${escapeHtml(track.artist)} · ${fmt(track.durationSec)}</div>
      </div>
      <button class="heart ${fav ? "on" : ""}" data-fav="${track.id}">${fav ? "♥" : "♡"}</button>
    </div>`;
}

function renderSearch() {
  return `<div class="group" style="margin-top:14px">
      <input id="searchInput" class="field" style="margin-top:0" placeholder="Titre, artiste, album" autocomplete="off" />
    </div>
    <div class="rows" id="searchResults" style="padding-top:12px"></div>`;
}

function renderSettings() {
  const saved = syncSettings();
  const palette = Object.entries(PALETTES).map(([key, [accent, , , label]]) => `
    <button class="swatch ${state.palette === key ? "on" : ""}" data-palette="${key}">
      <span class="chip" style="background:${accent}"></span>${label}
    </button>`).join("");

  return `
    <div class="group"><h4>Synchroniser avec le PC</h4>
      <div class="card">
        <div class="line col">
          <input id="syncHost" class="field" type="url" inputmode="url" placeholder="http://192.168.1.10:4321" autocomplete="off" value="${escapeAttr(saved.host ?? "")}" />
          <input id="syncToken" class="field" type="text" placeholder="jeton (affiché dans Réglages sur le PC)" autocomplete="off" value="${escapeAttr(saved.token ?? "")}" />
          <input id="syncLimit" class="field" type="number" min="1" max="5000" inputmode="numeric" placeholder="nombre de morceaux (vide = tout)" value="${escapeAttr(saved.limit ?? "")}" />
          <div class="row-btns">
            <button id="syncTest" class="btn ghost" type="button">Tester</button>
            <button id="syncRun" class="btn go" type="button">Récupérer</button>
          </div>
          <p class="hint" id="syncInfo">—</p>
        </div>
      </div>
    </div>

    <div class="group"><h4>Couleur d'accent</h4>
      <div class="card"><div class="swatches">${palette}</div></div>
    </div>

    <div class="group"><h4>Interface</h4>
      <div class="card">
        <div class="line col">
          <span style="margin-bottom:8px">Style</span>
          <div class="segmented" style="display:flex;margin:0">
            <button data-style="benten" class="${state.style === "benten" ? "on" : ""}">Benten</button>
            <button data-style="apple" class="${state.style === "apple" ? "on" : ""}">Apple Music</button>
          </div>
        </div>
      </div>
    </div>

    <div class="group"><h4>Lecture</h4>
      <div class="card">
        <div class="line"><span>Lecture aléatoire</span>
          <button class="toggle ${state.shuffle ? "on" : ""}" data-toggle="shuffle"></button></div>
        <div class="line"><span>Répéter</span>
          <select id="repeatSelect" class="field" style="width:auto;margin-top:0;min-height:36px;padding:0 10px">
            <option value="off" ${state.repeat === "off" ? "selected" : ""}>Non</option>
            <option value="all" ${state.repeat === "all" ? "selected" : ""}>Toute la liste</option>
            <option value="one" ${state.repeat === "one" ? "selected" : ""}>Ce titre</option>
          </select></div>
      </div>
    </div>

    <div class="group"><h4>Bibliothèque</h4>
      <div class="card">
        <div class="line"><span>Morceaux</span><span class="val">${state.tracks.length}</span></div>
        <div class="line"><span>Albums</span><span class="val">${albums().length}</span></div>
        <div class="line"><span>Stockage</span><span class="val">${state.persistent ? "sur l'appareil" : "en mémoire"}</span></div>
        <div class="line"><span>Tout effacer</span>
          <button id="clear" class="btn danger" type="button">vider</button></div>
      </div>
    </div>

    <div class="group"><h4>À propos</h4>
      <div class="card"><div class="line"><span>Version</span><span class="val">v${VERSION}</span></div></div>
    </div>`;
}

/* ------------------------------- Liaisons ------------------------------- */

// Après chaque rendu, on ne recâble QUE les champs (saisie/sélection) : les clics passent
// par la délégation unique sur #view (setupDelegation), posée une seule fois au démarrage.
function bind() {
  const repeat = $("repeatSelect");
  if (repeat) repeat.onchange = () => { state.repeat = repeat.value; savePrefs(); updateTransport(); };

  const search = $("searchInput");
  if (search) {
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      lastSearchResults = !q ? [] : state.tracks.filter((t) =>
        t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || (t.album || "").toLowerCase().includes(q));
      $("searchResults").innerHTML = lastSearchResults.length
        ? lastSearchResults.map((t, i) => renderRow(t, i)).join("")
        : (q ? `<div class="empty">Aucun résultat</div>` : "");
    };
    search.focus();
  }
}

// Un seul écouteur sur le conteneur de liste : zéro écouteur recréé par ligne, même à 1000 titres.
function setupDelegation() {
  const view = $("view");
  if (!view || view.dataset.wired) return;
  view.dataset.wired = "1";
  view.addEventListener("click", (event) => {
    const t = event.target;
    const fav = t.closest("[data-fav]");
    if (fav) { event.stopPropagation(); toggleFavorite(Number(fav.dataset.fav)); return; }
    const mode = t.closest("[data-mode]");
    if (mode) { state.mode = mode.dataset.mode; render(); return; }
    if (t.closest("#filterMenu")) {
      state.mode = state.mode === "albums" ? "artists" : state.mode === "artists" ? "tracks" : "albums";
      render(); return;
    }
    const style = t.closest("[data-style]");
    if (style) { state.style = style.dataset.style; applyStyle(); savePrefs(); render(); return; }
    const pal = t.closest("[data-palette]");
    if (pal) { applyPalette(pal.dataset.palette); savePrefs(); return; }
    const tog = t.closest("[data-toggle]");
    if (tog) {
      if (tog.dataset.toggle === "shuffle") {
        state.shuffle = !state.shuffle;
        if (state.queue.length) buildOrder(state.index);
        savePrefs(); render();
      }
      return;
    }
    if (t.closest("[data-back]")) { state.detail = null; render(); const v = $("view"); if (v) v.scrollTop = 0; return; }
    if (t.closest("[data-play-detail]")) { const list = detailTracks(); if (list.length) playQueue(list, 0); return; }
    if (t.closest("[data-shuffle-detail]")) {
      const list = detailTracks();
      if (list.length) {
        if (!state.shuffle) { state.shuffle = true; savePrefs(); }
        playQueue(list, Math.floor(Math.random() * list.length));
        updateTransport();
      }
      return;
    }
    // Un album/artiste ouvre sa PAGE DÉTAIL (façon Apple Music), au lieu de lancer direct.
    const alb = t.closest("[data-play-album]");
    if (alb) { openDetail("album", alb.dataset.playAlbum); return; }
    const art = t.closest("[data-play-artist]");
    if (art) { openDetail("artist", art.dataset.playArtist); return; }
    const row = t.closest("[data-play-index]");
    if (row) {
      const index = Number(row.dataset.playIndex);
      const list = state.detail
        ? detailTracks()
        : state.tab === "favorites"
          ? state.tracks.filter((x) => state.favorites.has(x.id))
          : state.tab === "search" ? lastSearchResults
          : [...state.tracks].sort((a, b) => a.title.localeCompare(b.title));
      playQueue(list, index);
      return;
    }
    if (t.closest("#syncTest")) { runSyncTest(); return; }
    if (t.closest("#syncRun")) { runSync(); return; }
    if (t.closest("#clear")) { runClear(); return; }
  });
}

/* ------------------------------- Lecture ------------------------------- */

let objectUrl = null;
let loadToken = 0; // invalide un chargement audio si l'utilisateur change de morceau avant la fin.

function playQueue(list, index) {
  if (!list.length) return;
  state.queue = list;
  const start = Math.max(0, Math.min(index, list.length - 1));
  buildOrder(start);
  state.index = state.order[state.pos];
  load(state.queue[state.index]);
  openNowPlaying();
}

// Ordre de lecture : identité en normal, permutation Fisher–Yates en aléatoire.
// placeFirst garde le morceau choisi en tête (démarrage) ; sans lui, simple reshuffle (boucle).
function buildOrder(startIndex, placeFirst = true) {
  const n = state.queue.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (state.shuffle) {
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    if (placeFirst) {
      const p = idx.indexOf(startIndex);
      if (p > 0) [idx[0], idx[p]] = [idx[p], idx[0]];
    }
  }
  state.order = idx;
  state.pos = placeFirst ? Math.max(0, idx.indexOf(startIndex)) : 0;
}

function load(track) {
  if (!track) return;
  state.current = track;
  // Peinture immédiate (identité + pochette + couleur) : l'écran réagit sans attendre l'audio.
  $("npTitle").textContent = track.title;
  $("npArtist").textContent = track.artist;
  paintCover($("npCover"), track);
  applyCoverColor(track);
  paintBackdrop(track);
  updateMediaSession(track);
  updateMini();
  // Pas de reconstruction de la liste (coûteux à 1000 titres) : on met juste à jour la surbrillance.
  markCurrent();

  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  if (DEMO) {
    // Démo : pas de vrai audio. On simule l'état « en lecture » pour montrer la pochette
    // vivante (grandit) et le disque qui tourne, sans charger de fichier.
    state.playing = true;
    updateTransport();
    return;
  }
  // L'audio est lu à la demande : c'est ce qui évite de charger les 1000 fichiers en mémoire.
  // Si le stockage a été refusé, le blob est resté en mémoire sur le morceau : on l'utilise.
  const token = ++loadToken;
  Promise.resolve(track.blob ?? getAudio(track.id)).then((blob) => {
    if (token !== loadToken) return; // l'utilisateur a déjà changé de morceau
    if (!blob) { fail("lecture", new Error("fichier introuvable sur l'appareil")); return; }
    objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    audio.play().then(() => { state.playing = true; updateTransport(); }).catch((e) => { state.playing = false; updateTransport(); fail("lecture refusée", e); });
  }).catch((e) => fail("lecture", e));
}

function paintCover(el, track) {
  if (!el) return;
  el.style.cssText = coverGradient(track.album);
  el.innerHTML = coverInner(track);
}

// Surbrillance du titre en cours SANS reconstruire la liste : on ne touche qu'à la classe.
function markCurrent() {
  const id = state.current ? state.current.id : null;
  document.querySelectorAll("#view .row").forEach((row) => {
    row.classList.toggle("current", row.dataset.id === id);
  });
}

// Fond « en lecture » façon Apple Music : la vraie pochette, floutée et agrandie, qui dérive.
// Deux calques en fondu croisé pour un changement de morceau sans à-coup.
let artFront = null;
function paintBackdrop(track) {
  const a = $("npArtA");
  const b = $("npArtB");
  if (!a || !b) return;
  const url = coverUrl(track);
  if (!url) { a.classList.remove("show"); b.classList.remove("show"); artFront = null; return; }
  const next = artFront === a ? b : a;
  const prev = artFront === a ? a : b;
  next.style.backgroundImage = `url("${url}")`;
  next.classList.add("show");
  if (prev !== next) prev.classList.remove("show");
  artFront = next;
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  try {
    const artwork = [];
    const url = coverUrl(track);
    if (url) artwork.push({ src: url, sizes: "512x512", type: "image/jpeg" });
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album || "", artwork,
    });
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  } catch {
    /* MediaSession absente ou partielle : sans gravité. */
  }
}

function togglePlay() {
  if (DEMO) { state.playing = !state.playing; updateTransport(); return; }
  if (audio.paused) audio.play().catch((e) => fail("lecture refusée", e));
  else audio.pause();
}

function step(delta, auto = false) {
  if (!state.queue.length) return;
  if (!state.order.length) buildOrder(state.index);
  // Répéter ce titre : uniquement en enchaînement automatique, pas sur un appui « suivant ».
  if (state.repeat === "one" && delta > 0 && auto) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let pos = state.pos + delta;
  if (pos >= state.order.length) {
    if (state.repeat === "off") { audio.pause(); return; }
    if (state.shuffle) buildOrder(0, false); // nouvel ordre aléatoire pour varier la boucle
    pos = 0;
  } else if (pos < 0) {
    pos = state.repeat === "off" ? 0 : state.order.length - 1;
  }
  state.pos = pos;
  state.index = state.order[pos];
  load(state.queue[state.index]);
}

function updateTransport() {
  const play = state.playing ? "❙❙" : "▶";
  $("npPlay").textContent = play;
  $("npPlay").classList.toggle("playing", state.playing);
  $("npCover").classList.toggle("playing", state.playing);
  $("disc").classList.toggle("playing", state.playing);
  $("miniPlay").textContent = play;
  $("npShuffle").classList.toggle("on", state.shuffle);
  $("npRepeat").classList.toggle("on", state.repeat !== "off");
  const fav = state.current && state.favorites.has(state.current.id);
  $("npHeart").textContent = fav ? "♥" : "♡";
  $("npHeart").classList.toggle("on", Boolean(fav));
}

function updateMini() {
  const mini = $("mini");
  if (!mini) return;
  if (!state.current) { mini.hidden = true; return; }
  mini.hidden = false;
  $("miniTitle").textContent = state.current.title;
  $("miniArtist").textContent = state.current.artist;
  paintCover($("miniThumb"), state.current);
  updateTransport();
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  savePrefs();
  render();
  updateTransport();
}

function openNowPlaying() {
  const np = $("np");
  np.classList.remove("closing");
  np.classList.add("open");
}
function closeNowPlaying() {
  const np = $("np");
  np.classList.remove("open");
  np.classList.add("closing");
  setTimeout(() => np.classList.remove("closing"), 300);
}

/* ------------------------------- Préférences ------------------------------- */

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      palette: state.palette, style: state.style, shuffle: state.shuffle,
      repeat: state.repeat, favorites: [...state.favorites],
    }));
  } catch { /* stockage refusé : les préférences restent en session. */ }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    if (p.palette) state.palette = p.palette;
    if (p.style) state.style = p.style;
    if (typeof p.shuffle === "boolean") state.shuffle = p.shuffle;
    if (p.repeat) state.repeat = p.repeat;
    if (Array.isArray(p.favorites)) state.favorites = new Set(p.favorites);
  } catch { /* défauts conservés */ }
}

function applyPalette(key) {
  if (!PALETTES[key]) key = "or";
  state.palette = key;
  const [accent, light, deep] = PALETTES[key];
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-light", light);
  root.setProperty("--accent-deep", deep);
  render();
  updateTransport();
}
function applyStyle() {
  document.body.classList.toggle("apple", state.style === "apple");
}

/* ------------------------------- Synchro ------------------------------- */

function syncSettings() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) ?? "{}"); } catch { return {}; }
}
function saveSyncSettings(host, token, limit) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify({ host, token, limit })); }
  catch (e) { console.warn("[benten] réglages de synchro non enregistrés", e); }
}
function syncTargets() {
  return {
    host: ($("syncHost")?.value ?? "").trim().replace(/\/+$/, ""),
    token: ($("syncToken")?.value ?? "").trim(),
  };
}

function runSyncTest() {
  void (async () => {
    const info = $("syncInfo");
    const { host, token } = syncTargets();
    try {
      if (!host) throw new Error("adresse vide");
      if (!token) throw new Error("jeton vide");
      info.textContent = "test en cours…";
      const response = await fetch(`${host}/api/library?token=${encodeURIComponent(token)}`);
      if (response.status === 403) throw new Error("jeton refusé par le PC (403)");
      if (!response.ok) throw new Error(`le PC a répondu ${response.status}`);
      const payload = await response.json();
      const count = Array.isArray(payload.tracks) ? payload.tracks.length : 0;
      info.textContent = `connexion OK — ${count} morceau(x) sur le PC`;
    } catch (error) {
      info.textContent = `échec : ${error instanceof Error ? error.message : String(error)}`;
    }
  })();
}

function runSync() {
  void (async () => {
    const info = $("syncInfo");
    try {
      const { host, token } = syncTargets();
      if (!host || !token) { info.textContent = "adresse et jeton obligatoires"; return; }
      const rawLimit = Number($("syncLimit")?.value);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(5000, Math.floor(rawLimit)) : 5000;
      saveSyncSettings(host, token, $("syncLimit")?.value ?? "");
      $("syncRun").disabled = true;
      info.textContent = "récupération de la liste…";
      const response = await fetch(`${host}/api/library?token=${encodeURIComponent(token)}`);
      if (!response.ok) throw new Error(`le PC a répondu ${response.status}`);
      const payload = await response.json();
      const remote = Array.isArray(payload.tracks) ? payload.tracks : [];
      const known = new Set(state.tracks.map((t) => t.id));
      const missingAll = remote.filter((item) => !known.has(`pc:${item.id}`));
      const missing = missingAll.slice(0, limit);
      const planned = missing.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
      info.textContent = `${missing.length} à récupérer (~${(planned / 1048576).toFixed(0)} Mo) sur ${missingAll.length}`;
      let added = 0;
      for (const item of missing) {
        const audioResponse = await fetch(`${host}${item.audio}`);
        if (!audioResponse.ok) continue;
        const blob = await audioResponse.blob();
        // La pochette, servie séparément par le PC : récupérée si elle existe.
        let cover = null;
        if (item.art) {
          try {
            const artResponse = await fetch(`${host}${item.art}`);
            if (artResponse.ok) cover = await artResponse.blob();
          } catch { /* pochette absente : dégradé de repli */ }
        }
        const record = {
          id: `pc:${item.id}`,
          title: item.title,
          artist: item.artist,
          album: item.album || "",
          blob,
          cover,
          durationSec: item.durationSec,
          addedAt: Date.now(),
        };
        try { if (state.persistent) await saveTrack(record); }
        catch (e) { state.persistent = false; fail("enregistrement", e); }
        // Seules les métadonnées restent en mémoire ; l'audio vit dans IndexedDB.
        state.tracks = [...state.tracks.filter((t) => t.id !== record.id), state.persistent ? metaOf(record) : record];
        added += 1;
        info.textContent = `${added}/${missing.length} récupéré(s)…`;
      }
      render();
      info.textContent = added === 0 ? "rien de nouveau sur le PC" : `${added} morceau(x) récupéré(s)`;
    } catch (error) {
      info.textContent = `échec : ${error instanceof Error ? error.message : String(error)}`;
      fail("synchronisation", error);
    } finally {
      if ($("syncRun")) $("syncRun").disabled = false;
    }
  })();
}

function runClear() {
  void (async () => {
    state.tracks = [];
    state.current = null;
    state.queue = [];
    audio.pause();
    audio.removeAttribute("src");
    for (const url of coverUrls.values()) URL.revokeObjectURL(url);
    coverUrls.clear();
    if (state.persistent) { try { await clearTracks(); } catch (e) { fail("vidage", e); } }
    updateMini();
    render();
    say("");
  })();
}

/* ------------------------------- Import ------------------------------- */

function splitName(name) {
  const clean = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const parts = clean.split(" - ");
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { artist: "Fichier importé", title: clean };
}

$("files")?.addEventListener("change", async (event) => {
  const input = event.target;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (files.length === 0) return;
  say(`import de ${files.length} fichier(s)…`);
  for (const file of files) {
    const { artist, title } = splitName(file.name);
    const record = {
      id: `file:${file.name}:${file.size}:${file.lastModified}`,
      title, artist, album: "Importés", blob: file, cover: null, addedAt: Date.now(),
    };
    try { if (state.persistent) await saveTrack(record); }
    catch (e) { state.persistent = false; fail("enregistrement", e); }
    state.tracks = [...state.tracks.filter((t) => t.id !== record.id), state.persistent ? metaOf(record) : record];
  }
  render();
  say("");
});

/* ------------------------------- Câblage ------------------------------- */

$("npClose").onclick = closeNowPlaying;
$("grabber").onclick = closeNowPlaying;
$("npPlay").onclick = togglePlay;
$("npNext").onclick = () => step(1);
$("npPrev").onclick = () => { if (audio.currentTime > 3) { audio.currentTime = 0; return; } step(-1); };
$("npShuffle").onclick = () => { state.shuffle = !state.shuffle; if (state.queue.length) buildOrder(state.index); savePrefs(); updateTransport(); };
$("npRepeat").onclick = () => {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  savePrefs();
  updateTransport();
};
$("npHeart").onclick = () => { if (state.current) toggleFavorite(state.current.id); };
$("mini").onclick = openNowPlaying;
$("miniPlay").onclick = (event) => { event.stopPropagation(); togglePlay(); };
$("miniNext").onclick = (event) => { event.stopPropagation(); step(1); };
$("btnSearch").onclick = () => switchTab("search");

document.querySelectorAll("#tabs button").forEach((button) => {
  button.onclick = () => switchTab(button.dataset.tab);
});
function switchTab(tab) {
  state.tab = tab;
  state.detail = null; // revenir à la liste en changeant d'onglet
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  render();
}

audio.addEventListener("play", () => { state.playing = true; updateTransport(); });
audio.addEventListener("pause", () => { state.playing = false; updateTransport(); });
audio.addEventListener("ended", () => step(1, true));
audio.addEventListener("error", () => { if (audio.src) fail("audio", audio.error ?? new Error("format illisible")); });
audio.addEventListener("loadedmetadata", () => { $("npDur").textContent = fmt(audio.duration); });
audio.addEventListener("timeupdate", () => {
  const ratio = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  $("npFill").style.width = `${ratio * 100}%`;
  $("npKnob").style.left = `${ratio * 100}%`;
  $("npPos").textContent = fmt(audio.currentTime);
  $("miniBar").style.width = `${ratio * 100}%`;
});
$("npBar").onclick = (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
};

/* ------------------------------- Utilitaires ------------------------------- */

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(text) { return escapeHtml(text).replace(/`/g, "&#96;"); }

/* ------------------------------- Démo ------------------------------- */

/** Pochette de démo : un carré dégradé en PNG (blob), pour prévisualiser sans le PC. */
function demoCover(seed) {
  return new Promise((resolve) => {
    const h = hue(seed);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 300;
    const ctx = canvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 300, 300);
    g.addColorStop(0, `hsl(${h} 55% 48%)`);
    g.addColorStop(1, `hsl(${(h + 40) % 360} 60% 22%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 300, 300);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.font = "160px Georgia";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(seed)[0]?.toUpperCase() ?? "♪", 150, 165);
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

async function loadDemo() {
  const seeds = [
    ["Clair de Lune", "Debussy", "Nocturnes", 248],
    ["Gymnopédie No.1", "Satie", "Trois Gymnopédies", 193],
    ["Spiegel im Spiegel", "Arvo Pärt", "Alina", 540],
    ["Nuvole Bianche", "Ludovico Einaudi", "Una Mattina", 342],
    ["Comptine d'un autre été", "Yann Tiersen", "Amélie", 141],
    ["Metamorphosis Two", "Philip Glass", "Solo Piano", 455],
    ["Opening", "Philip Glass", "Glassworks", 366],
    ["Divenire", "Ludovico Einaudi", "Divenire", 398],
  ];
  const out = [];
  for (let i = 0; i < seeds.length; i += 1) {
    const [title, artist, album, durationSec] = seeds[i];
    out.push({ id: `demo:${i}`, title, artist, album, durationSec, addedAt: i, blob: new Blob([], { type: "audio/mpeg" }), cover: await demoCover(album) });
  }
  return out;
}

/* ------------------------------- Démarrage ------------------------------- */

async function start() {
  const badge = $("version");
  if (badge) badge.textContent = `v${VERSION}`;

  loadPrefs();
  applyPalette(state.palette);
  applyStyle();
  setupDelegation();
  render();

  if (DEMO) {
    state.tracks = await loadDemo();
    state.persistent = false;
    render();
    say("mode démo — pochettes et interface de test");
    return;
  }

  try {
    state.tracks = await loadMeta();
    state.persistent = true;
    render();
  } catch (error) {
    state.persistent = false;
    fail("stockage local", error);
  }

  const isNativeShell = location.protocol === "capacitor:" || typeof window.Capacitor !== "undefined";
  const saved = syncSettings();
  if (isNativeShell && saved.host) {
    fetch(`${saved.host}/api/library?token=${encodeURIComponent(saved.token ?? "")}`, { method: "HEAD" }).catch(() => undefined);
  }

  const installBanner = $("install");
  const installed = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  if (installBanner && !isNativeShell && !installed) {
    installBanner.hidden = false;
    $("installClose")?.addEventListener("click", () => { installBanner.hidden = true; });
  }

  if ("serviceWorker" in navigator && !isNativeShell) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("[benten] service worker non enregistré", e));
  }
}

start().catch((error) => fail("démarrage", error));
