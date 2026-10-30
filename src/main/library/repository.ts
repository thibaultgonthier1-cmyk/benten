import type Database from "better-sqlite3";
import type {
  AlbumRow,
  ArtistRow,
  LibraryFilter,
  Page,
  PlaylistRow,
  SortDir,
  SortField,
  SourceRow,
  TrackInput,
  TrackRow,
} from "../../shared/types";

type Db = Database.Database;

/** Options de tri/filtre partagées par `getAlbums`/`getAllTracks`. */
export interface SortOpts {
  sort?: SortField;
  dir?: SortDir;
  filter?: LibraryFilter;
}

const UNKNOWN_ARTIST = "Unknown Artist";
const UNKNOWN_ALBUM = "Unknown Album";

const TRACK_COLUMNS = `
  t.id, t.path, t.title, t.artist, t.album, t.album_artist AS albumArtist,
  t.album_id AS albumId, t.track_no AS trackNo, t.disc_no AS discNo,
  t.duration_sec AS durationSec, t.format,
  t.sample_rate AS sampleRate, t.bit_depth AS bitDepth, t.playable,
  t.art_key AS artKey, t.mtime_ms AS mtimeMs, t.size_bytes AS sizeBytes,
  t.added_at_ms AS addedAtMs`;

interface RawTrack extends Omit<TrackRow, "playable"> {
  playable: number;
}

const toTrackRow = (r: RawTrack): TrackRow => ({ ...r, playable: r.playable === 1 });

/** Requêtes préparées une fois par connexion. */
function statements(db: Db) {
  return {
    insertArtist: db.prepare("INSERT OR IGNORE INTO artists (name) VALUES (?)"),
    artistId: db.prepare("SELECT id FROM artists WHERE name = ?").pluck(),
    insertAlbum: db.prepare("INSERT OR IGNORE INTO albums (title, artist_id, created_at) VALUES (?, ?, ?)"),
    albumId: db.prepare("SELECT id FROM albums WHERE title = ? AND artist_id = ?").pluck(),
    setAlbumArt: db.prepare("UPDATE albums SET art_key = ? WHERE id = ? AND art_key IS NULL"),
    upsertTrack: db.prepare(`
      INSERT INTO tracks
        (path, title, artist, album, album_artist, artist_id, album_id, track_no,
         disc_no, duration_sec, format, sample_rate, bit_depth, playable, art_key,
         mtime_ms, size_bytes, added_at_ms)
      VALUES
        (@path, @title, @artist, @album, @albumArtist, @artistId, @albumId, @trackNo,
         @discNo, @durationSec, @format, @sampleRate, @bitDepth, @playable, @artKey,
         @mtimeMs, @sizeBytes, @addedAtMs)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title, artist = excluded.artist, album = excluded.album,
        album_artist = excluded.album_artist,
        artist_id = excluded.artist_id, album_id = excluded.album_id,
        track_no = excluded.track_no, disc_no = excluded.disc_no,
        duration_sec = excluded.duration_sec,
        format = excluded.format, sample_rate = excluded.sample_rate,
        bit_depth = excluded.bit_depth, playable = excluded.playable,
        art_key = excluded.art_key, mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        -- Date d'ajout figée : une ré-indexation (re-tag…) ne change jamais l'ordre d'ajout.
        added_at_ms = COALESCE(tracks.added_at_ms, excluded.added_at_ms)`),
    tracksByAlbum: db.prepare(`
      SELECT ${TRACK_COLUMNS} FROM tracks t
      WHERE t.album_id = ?
      ORDER BY t.disc_no IS NULL, t.disc_no, t.track_no IS NULL, t.track_no,
               t.title COLLATE NOCASE, t.id`),
    searchTracks: db.prepare(`
      SELECT ${TRACK_COLUMNS} FROM tracks t
      WHERE t.title  COLLATE NOCASE LIKE @pat ESCAPE '\\'
         OR t.artist COLLATE NOCASE LIKE @pat ESCAPE '\\'
         OR t.album  COLLATE NOCASE LIKE @pat ESCAPE '\\'
      ORDER BY t.title COLLATE NOCASE, t.id
      LIMIT @limit OFFSET @offset`),
    artists: db.prepare(`
      SELECT ar.id, ar.name, COUNT(t.id) AS trackCount,
             COUNT(DISTINCT t.album_id) AS albumCount
      FROM artists ar
      JOIN tracks t ON t.artist_id = ar.id
      GROUP BY ar.id
      ORDER BY ar.name COLLATE NOCASE, ar.id`),
    trackByPath: db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.path = ?`),
    trackStat: db.prepare(
      "SELECT mtime_ms AS mtimeMs, size_bytes AS sizeBytes, art_key AS artKey FROM tracks WHERE path = ?",
    ),
    deleteTrack: db.prepare("DELETE FROM tracks WHERE path = ?"),
    // Purge des albums/artistes orphelins : album_id/artist_id sont NOT NULL, donc
    // les sous-requetes ne renvoient pas de NULL et le `NOT IN` reste correct.
    pruneAlbums: db.prepare("DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks)"),
    pruneArtists: db.prepare("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks)"),
    insertSource: db.prepare("INSERT OR IGNORE INTO sources (path, added_at) VALUES (?, ?)"),
    sources: db.prepare("SELECT id, path, added_at AS addedAt FROM sources ORDER BY added_at, id"),
    deleteSource: db.prepare("DELETE FROM sources WHERE id = ?"),
    // Favoris : PK = track_id (une piste est favorite ou non), cascade a la suppression de piste.
    insertFavorite: db.prepare("INSERT OR IGNORE INTO favorites (track_id, added_at) VALUES (?, ?)"),
    deleteFavorite: db.prepare("DELETE FROM favorites WHERE track_id = ?"),
    isFavorite: db.prepare("SELECT 1 FROM favorites WHERE track_id = ?").pluck(),
    favoriteIds: db.prepare("SELECT track_id FROM favorites ORDER BY added_at, track_id").pluck(),
    // Playlists : CRUD + ordonnancement dense. La PK (playlist_id, position) impose de ne jamais
    // laisser deux lignes partager une position, meme transitoirement (voir recompaction plus bas).
    insertPlaylist: db.prepare("INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)"),
    renamePlaylist: db.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?"),
    deletePlaylist: db.prepare("DELETE FROM playlists WHERE id = ?"),
    touchPlaylist: db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?"),
    playlists: db.prepare(`
      SELECT p.id, p.name, COUNT(pt.track_id) AS trackCount,
             p.created_at AS createdAt, p.updated_at AS updatedAt
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC, p.id DESC`),
    playlistTracks: db.prepare(`
      SELECT ${TRACK_COLUMNS} FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC`),
    playlistTrackIds: db
      .prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC")
      .pluck(),
    playlistMaxPos: db.prepare("SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = ?").pluck(),
    insertPlaylistTrack: db.prepare(
      "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
    ),
    clearPlaylistTracks: db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?"),
    // Etat applicatif (Task 14A) : magasin cle/valeur, upsert idempotent sur la cle.
    getState: db.prepare("SELECT value FROM app_state WHERE key = ?").pluck(),
    setState: db.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
  };
}

const cache = new WeakMap<Db, ReturnType<typeof statements>>();
function stmts(db: Db): ReturnType<typeof statements> {
  let s = cache.get(db);
  if (!s) {
    s = statements(db);
    cache.set(db, s);
  }
  return s;
}

/* ──────────────────────────────────────────────────────────────────────────
 * TRI & FILTRE — anti-injection par LISTE BLANCHE.
 *
 * `sort` et `dir` ne sont JAMAIS interpolés bruts dans le SQL. Un champ de tri est une clé d'une
 * énumération FERMÉE, mappée vers une expression de colonne qui est une CONSTANTE du code source ;
 * `dir` est mappé vers le littéral `ASC`/`DESC`. Les fragments de filtre (`INNER JOIN favorites`,
 * `WHERE ... bit_depth IS NOT NULL`) sont eux aussi des constantes. La SEULE partie dynamique des
 * requêtes construites plus bas est donc ce vocabulaire fixe : aucune chaîne fournie par l'appelant
 * n'atteint le SQL. Toute clé inconnue (y compris une tentative d'injection) retombe sur le défaut.
 * ────────────────────────────────────────────────────────────────────────── */

/** Tri des albums : clé (liste blanche) -> expression de colonne sûre. `duration` = somme des pistes. */
const ALBUM_SORTS: Readonly<Record<string, string>> = {
  title: "al.title COLLATE NOCASE",
  artist: "ar.name COLLATE NOCASE",
  created_at: "al.created_at",
  duration: "SUM(t.duration_sec)",
};

/** Tri des pistes : clé (liste blanche) -> expression de colonne sûre. */
const TRACK_SORTS: Readonly<Record<string, string>> = {
  title: "t.title COLLATE NOCASE",
  artist: "t.artist COLLATE NOCASE",
  album: "t.album COLLATE NOCASE",
  duration: "t.duration_sec",
  track_no: "t.track_no",
};

/** Champ de tri par défaut (et repli pour toute clé hors-liste). */
const DEFAULT_SORT = "title";

/** Littéral SQL depuis `dir` : tout ce qui n'est pas `"desc"` donne `ASC` (défaut, jamais brut). */
function dirLiteral(dir: SortDir | undefined): "ASC" | "DESC" {
  return dir === "desc" ? "DESC" : "ASC";
}

/**
 * Expression de tri PRISE DANS LA LISTE BLANCHE ; toute clé absente/inconnue -> défaut `title`.
 * On exige une propriété PROPRE (`Object.hasOwn`) : une clé héritée d'`Object.prototype`
 * (`__proto__`, `toString`, `constructor`, `valueOf`…) est truthy par simple indexation et
 * renverrait un objet/fonction, interpolé en `ORDER BY [object Object]` qui ferait LEVER
 * `db.prepare`. Le repli reste donc garanti sans exception, même pour ces clés.
 */
function sortExpr(map: Readonly<Record<string, string>>, sort: SortField | undefined): string {
  return sort !== undefined && Object.hasOwn(map, sort) ? map[sort]! : map[DEFAULT_SORT]!;
}

/** Fragment de filtre : jointure favoris (restrictive) — constante, activée par booléen. */
function favJoin(filter: LibraryFilter | undefined): string {
  return filter?.favoritesOnly ? "INNER JOIN favorites f ON f.track_id = t.id" : "";
}

/** Fragment de filtre : sans-perte — constante, activée par booléen. */
function losslessWhere(filter: LibraryFilter | undefined): string {
  return filter?.losslessOnly ? "WHERE t.bit_depth IS NOT NULL" : "";
}

/**
 * Cache de requêtes CONSTRUITES (tri/filtre) par texte SQL, par connexion. Comme le SQL n'est bâti
 * qu'à partir du vocabulaire en liste blanche ci-dessus, l'ensemble des textes possibles est fini et
 * borné : on prépare chaque variante une seule fois.
 */
const dynCache = new WeakMap<Db, Map<string, Database.Statement>>();
function prepareCached(db: Db, sql: string): Database.Statement {
  let m = dynCache.get(db);
  if (!m) {
    m = new Map();
    dynCache.set(db, m);
  }
  let st = m.get(sql);
  if (!st) {
    st = db.prepare(sql);
    m.set(sql, st);
  }
  return st;
}

/**
 * Requête « albums ». Parties dynamiques = UNIQUEMENT des constantes en liste blanche (`order`,
 * littéral `dir`, fragments de filtre) ; aucune chaîne de l'appelant n'y figure (anti-injection).
 */
function buildAlbumsQuery(opts: SortOpts): string {
  const order = sortExpr(ALBUM_SORTS, opts.sort);
  const dir = dirLiteral(opts.dir);
  return `
    SELECT al.id, al.title, ar.name AS artist, al.art_key AS artKey,
           COUNT(t.id) AS trackCount
    FROM albums al
    JOIN artists ar ON ar.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    ${favJoin(opts.filter)}
    ${losslessWhere(opts.filter)}
    GROUP BY al.id
    ORDER BY ${order} ${dir}, al.id
    LIMIT @limit OFFSET @offset`;
}

/**
 * Requête « tracks ». Mêmes garanties anti-injection que `buildAlbumsQuery`. Tri `COLLATE NOCASE`
 * + départage `t.id` : comme pour les albums, cet ordre peut différer du `localeCompare` sensible
 * aux accents utilisé côté Renderer — divergence connue et assumée pour le chemin IPC/vue `tracks`.
 */
function buildAllTracksQuery(opts: SortOpts): string {
  const order = sortExpr(TRACK_SORTS, opts.sort);
  const dir = dirLiteral(opts.dir);
  return `
    SELECT ${TRACK_COLUMNS} FROM tracks t
    ${favJoin(opts.filter)}
    ${losslessWhere(opts.filter)}
    ORDER BY ${order} ${dir}, t.id
    LIMIT @limit OFFSET @offset`;
}

/** Insère ou met à jour les pistes (idempotent sur `path`) dans une seule transaction. */
export function upsertTracks(db: Db, tracks: readonly TrackInput[]): void {
  const s = stmts(db);
  db.transaction((batch: readonly TrackInput[]) => {
    for (const t of batch) {
      const artist = t.artist.trim() || UNKNOWN_ARTIST;
      const album = t.album.trim() || UNKNOWN_ALBUM;
      // L'artiste d'album regroupe les pistes : COALESCE(NULLIF(TRIM(albumArtist),''), artist).
      // Une piste de compilation est donc filee sous l'artiste d'album, pas son artiste de piste.
      const albumArtistName = (t.albumArtist && t.albumArtist.trim()) || artist;
      s.insertArtist.run(albumArtistName);
      const albumArtistId = s.artistId.get(albumArtistName) as number;
      s.insertAlbum.run(album, albumArtistId, Date.now());
      const albumId = s.albumId.get(album, albumArtistId) as number;
      if (t.artKey) s.setAlbumArt.run(t.artKey, albumId);
      s.upsertTrack.run({
        path: t.path,
        title: t.title,
        artist,
        album,
        albumArtist: t.albumArtist,
        artistId: albumArtistId,
        albumId,
        trackNo: t.trackNo,
        discNo: t.discNo,
        durationSec: t.durationSec,
        format: t.format,
        sampleRate: t.sampleRate,
        bitDepth: t.bitDepth,
        playable: t.playable ? 1 : 0,
        artKey: t.artKey,
        mtimeMs: t.mtimeMs,
        sizeBytes: t.sizeBytes,
        addedAtMs: t.addedAtMs ?? null,
      });
    }
  })(tracks);
}

/**
 * Albums paginés. `opts` (facultatif) applique un tri en liste blanche (`title|artist|created_at|
 * duration`, défaut `title`), un sens (`asc|desc`, défaut `asc`) et des filtres cumulables
 * (`favoritesOnly` via jointure `favorites`, `losslessOnly` via `bit_depth IS NOT NULL`). Les parties
 * dynamiques du SQL sont exclusivement des constantes en liste blanche (voir `buildAlbumsQuery`).
 *
 * NB (chemin de tri) : la vue albums du Renderer ne passe PAS par ce tri — le store bibliothèque
 * regroupe les albums côté client depuis la requête `tracks` et les trie via `arrangeAlbums`
 * (`lib/viewModels.ts`, `localeCompare`,
 * sensible aux accents), qui est le chemin UI voulu pour une bibliothèque accentuée. Ce tri backend
 * sert le chemin IPC / la vue `tracks` (et un futur câblage direct de la vue albums). Il s'appuie sur
 * `COLLATE NOCASE` + départage `al.id`, ce qui PEUT ordonner les titres accentués différemment de
 * `localeCompare` : divergence connue et assumée — câbler la vue albums sur ce tri backend serait
 * donc un choix d'ordonnancement délibéré.
 */
export function getAlbums(db: Db, page: Page, opts: SortOpts = {}): AlbumRow[] {
  return prepareCached(db, buildAlbumsQuery(opts)).all(page) as AlbumRow[];
}

export function getTracksByAlbum(db: Db, albumId: number): TrackRow[] {
  return (stmts(db).tracksByAlbum.all(albumId) as RawTrack[]).map(toTrackRow);
}

/**
 * Pistes paginées. `opts` (facultatif) : tri en liste blanche (`title|artist|album|duration|
 * track_no`, défaut `title`), sens (`asc|desc`, défaut `asc`) et filtres cumulables (`favoritesOnly`,
 * `losslessOnly`). Mêmes garanties anti-injection que `getAlbums` (voir `buildAllTracksQuery`).
 */
export function getAllTracks(db: Db, page: Page, opts: SortOpts = {}): TrackRow[] {
  return (prepareCached(db, buildAllTracksQuery(opts)).all(page) as RawTrack[]).map(toTrackRow);
}

/**
 * Échappe les métacaractères `LIKE` (`\`, `%`, `_`) pour qu'ils soient recherchés littéralement.
 * Le `\` lui-même doit être échappé en premier : la regex le capture dans la même passe, donc
 * aucun risque de double-échappement. À combiner avec `ESCAPE '\'` dans la requête.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Recherche plein-texte simple sur `title`/`artist`/`album` : `LIKE` insensible à la casse
 * (`COLLATE NOCASE`), motif `%<q échappé>%`. Les métacaractères `LIKE` de `q` sont échappés
 * (voir `escapeLike`) et interprétés littéralement via `ESCAPE '\'`. Une requête vide ou
 * uniquement blanche renvoie `[]` SANS interroger la base.
 */
export function searchTracks(db: Db, q: string, page: Page): TrackRow[] {
  if (typeof q !== "string" || q.trim() === "") return [];
  const pat = `%${escapeLike(q.trim())}%`;
  return (
    stmts(db).searchTracks.all({ pat, limit: page.limit, offset: page.offset }) as RawTrack[]
  ).map(toTrackRow);
}

export function getArtists(db: Db): ArtistRow[] {
  return stmts(db).artists.all() as ArtistRow[];
}

/** Piste par chemin, ou `undefined` si absente. */
export function getTrackByPath(db: Db, path: string): TrackRow | undefined {
  const r = stmts(db).trackByPath.get(path) as RawTrack | undefined;
  return r ? toTrackRow(r) : undefined;
}

/**
 * Re-resout une liste d'ids en `TrackRow`, en PRESERVANT l'ordre demande et en LAISSANT TOMBER
 * les ids absents (piste supprimee depuis la sauvegarde). Les doublons sont conserves (une file peut
 * repeter une piste). Sert la reprise de file au lancement (Task 14A). Les ids sont dedupliques pour
 * la requete (bornee par lots pour rester sous la limite de variables SQLite), puis l'ordre et les
 * doublons d'origine sont reconstitues en memoire.
 */
export function getTracksByIds(db: Db, ids: readonly number[]): TrackRow[] {
  if (ids.length === 0) return [];
  const byId = new Map<number, TrackRow>();
  const unique = [...new Set(ids)];
  const CHUNK = 500; // marge confortable sous SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.id IN (${placeholders})`)
      .all(...slice) as RawTrack[];
    for (const r of rows) byId.set(r.id, toTrackRow(r));
  }
  const out: TrackRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

/** Stat persisté + clé de pochette d'une piste, pour décider d'un saut de ré-extraction. */
export function getTrackStat(
  db: Db,
  path: string,
): { mtimeMs: number | null; sizeBytes: number | null; artKey: string | null } | undefined {
  return stmts(db).trackStat.get(path) as
    | { mtimeMs: number | null; sizeBytes: number | null; artKey: string | null }
    | undefined;
}

/**
 * Enregistre une racine de bibliothèque comme source persistée. Idempotent sur `path`
 * (`INSERT OR IGNORE` : une racine déjà présente n'est ni dupliquée ni réhorodatée).
 */
/**
 * Chemin de source normalisé : séparateurs unifiés, antislashs doublés réduits, casse Windows
 * ignorée. Sans cela, le même dossier pouvait entrer deux fois (`C:\X` et `C:\\X`) et être
 * scanné en double — observé en vrai après un scan lancé avec un chemin mal échappé.
 */
export function normalizeSourcePath(raw: string): string {
  // On ne RÉÉCRIT PAS les séparateurs (un chemin POSIX reste POSIX) : on se contente de réduire
  // les antislashs doublés et de retirer les séparateurs de fin.
  return String(raw ?? "")
    .trim()
    .replace(/\\\\+/g, "\\")
    .replace(/[\\/]+$/, "");
}

export function addSource(db: Db, path: string): void {
  const clean = normalizeSourcePath(path);
  if (clean.length === 0) return;
  // Comparaison insensible à la casse : Windows ne distingue pas `Music` de `music`.
  const known = getSources(db).some((source) => source.path.toLowerCase() === clean.toLowerCase());
  if (known) return;
  stmts(db).insertSource.run(clean, Date.now());
}

/** Racines persistées, de la plus ancienne à la plus récente. */
export function getSources(db: Db): SourceRow[] {
  return stmts(db).sources.all() as SourceRow[];
}

/** Retire une source par `id` (no-op si l'id n'existe pas). */
export function removeSource(db: Db, id: number): void {
  stmts(db).deleteSource.run(id);
}

/* ──────────────────────────────────────────────────────────────────────────
 * ETAT APPLICATIF — magasin cle/valeur (`app_state`). Sert la persistance de
 * l'etat de lecture (Task 14A). La valeur est une chaine opaque (JSON cote
 * Renderer) : le repository ne l'interprete pas.
 * ────────────────────────────────────────────────────────────────────────── */

/** Lit la valeur associee a `key`, ou `undefined` si la cle est absente. */
export function getState(db: Db, key: string): string | undefined {
  return stmts(db).getState.get(key) as string | undefined;
}

/** Ecrit `value` pour `key` (upsert idempotent : un second appel ecrase la valeur). */
export function setState(db: Db, key: string, value: string): void {
  stmts(db).setState.run(key, value);
}

/**
 * Marque (ou démarque) une piste comme favorite. `on=true` : `INSERT OR IGNORE` horodaté
 * (idempotent — une piste déjà favorite n'est ni dupliquée ni ré-horodatée, grâce à la PK
 * `track_id`). `on=false` : `DELETE` (no-op si absente). La jointure `filter.favoritesOnly`
 * (`getAlbums`/`getAllTracks`) devient ainsi effective.
 */
export function setFavorite(db: Db, trackId: number, on: boolean): void {
  const s = stmts(db);
  if (on) s.insertFavorite.run(trackId, Date.now());
  else s.deleteFavorite.run(trackId);
}

/** Vrai si la piste `trackId` est favorite. */
export function isFavorite(db: Db, trackId: number): boolean {
  return stmts(db).isFavorite.get(trackId) !== undefined;
}

/** Ids de toutes les pistes favorites (du plus ancien ajout au plus récent). */
export function getFavoriteIds(db: Db): number[] {
  return stmts(db).favoriteIds.all() as number[];
}

/**
 * Supprime les pistes par `path` (transaction), puis purge les albums et artistes
 * devenus sans piste. Les favoris et entrées de playlist référençant ces pistes
 * disparaissent via `ON DELETE CASCADE` (foreign_keys = ON). Renvoie le nombre de
 * pistes réellement supprimées.
 */
export function removeTracks(db: Db, paths: readonly string[]): number {
  const s = stmts(db);
  return db.transaction((ps: readonly string[]) => {
    let removed = 0;
    for (const p of ps) removed += s.deleteTrack.run(p).changes;
    s.pruneAlbums.run();
    s.pruneArtists.run();
    return removed;
  })(paths);
}

/* ──────────────────────────────────────────────────────────────────────────
 * PLAYLISTS — `position` est DENSE (0..n-1) et CONTIGUË, recompactée dans une
 * transaction à chaque retrait/réordonnancement. La PK (playlist_id, position)
 * interdit deux lignes à la même position, même transitoirement : les mutations
 * d'ordre LISENT l'ordre courant en mémoire, calculent le nouvel ordre en JS,
 * SUPPRIMENT toutes les lignes de la playlist, puis RÉ-INSÈRENT en 0..n-1 — la
 * seule stratégie triviallement sans collision de PK. Chaque mutation bouge
 * `updated_at`. Tout fait dans un seul `db.transaction(...)`.
 * ────────────────────────────────────────────────────────────────────────── */

/** Crée une playlist (created_at = updated_at = maintenant). Renvoie le nouvel id. */
export function createPlaylist(db: Db, name: string): number {
  const now = Date.now();
  return Number(stmts(db).insertPlaylist.run(name, now, now).lastInsertRowid);
}

/** Renomme une playlist et bouge son `updated_at`. */
export function renamePlaylist(db: Db, id: number, name: string): void {
  stmts(db).renamePlaylist.run(name, Date.now(), id);
}

/** Supprime une playlist ; ses `playlist_tracks` partent en cascade (foreign_keys = ON). */
export function deletePlaylist(db: Db, id: number): void {
  stmts(db).deletePlaylist.run(id);
}

/** Toutes les playlists avec leur `trackCount` (LEFT JOIN), plus récemment modifiées d'abord. */
export function getPlaylists(db: Db): PlaylistRow[] {
  return stmts(db).playlists.all() as PlaylistRow[];
}

/** Pistes d'une playlist, ordonnées par `position` croissante. */
export function getPlaylistTracks(db: Db, id: number): TrackRow[] {
  return (stmts(db).playlistTracks.all(id) as RawTrack[]).map(toTrackRow);
}

/**
 * Ajoute des pistes à la FIN de la playlist, aux positions qui suivent le max courant (donc denses
 * et contiguës). Une playlist vide démarre à 0. Transaction ; bouge `updated_at`. Les doublons de
 * piste sont autorisés (la PK porte sur la position, pas sur le track_id).
 */
export function addToPlaylist(db: Db, id: number, trackIds: readonly number[]): void {
  const s = stmts(db);
  db.transaction(() => {
    const max = s.playlistMaxPos.get(id) as number | null;
    let pos = max == null ? 0 : max + 1;
    for (const trackId of trackIds) s.insertPlaylistTrack.run(id, trackId, pos++);
    s.touchPlaylist.run(Date.now(), id);
  })();
}

/**
 * Retire la ligne à `position`, puis RECOMPACTE les positions restantes en 0..n-1. `position`
 * hors bornes = no-op (aucune écriture). Transaction ; bouge `updated_at`. On lit l'ordre courant,
 * on retire l'index, on vide la playlist et on ré-insère — pas de collision de PK possible.
 */
export function removeFromPlaylist(db: Db, id: number, position: number): void {
  const s = stmts(db);
  db.transaction(() => {
    const ids = s.playlistTrackIds.all(id) as number[];
    if (position < 0 || position >= ids.length) return;
    ids.splice(position, 1);
    s.clearPlaylistTracks.run(id);
    ids.forEach((trackId, i) => s.insertPlaylistTrack.run(id, trackId, i));
    s.touchPlaylist.run(Date.now(), id);
  })();
}

/**
 * Insère `trackId` à `position` (annulation d'un retrait) puis re-densifie en 0..n-1 — UNE seule
 * transaction : jamais d'état intermédiaire « ajouté en fin » visible ni de demi-annulation.
 * `position` au-delà de la fin = ajout en fin ; négative = erreur (aucune écriture). Une piste
 * inconnue échoue sur la clé étrangère et la transaction est annulée. Bouge `updated_at`.
 */
export function insertIntoPlaylist(db: Db, id: number, trackId: number, position: number): void {
  if (!Number.isInteger(position) || position < 0) throw new Error("insertIntoPlaylist: position must be >= 0");
  const s = stmts(db);
  db.transaction(() => {
    const ids = s.playlistTrackIds.all(id) as number[];
    ids.splice(Math.min(position, ids.length), 0, trackId);
    s.clearPlaylistTracks.run(id);
    ids.forEach((t, i) => s.insertPlaylistTrack.run(id, t, i));
    s.touchPlaylist.run(Date.now(), id);
  })();
}

/**
 * Déplace la piste de l'index `from` vers l'index `to`, puis re-densifie les positions en 0..n-1.
 * Index hors bornes ou `from === to` = no-op. Transaction ; bouge `updated_at`. Même stratégie
 * sans collision que `removeFromPlaylist` (DELETE puis RE-INSERT dans le nouvel ordre).
 */
export function reorderPlaylist(db: Db, id: number, from: number, to: number): void {
  const s = stmts(db);
  db.transaction(() => {
    const ids = s.playlistTrackIds.all(id) as number[];
    const n = ids.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    s.clearPlaylistTracks.run(id);
    ids.forEach((trackId, i) => s.insertPlaylistTrack.run(id, trackId, i));
    s.touchPlaylist.run(Date.now(), id);
  })();
}


