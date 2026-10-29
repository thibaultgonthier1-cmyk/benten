import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/main/library/db";
import {
  BACKUP_DIR,
  DB_FILE,
  backupDb,
  openDbSafe,
  wireDbClose,
} from "../src/main/library/dbsafety";
import { addSource, getSources, getState, setState } from "../src/main/library/repository";

/**
 * Base de bibliotheque « crash-safe » : ouverture verifiee (quick_check), sauvegardes tournantes,
 * restauration automatique. Tous les fichiers vivent dans des dossiers temporaires.
 */

const at = (iso: string) => () => new Date(iso);

/** Ecrit des octets parasites dans l'en-tete SQLite (offset 0) : « file is not a database ». */
function garbleHeader(file: string): void {
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, Buffer.from("THIS IS NOT SQLITE AT ALL!!!!!!"), 0, 31, 0);
  } finally {
    closeSync(fd);
  }
}

/** Remplit la base pour qu'elle fasse plusieurs pages, puis la ferme (checkpoint WAL). */
function seedDb(file: string, rows = 400): void {
  const db = openDb(file);
  addSource(db, "C:\\Music");
  setState(db, "player", '{"volume":0.5}');
  const ins = db.prepare("INSERT INTO artists (name) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(`artist-${i}-${"x".repeat(200)}`);
  })();
  db.close();
}

describe("openDbSafe", () => {
  let ud: string;
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), "benten-dbsafe-"));
  });
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true });
  });

  it("base saine : ouverte telle quelle, synchronous=FULL, aucune recuperation", () => {
    seedDb(join(ud, DB_FILE));
    const log = vi.fn();
    const { db, recovered } = openDbSafe(ud, { log });
    expect(recovered).toBeNull();
    expect(getSources(db)).toHaveLength(1);
    expect(db.pragma("synchronous", { simple: true })).toBe(2); // FULL
    expect(getState(db, "dbRecovered")).toBeUndefined();
    expect(readdirSync(ud).some((f) => f.startsWith("db-corrupted-"))).toBe(false);
    expect(log).not.toHaveBeenCalled();
    db.close();
  });

  it("premier lancement (aucun fichier) : base neuve, pas une recuperation", () => {
    const { db, recovered } = openDbSafe(ud);
    expect(recovered).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });

  it("en-tete corrompu : fichiers deplaces (jamais supprimes) puis restauration de la derniere sauvegarde", async () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    {
      const { db } = openDbSafe(ud);
      await backupDb(db, ud, { now: at("2026-10-29T10:00:00") });
      // Ecriture APRES la sauvegarde : perdue a la restauration (attendu).
      addSource(db, "D:\\Later");
      db.close();
    }
    const sizeBefore = statSync(file).size;
    garbleHeader(file);

    const log = vi.fn();
    const { db, recovered } = openDbSafe(ud, { log, now: at("2026-10-29T11:22:33") });
    expect(recovered).not.toBeNull();
    expect(recovered!.restoredFrom).toBe(join(ud, BACKUP_DIR, "benten-20261029-100000.db"));
    // Donnees de la sauvegarde.
    expect(getSources(db).map((s) => s.path)).toEqual(["C:\\Music"]);
    expect(getState(db, "player")).toBe('{"volume":0.5}');
    // Drapeau one-shot pour le Renderer.
    expect(getState(db, "dbRecovered")).toBe(new Date("2026-10-29T11:22:33").toISOString());
    // Fichier fautif conserve tel quel dans db-corrupted-<horodatage>/.
    const bad = join(ud, "db-corrupted-20261029-112233");
    expect(recovered!.corruptedDir).toBe(bad);
    expect(existsSync(join(bad, DB_FILE))).toBe(true);
    expect(statSync(join(bad, DB_FILE)).size).toBe(sizeBefore);
    // Entree du journal audio.
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "process",
        event: "db",
        action: "recovered",
        restoredFrom: recovered!.restoredFrom,
        corruptedDir: bad,
      }),
    );
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("fichier tronque sans sauvegarde : base neuve, fichiers fautifs (db, -wal, -shm) conserves", () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    const truncatedSize = Math.floor(statSync(file).size / 2);
    truncateSync(file, truncatedSize);
    // Des residus WAL/SHM accompagnent souvent un crash : ils doivent suivre la base fautive.
    writeFileSync(`${file}-wal`, "wal-residue");
    writeFileSync(`${file}-shm`, "shm-residue");

    const { db, recovered } = openDbSafe(ud, { now: at("2026-10-29T12:00:00") });
    expect(recovered).not.toBeNull();
    expect(recovered!.restoredFrom).toBeNull();
    // Base neuve, migree, vide (la veille de dossiers re-indexera).
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(getSources(db)).toEqual([]);
    expect(getState(db, "dbRecovered")).toBeTypeOf("string");
    const bad = recovered!.corruptedDir;
    // Les ORIGINAUX tels qu'ils etaient AVANT la tentative d'ouverture (SQLite efface un -wal
    // invalide en fermant) : instantanes pris au demarrage et restitues ici.
    const names = readdirSync(bad);
    expect(names).toEqual(expect.arrayContaining([DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`]));
    expect(readFileSync(join(bad, `${DB_FILE}-wal`), "utf8")).toBe("wal-residue");
    expect(readFileSync(join(bad, `${DB_FILE}-shm`), "utf8")).toBe("shm-residue");
    expect(statSync(join(bad, DB_FILE)).size).toBe(truncatedSize);
    db.close();
  });

  it("sauvegarde elle-meme corrompue : on passe a la suivante qui passe quick_check", async () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    {
      const { db } = openDbSafe(ud);
      await backupDb(db, ud, { now: at("2026-10-28T09:00:00") });
      await backupDb(db, ud, { now: at("2026-10-29T09:00:00") });
      db.close();
    }
    garbleHeader(join(ud, BACKUP_DIR, "benten-20261029-090000.db"));
    garbleHeader(file);
    const { db, recovered } = openDbSafe(ud, { now: at("2026-10-29T13:00:00") });
    expect(recovered!.restoredFrom).toBe(join(ud, BACKUP_DIR, "benten-20261028-090000.db"));
    expect(getSources(db)).toHaveLength(1);
    db.close();
  });
});

describe("backupDb (sauvegardes tournantes)", () => {
  let ud: string;
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), "benten-dbbak-"));
  });
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true });
  });

  it("ecrit benten-<YYYYMMDD-HHmmss>.db lisible et ne garde que les 3 plus recentes", async () => {
    seedDb(join(ud, DB_FILE));
    const { db } = openDbSafe(ud);
    const dir = join(ud, BACKUP_DIR);
    mkdirSync(dir, { recursive: true });
    // Fichiers etrangers au motif exact : jamais touches.
    writeFileSync(join(dir, "notes.txt"), "keep");
    writeFileSync(join(dir, "benten-old.db"), "keep");
    writeFileSync(join(dir, "benten-20200101-000000.db.bak"), "keep");

    const stamps = [
      "2026-10-25T08:00:00",
      "2026-10-26T08:00:00",
      "2026-10-27T08:00:00",
      "2026-10-28T08:00:00",
      "2026-10-29T08:00:00",
    ];
    for (const s of stamps) await backupDb(db, ud, { now: at(s) });

    expect(readdirSync(dir).sort()).toEqual(
      [
        "benten-20261027-080000.db",
        "benten-20261028-080000.db",
        "benten-20261029-080000.db",
        "benten-old.db",
        "benten-20200101-000000.db.bak",
        "notes.txt",
      ].sort(),
    );
    // La sauvegarde est une base valide contenant les donnees.
    const copy = openDb(join(dir, "benten-20261029-080000.db"));
    expect(getSources(copy)).toHaveLength(1);
    copy.close();
    db.close();
  });

  it("ne rejette jamais (dossier impossible a creer)", async () => {
    seedDb(join(ud, DB_FILE));
    const { db } = openDbSafe(ud);
    writeFileSync(join(ud, "blocker"), "x");
    await expect(backupDb(db, join(ud, "blocker"))).resolves.toBeNull();
    db.close();
  });
});

describe("wireDbClose (fermeture ordonnee a la sortie)", () => {
  it("ferme la base une seule fois sur will-quit", () => {
    const app = new EventEmitter();
    const db = { close: vi.fn() };
    wireDbClose(app, db);
    app.emit("will-quit");
    app.emit("will-quit");
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("une erreur de fermeture n'est pas propagee", () => {
    const app = new EventEmitter();
    wireDbClose(app, {
      close: () => {
        throw new Error("busy");
      },
    });
    expect(() => app.emit("will-quit")).not.toThrow();
  });
});
