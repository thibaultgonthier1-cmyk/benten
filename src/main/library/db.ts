import Database from "better-sqlite3";

/** Migrations ordonnées ; l'index + 1 est la valeur de `PRAGMA user_version` après application. */
const MIGRATIONS: readonly string[] = [
  // v1 : schéma initial
  `
  CREATE TABLE artists (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE albums (
    id        INTEGER PRIMARY KEY,
    title     TEXT NOT NULL,
    artist_id INTEGER NOT NULL REFERENCES artists(id),
    art_key   TEXT,
    UNIQUE (title, artist_id)
  );

  CREATE TABLE tracks (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL,
    album        TEXT NOT NULL,
    artist_id    INTEGER NOT NULL REFERENCES artists(id),
    album_id     INTEGER NOT NULL REFERENCES albums(id),
    track_no     INTEGER,
    duration_sec REAL NOT NULL,
    format       TEXT NOT NULL,
    sample_rate  INTEGER,
    bit_depth    INTEGER,
    playable     INTEGER NOT NULL DEFAULT 1,
    art_key      TEXT
  );

  CREATE INDEX idx_tracks_album_id ON tracks(album_id);
  CREATE INDEX idx_tracks_artist   ON tracks(artist);
  CREATE INDEX idx_tracks_title    ON tracks(title);
  `,

  // v2 : additif (Phase 2). Nouvelles colonnes nullables, index de tri en NOCASE,
  // tables sources/playlists/favoris/état. Ne supprime ni ne réécrit aucune donnée v1.
  `
  ALTER TABLE tracks ADD COLUMN album_artist TEXT;
  ALTER TABLE tracks ADD COLUMN disc_no      INTEGER;
  ALTER TABLE tracks ADD COLUMN mtime_ms     INTEGER;
  ALTER TABLE tracks ADD COLUMN size_bytes   INTEGER;

  ALTER TABLE albums ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

  DROP INDEX idx_tracks_artist;
  CREATE INDEX idx_tracks_artist ON tracks(artist COLLATE NOCASE);
  DROP INDEX idx_tracks_title;
  CREATE INDEX idx_tracks_title  ON tracks(title COLLATE NOCASE);

  CREATE TABLE sources (
    id       INTEGER PRIMARY KEY,
    path     TEXT NOT NULL UNIQUE,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE playlists (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, position)
  );

  CREATE TABLE favorites (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v3 : additif (Phase 3). Date d'ajout réelle d'une piste = création du fichier (birthtime,
  // repli mtime), posée à l'insertion et jamais réécrite ensuite ; NULL sur les lignes existantes
  // jusqu'au rattrapage au démarrage (backfillAddedAt). Index pour le tri « Ajouté ».
  // NB : la Tâche 11 prévoyait v3 pour play_history ; elle devient v4.
  `
  ALTER TABLE tracks ADD COLUMN added_at_ms INTEGER;
  CREATE INDEX idx_tracks_added_at ON tracks(added_at_ms);
  `,
];

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Ouvre (ou crée) la base SQLite et applique les migrations en attente. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
