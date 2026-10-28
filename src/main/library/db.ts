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
