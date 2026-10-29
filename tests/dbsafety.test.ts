import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import Database from "better-sqlite3";
import { openDb } from "../src/main/library/db";
import {
  BACKUP_DIR,
  DB_FILE,
  backupDb,
  backupsToDelete,
  openDbSafe,
  wireDbClose,
} from "../src/main/library/dbsafety";
import { addSource, getSources, getState, setState } from "../src/main/library/repository";

/**
 * Base de bibliotheque « crash-safe » : ouverture verifiee, copie pre-ouverture apres arret non
 * propre, recuperation declenchee UNIQUEMENT par une corruption, sauvegardes quotidiennes.
 * Tous les fichiers vivent dans des dossiers temporaires.
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

/** Erreur SQLite factice (code), comme celles de better-sqlite3. */
const sqliteError = (code: string, message = code): Error =>
  Object.assign(new Error(message), { code });

const dirsStartingWith = (dir: string, prefix: string): string[] =>
  readdirSync(dir).filter((f) => f.startsWith(prefix));

describe("openDbSafe — ouverture", () => {
  let ud: string;
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), "benten-dbsafe-"));
  });
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true });
  });

  it("base saine : ouverte telle quelle, synchronous=NORMAL, aucune recuperation ni copie", () => {
    seedDb(join(ud, DB_FILE));
    const log = vi.fn();
    const { db, recovered } = openDbSafe(ud, { log });
    expect(recovered).toBeNull();
    expect(getSources(db)).toHaveLength(1);
    expect(db.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    expect(getState(db, "dbRecovered")).toBeUndefined();
    expect(dirsStartingWith(ud, "db-")).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    db.close();
  });

  it("premier lancement (aucun fichier) : base neuve, pas une recuperation", () => {
    const { db, recovered } = openDbSafe(ud);
    expect(recovered).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });

  it("WAL chaud valide (arret brutal) : lignes validees intactes, aucune recuperation, copie pre-ouverture retiree", () => {
    // Fabrique un « crash » : la connexion ecrit dans le WAL (sans checkpoint) et les 3 fichiers
    // sont copies tels quels pendant qu'elle est encore ouverte.
    const live = mkdtempSync(join(tmpdir(), "benten-live-"));
    try {
      const db0 = openDb(join(live, DB_FILE));
      db0.pragma("wal_autocheckpoint = 0");
      addSource(db0, "C:\\Hot");
      setState(db0, "player", "hot");
      for (const n of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
        copyFileSync(join(live, n), join(ud, n));
      }
      db0.close();
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
    expect(statSync(join(ud, `${DB_FILE}-wal`)).size).toBeGreaterThan(0);

    const log = vi.fn();
    const { db, recovered } = openDbSafe(ud, { log, now: at("2026-10-29T09:00:00") });
    expect(recovered).toBeNull();
    expect(getSources(db).map((s) => s.path)).toEqual(["C:\\Hot"]);
    expect(getState(db, "player")).toBe("hot");
    // La copie pre-ouverture a ete supprimee une fois quick_check passe ; rien n'a ete deplace.
    expect(dirsStartingWith(ud, "db-preopen-")).toEqual([]);
    expect(dirsStartingWith(ud, "db-corrupted-")).toEqual([]);
    // L'arret non propre est consigne (correlation avec les incidents), sans recuperation.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      kind: "process",
      event: "db",
      action: "unclean-start",
      preopenDir: join(ud, "db-preopen-20261029-090000"),
      preopenCleared: true,
    });
    db.close();
  });
});

describe("openDbSafe — declenchement par corruption uniquement", () => {
  let ud: string;
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), "benten-dbtrig-"));
    seedDb(join(ud, DB_FILE));
  });
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true });
  });

  for (const code of ["SQLITE_BUSY", "SQLITE_IOERR", "SQLITE_IOERR_READ", "SQLITE_NOMEM", "SQLITE_CANTOPEN"]) {
    it(`${code} a l'ouverture : relance, aucune recuperation, base saine intacte`, () => {
      const before = readFileSync(join(ud, DB_FILE));
      const openDbFn = (): Database.Database => {
        throw sqliteError(code);
      };
      expect(() => openDbSafe(ud, { openDbFn })).toThrow(code);
      expect(readFileSync(join(ud, DB_FILE)).equals(before)).toBe(true);
      expect(dirsStartingWith(ud, "db-corrupted-")).toEqual([]);
    });
  }

  it("quick_check qui leve SQLITE_BUSY : relance, aucune recuperation", () => {
    const openDbFn = (p: string): Database.Database => {
      const db = openDb(p);
      const real = db.pragma.bind(db);
      (db as unknown as { pragma: unknown }).pragma = (src: string, opts?: unknown) => {
        if (src.startsWith("quick_check")) throw sqliteError("SQLITE_BUSY", "database is locked");
        return real(src, opts as Database.PragmaOptions);
      };
      return db;
    };
    expect(() => openDbSafe(ud, { openDbFn })).toThrow(/locked/);
    expect(dirsStartingWith(ud, "db-corrupted-")).toEqual([]);
    expect(existsSync(join(ud, DB_FILE))).toBe(true);
  });

  it("quick_check qui RENVOIE un resultat non 'ok' : recuperation", () => {
    let calls = 0;
    const openDbFn = (p: string): Database.Database => {
      const db = openDb(p);
      if (calls++ === 0) {
        const real = db.pragma.bind(db);
        (db as unknown as { pragma: unknown }).pragma = (src: string, opts?: unknown) =>
          src.startsWith("quick_check")
            ? "*** in database main ***\nPage 7: btreeInitPage() returns error code 11"
            : real(src, opts as Database.PragmaOptions);
      }
      return db;
    };
    const { db, recovered } = openDbSafe(ud, { openDbFn, now: at("2026-10-29T10:00:00") });
    expect(recovered).not.toBeNull();
    expect(recovered!.reason).toMatch(/quick_check/);
    db.close();
  });
});

describe("openDbSafe — recuperation", () => {
  let ud: string;
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), "benten-dbrec-"));
  });
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true });
  });

  it("en-tete corrompu : copie verifiee puis retrait des originaux, restauration de la derniere sauvegarde", async () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    {
      const { db } = openDbSafe(ud);
      await backupDb(db, ud, { now: at("2026-10-29T08:00:00") });
      addSource(db, "D:\\Later"); // apres la sauvegarde : perdu a la restauration (attendu)
      db.close();
    }
    garbleHeader(file);
    const original = readFileSync(file);

    const log = vi.fn();
    const { db, recovered } = openDbSafe(ud, { log, now: at("2026-10-29T11:22:33") });
    expect(recovered).not.toBeNull();
    expect(recovered!.restoredFrom).toBe(join(ud, BACKUP_DIR, "benten-20261029-080000.db"));
    expect(getSources(db).map((s) => s.path)).toEqual(["C:\\Music"]);
    expect(getState(db, "player")).toBe('{"volume":0.5}');
    expect(getState(db, "dbRecovered")).toBe(new Date("2026-10-29T11:22:33").toISOString());
    const bad = join(ud, "db-corrupted-20261029-112233");
    expect(recovered!.corruptedDir).toBe(bad);
    expect(readFileSync(join(bad, DB_FILE)).equals(original)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "process", event: "db", action: "recovered", corruptedDir: bad }),
    );
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("arret non propre + base corrompue : la copie pre-ouverture est CONSERVEE et identique octet pour octet", () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    truncateSync(file, Math.floor(statSync(file).size / 2));
    writeFileSync(`${file}-wal`, "wal-residue");
    writeFileSync(`${file}-shm`, "shm-residue");
    const originals = new Map(
      [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((n) => [n, readFileSync(join(ud, n))]),
    );

    const { db, recovered } = openDbSafe(ud, { now: at("2026-10-29T12:00:00") });
    expect(recovered).not.toBeNull();
    expect(recovered!.restoredFrom).toBeNull(); // aucune sauvegarde : base neuve
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(getSources(db)).toEqual([]);
    const pre = join(ud, "db-preopen-20261029-120000");
    expect(recovered!.preopenDir).toBe(pre);
    for (const [name, bytes] of originals) {
      expect(readFileSync(join(pre, name)).equals(bytes), name).toBe(true);
    }
    // Le dossier fautif existe et les originaux ont quitte userData.
    expect(existsSync(recovered!.corruptedDir)).toBe(true);
    expect(readdirSync(recovered!.corruptedDir)).toContain(DB_FILE);
    db.close();
  });

  it("echec de copie pendant la mise a l'ecart : originaux INTACTS, erreur relancee", () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    garbleHeader(file);
    writeFileSync(`${file}-wal`, "w");
    const before = readFileSync(file);
    const copyFile = (src: string, dest: string): void => {
      // Copie pre-ouverture : OK. Mise a l'ecart (db-corrupted-) : echec des la 1re copie.
      // (SQLite a deja efface le -wal invalide en echouant a ouvrir : seule la copie pre-ouverture
      // en garde la trace — c'est precisement son role.)
      if (dest.includes("db-corrupted-")) throw new Error("ENOSPC: disk full");
      copyFileSync(src, dest);
    };
    expect(() => openDbSafe(ud, { copyFile, now: at("2026-10-29T12:30:00") })).toThrow(/ENOSPC/);
    // La base fautive est restee en place, intacte ; la copie pre-ouverture est conservee.
    expect(readFileSync(file).equals(before)).toBe(true);
    const pre = join(ud, "db-preopen-20261029-123000");
    expect(readFileSync(join(pre, DB_FILE)).equals(before)).toBe(true);
    expect(readFileSync(join(pre, `${DB_FILE}-wal`), "utf8")).toBe("w");
  });

  it("sauvegardes douteuses ignorees (corrompue, 0 octet, souche sans table tracks) : on prend la saine", async () => {
    const file = join(ud, DB_FILE);
    seedDb(file);
    {
      const { db } = openDbSafe(ud);
      await backupDb(db, ud, { now: at("2026-10-25T09:00:00") });
      db.close();
    }
    const dir = join(ud, BACKUP_DIR);
    // Plus recentes que la saine, mais toutes inutilisables.
    copyFileSync(join(dir, "benten-20261025-090000.db"), join(dir, "benten-20261028-090000.db"));
    garbleHeader(join(dir, "benten-20261028-090000.db"));
    writeFileSync(join(dir, "benten-20261029-090000.db"), "");
    const stub = new Database(join(dir, "benten-20261029-100000.db"));
    stub.exec("CREATE TABLE x (y)");
    stub.close();
    garbleHeader(file);

    const { db, recovered } = openDbSafe(ud, { now: at("2026-10-29T13:00:00") });
    expect(recovered!.restoredFrom).toBe(join(dir, "benten-20261025-090000.db"));
    expect(getSources(db)).toHaveLength(1);
    // La verification des sauvegardes ne laisse aucun -wal/-shm orphelin dans db-backups.
    expect(readdirSync(dir).filter((f) => /-(wal|shm)$/.test(f))).toEqual([]);
    db.close();
  });
});

describe("backupDb (sauvegardes quotidiennes)", () => {
  let ud: string;
  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), "benten-dbbak-"));
    seedDb(join(ud, DB_FILE));
  });
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true });
  });

  it("ecrit benten-<YYYYMMDD-HHmmss>.db lisible ; saute si la plus recente a moins de 20 h", async () => {
    const { db } = openDbSafe(ud);
    const dir = join(ud, BACKUP_DIR);
    expect(await backupDb(db, ud, { now: at("2026-10-28T08:00:00") })).toBe(
      join(dir, "benten-20261028-080000.db"),
    );
    expect(await backupDb(db, ud, { now: at("2026-10-29T03:59:00") })).toBeNull(); // 19 h 59
    expect(await backupDb(db, ud, { now: at("2026-10-29T04:01:00") })).toBe(
      join(dir, "benten-20261029-040100.db"),
    ); // 20 h 01
    expect(readdirSync(dir).sort()).toEqual(["benten-20261028-080000.db", "benten-20261029-040100.db"]);
    const copy = openDb(join(dir, "benten-20261029-040100.db"));
    expect(getSources(copy)).toHaveLength(1);
    copy.close();
    db.close();
  });

  it("elague selon la retention et les orphelins -wal/-shm, sans toucher aux fichiers etrangers", async () => {
    const { db } = openDbSafe(ud);
    const dir = join(ud, BACKUP_DIR);
    mkdirSync(dir, { recursive: true });
    for (let d = 10; d <= 20; d++) {
      writeFileSync(join(dir, `benten-202610${d}-080000.db`), "old");
    }
    writeFileSync(join(dir, "benten-20261015-080000.db-wal"), "orphan");
    writeFileSync(join(dir, "benten-20261015-080000.db-shm"), "orphan");
    writeFileSync(join(dir, "notes.txt"), "keep");
    writeFileSync(join(dir, "benten-old.db"), "keep");
    writeFileSync(join(dir, "benten-20200101-000000.db.bak"), "keep");

    await backupDb(db, ud, { now: at("2026-10-21T09:00:00") });
    expect(readdirSync(dir).sort()).toEqual(
      [
        // 3 plus recentes + une par jour sur 7 jours (15..21).
        "benten-20261015-080000.db",
        "benten-20261016-080000.db",
        "benten-20261017-080000.db",
        "benten-20261018-080000.db",
        "benten-20261019-080000.db",
        "benten-20261020-080000.db",
        "benten-20261021-090000.db",
        "benten-old.db",
        "benten-20200101-000000.db.bak",
        "notes.txt",
      ].sort(),
    );
    db.close();
  });

  it("ne rejette jamais (dossier impossible a creer)", async () => {
    const { db } = openDbSafe(ud);
    writeFileSync(join(ud, "blocker"), "x");
    await expect(backupDb(db, join(ud, "blocker"))).resolves.toBeNull();
    db.close();
  });
});

describe("backupsToDelete (retention : 3 dernieres + une par jour sur 7 jours)", () => {
  it("garde les 3 plus recentes et la plus recente de chacun des 7 derniers jours", () => {
    const names: string[] = [];
    for (let d = 1; d <= 10; d++) names.push(`benten-202611${String(d).padStart(2, "0")}-080000.db`);
    names.push("benten-20261110-070000.db", "benten-20261109-070000.db");
    names.push("notes.txt", "benten-x.db");
    const del = backupsToDelete(names, new Date("2026-11-10T12:00:00"));
    expect(del.sort()).toEqual(
      [
        "benten-20261101-080000.db",
        "benten-20261102-080000.db",
        "benten-20261103-080000.db",
        "benten-20261109-070000.db",
      ].sort(),
    );
  });

  it("au plus 3 sauvegardes le meme jour sont gardees (les plus recentes)", () => {
    const names = ["080000", "090000", "100000", "110000", "120000"].map((t) => `benten-20261110-${t}.db`);
    const del = backupsToDelete(names, new Date("2026-11-10T13:00:00"));
    expect(del.sort()).toEqual(["benten-20261110-080000.db", "benten-20261110-090000.db"]);
  });
});

describe("wireDbClose (fermeture ordonnee)", () => {
  it("ferme la base une seule fois, sur will-quit ou session-end (fermeture de session Windows)", () => {
    for (const first of ["will-quit", "session-end"]) {
      const app = new EventEmitter();
      const db = { close: vi.fn() };
      wireDbClose(app, db);
      app.emit(first);
      app.emit("will-quit");
      app.emit("session-end");
      expect(db.close).toHaveBeenCalledTimes(1);
    }
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
