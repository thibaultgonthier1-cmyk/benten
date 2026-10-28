import type Database from "better-sqlite3";
import type {
  AlbumRow,
  ArtistRow,
  Page,
  TrackInput,
  TrackRow,
} from "../../shared/types";

type Db = Database.Database;

const UNKNOWN_ARTIST = "Unknown Artist";
const UNKNOWN_ALBUM = "Unknown Album";

const TRACK_COLUMNS = `
  t.id, t.path, t.title, t.artist, t.album, t.album_artist AS albumArtist,
  t.album_id AS albumId, t.track_no AS trackNo, t.disc_no AS discNo,
  t.duration_sec AS durationSec, t.format,
  t.sample_rate AS sampleRate, t.bit_depth AS bitDepth, t.playable,
  t.art_key AS artKey`;

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
         disc_no, duration_sec, format, sample_rate, bit_depth, playable, art_key)
      VALUES
        (@path, @title, @artist, @album, @albumArtist, @artistId, @albumId, @trackNo,
         @discNo, @durationSec, @format, @sampleRate, @bitDepth, @playable, @artKey)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title, artist = excluded.artist, album = excluded.album,
        album_artist = excluded.album_artist,
        artist_id = excluded.artist_id, album_id = excluded.album_id,
        track_no = excluded.track_no, disc_no = excluded.disc_no,
        duration_sec = excluded.duration_sec,
        format = excluded.format, sample_rate = excluded.sample_rate,
        bit_depth = excluded.bit_depth, playable = excluded.playable,
        art_key = excluded.art_key`),
    albums: db.prepare(`
      SELECT al.id, al.title, ar.name AS artist, al.art_key AS artKey,
             COUNT(t.id) AS trackCount
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      JOIN tracks t ON t.album_id = al.id
      GROUP BY al.id
      ORDER BY al.title COLLATE NOCASE, ar.name COLLATE NOCASE, al.id
      LIMIT @limit OFFSET @offset`),
    tracksByAlbum: db.prepare(`
      SELECT ${TRACK_COLUMNS} FROM tracks t
      WHERE t.album_id = ?
      ORDER BY t.disc_no IS NULL, t.disc_no, t.track_no IS NULL, t.track_no,
               t.title COLLATE NOCASE, t.id`),
    allTracks: db.prepare(`
      SELECT ${TRACK_COLUMNS} FROM tracks t
      ORDER BY t.title COLLATE NOCASE, t.id
      LIMIT @limit OFFSET @offset`),
    artists: db.prepare(`
      SELECT ar.id, ar.name, COUNT(t.id) AS trackCount,
             COUNT(DISTINCT t.album_id) AS albumCount
      FROM artists ar
      JOIN tracks t ON t.artist_id = ar.id
      GROUP BY ar.id
      ORDER BY ar.name COLLATE NOCASE, ar.id`),
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
      });
    }
  })(tracks);
}

export function getAlbums(db: Db, page: Page): AlbumRow[] {
  return stmts(db).albums.all(page) as AlbumRow[];
}

export function getTracksByAlbum(db: Db, albumId: number): TrackRow[] {
  return (stmts(db).tracksByAlbum.all(albumId) as RawTrack[]).map(toTrackRow);
}

export function getAllTracks(db: Db, page: Page): TrackRow[] {
  return (stmts(db).allTracks.all(page) as RawTrack[]).map(toTrackRow);
}

export function getArtists(db: Db): ArtistRow[] {
  return stmts(db).artists.all() as ArtistRow[];
}
