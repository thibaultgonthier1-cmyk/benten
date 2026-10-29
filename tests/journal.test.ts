import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

import { registerDiagnosticsIpc } from "../src/main/ipc";
import {
  attachMainJournal,
  createJournalWriter,
  validateDiagEntries,
  watchWindowJournal,
  JOURNAL_FILE,
  JOURNAL_OLD_FILE,
} from "../src/main/journal";
import { CHANNELS } from "../src/shared/channels";
import type { DiagEntry } from "../src/shared/diagnostics";

const INDEX_URL = pathToFileURL(join(__dirname, "..", "src", "renderer", "index.html")).href;
const trusted = { senderFrame: { url: INDEX_URL } };
const evil = { senderFrame: { url: "https://evil.example/x.html" } };

// `kind` volontairement libre (les tests de validation envoient des genres inconnus).
const entry = (kind: string, extra: Record<string, unknown> = {}): DiagEntry =>
  ({ t: "2026-10-29T12:00:00.000Z", kind, ...extra }) as DiagEntry;

const readLines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("validateDiagEntries (validation stricte du payload)", () => {
  it("accepte un tableau d'entrees connues", () => {
    const ok = [entry("glitch", { lostMs: 30, count: 1 }), entry("engine", { from: "a", to: "b" })];
    expect(validateDiagEntries(ok)).toEqual(ok);
    expect(validateDiagEntries([])).toEqual([]);
  });

  it("rejette un non-tableau", () => {
    for (const bad of [null, undefined, 42, "x", { kind: "glitch" }]) {
      expect(() => validateDiagEntries(bad)).toThrow(/diagnostics:append/);
    }
  });

  it("rejette plus de 200 entrees", () => {
    const many = Array.from({ length: 201 }, () => entry("engine"));
    expect(() => validateDiagEntries(many)).toThrow(/200/);
    expect(validateDiagEntries(many.slice(0, 200))).toHaveLength(200);
  });

  it("rejette un kind inconnu ou reserve au Main, une entree non objet ou sans horodatage", () => {
    expect(() => validateDiagEntries([entry("nope")])).toThrow(/kind/);
    expect(() => validateDiagEntries([entry("process")])).toThrow(/kind/);
    expect(() => validateDiagEntries([42])).toThrow(/diagnostics:append/);
    expect(() => validateDiagEntries([null])).toThrow(/diagnostics:append/);
    expect(() => validateDiagEntries([[1, 2]])).toThrow(/diagnostics:append/);
    expect(() => validateDiagEntries([{ kind: "glitch" }])).toThrow(/t/);
  });

  it("rejette une entree de plus de 2 Ko serialisee", () => {
    expect(() => validateDiagEntries([entry("engine", { pad: "x".repeat(2100) })])).toThrow(/2/);
    expect(validateDiagEntries([entry("engine", { pad: "x".repeat(1900) })])).toHaveLength(1);
  });

  it("rejette une entree non serialisable (cycle)", () => {
    const cyc: Record<string, unknown> = entry("engine");
    cyc["self"] = cyc;
    expect(() => validateDiagEntries([cyc])).toThrow(/diagnostics:append/);
  });
});

describe("createJournalWriter (fichier + rotation)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "benten-journal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("cree le dossier et ajoute une ligne JSON par entree", async () => {
    const logs = join(dir, "logs");
    const w = createJournalWriter(logs);
    await w.append([entry("session", { sampleRate: 48000 }), entry("engine")]);
    await w.append([entry("glitch", { lostMs: 30 })]);
    const lines = readLines(join(logs, JOURNAL_FILE));
    expect(lines.map((l) => l.kind)).toEqual(["session", "engine", "glitch"]);
  });

  it("log() horodate une entree du Main", async () => {
    const w = createJournalWriter(dir);
    await w.log({ kind: "power", event: "suspend" });
    const [l] = readLines(join(dir, JOURNAL_FILE));
    expect(l!.kind).toBe("power");
    expect(typeof l!.t).toBe("string");
  });

  it("rotation : au-dela de 1 Mo, renomme en audio-journal.1.log (un seul ancien conserve)", async () => {
    const w = createJournalWriter(dir, { maxBytes: 1024 * 1024 });
    const big = "x".repeat(1500);
    // ~1,1 Mo d'entrees : la rotation doit avoir eu lieu.
    for (let i = 0; i < 7; i++) {
      await w.append(Array.from({ length: 100 }, (_, j) => entry("engine", { i, j, pad: big })));
    }
    const cur = join(dir, JOURNAL_FILE);
    const old = join(dir, JOURNAL_OLD_FILE);
    expect(existsSync(old)).toBe(true);
    expect(statSync(cur).size).toBeLessThanOrEqual(1024 * 1024);
    expect(statSync(old).size).toBeLessThanOrEqual(1024 * 1024);
    // Nouvelle rotation : l'ancien est remplace (un seul conserve), aucun autre fichier cree.
    for (let i = 0; i < 7; i++) {
      await w.append(Array.from({ length: 100 }, (_, j) => entry("engine", { i, j, pad: big })));
    }
    expect(readdirSync(dir).sort()).toEqual([JOURNAL_OLD_FILE, JOURNAL_FILE].sort());
  });

  it("rotation sur un petit plafond (injecte) : le fichier courant repart vide", async () => {
    const w = createJournalWriter(dir, { maxBytes: 200 });
    await w.append([entry("engine", { pad: "a".repeat(120) })]);
    await w.append([entry("engine", { pad: "b".repeat(120) })]);
    const old = readLines(join(dir, JOURNAL_OLD_FILE));
    const cur = readLines(join(dir, JOURNAL_FILE));
    expect(String(old[0]!.pad).startsWith("a")).toBe(true);
    expect(cur).toHaveLength(1);
    expect(String(cur[0]!.pad).startsWith("b")).toBe(true);
  });

  it("logSync : ecriture DURABLE immediate (lisible sans attendre), jamais de levee", () => {
    const logs = join(dir, "logs");
    const w = createJournalWriter(logs);
    w.logSync({ kind: "process", event: "db", action: "fatal", reason: "boom" });
    // Aucun await : la ligne est deja sur disque (app.exit(1) peut suivre immediatement).
    const [l] = readLines(join(logs, JOURNAL_FILE));
    expect(l).toMatchObject({ kind: "process", event: "db", action: "fatal", reason: "boom" });
    expect(typeof l!.t).toBe("string");
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "x");
    expect(() => createJournalWriter(join(blocker, "logs")).logSync({ kind: "power", event: "x" })).not.toThrow();
  });

  it("une erreur d'ecriture n'est jamais propagee", async () => {
    // Un FICHIER a la place du dossier de logs : mkdir/append echouent.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "x");
    const w = createJournalWriter(join(blocker, "logs"));
    await expect(w.append([entry("engine")])).resolves.toBeUndefined();
  });
});

describe("registerDiagnosticsIpc (canal diagnostics:append)", () => {
  let dir: string;
  beforeEach(() => {
    handlers.clear();
    delete process.env["ELECTRON_RENDERER_URL"];
    dir = mkdtempSync(join(tmpdir(), "benten-diag-ipc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (event: unknown, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(CHANNELS.DIAGNOSTICS_APPEND)!(event, ...args));

  it("ecrit les entrees valides, enrichit 'session' de la version de l'app", async () => {
    const w = createJournalWriter(dir);
    registerDiagnosticsIpc(w, { appVersion: "9.9.9", electron: "45.1.0", chrome: "140" });
    expect([...handlers.keys()]).toEqual([CHANNELS.DIAGNOSTICS_APPEND]);
    await call(trusted, [entry("session", { sampleRate: 48000 }), entry("glitch", { lostMs: 12 })]);
    const lines = readLines(join(dir, JOURNAL_FILE));
    expect(lines[0]).toMatchObject({ kind: "session", sampleRate: 48000, appVersion: "9.9.9", electron: "45.1.0" });
    expect(lines[1]).toMatchObject({ kind: "glitch", lostMs: 12 });
  });

  it("refuse un expediteur non fiable et un payload invalide, sans rien ecrire", async () => {
    const w = createJournalWriter(dir);
    registerDiagnosticsIpc(w, { appVersion: "1" });
    await expect(call(evil, [entry("glitch")])).rejects.toThrow(/untrusted sender/);
    await expect(call(trusted, "nope")).rejects.toThrow(/diagnostics:append/);
    await expect(call(trusted, [entry("bogus")])).rejects.toThrow(/kind/);
    expect(existsSync(join(dir, JOURNAL_FILE))).toBe(false);
  });
});

describe("attachMainJournal / watchWindowJournal (evenements processus)", () => {
  it("journalise child-process-gone, render-process-gone, suspend/resume, unresponsive/responsive", () => {
    const app = new EventEmitter();
    const power = new EventEmitter();
    const win = new EventEmitter();
    const logged: Record<string, unknown>[] = [];
    const log = (e: Record<string, unknown>) => {
      logged.push(e);
    };
    attachMainJournal({ app, powerMonitor: power, log });
    watchWindowJournal(win, log);

    app.emit("child-process-gone", {}, {
      type: "Utility",
      serviceName: "audio.mojom.AudioService",
      name: "Audio Service",
      reason: "crashed",
      exitCode: -1073741819,
    });
    app.emit("render-process-gone", {}, {}, { reason: "oom", exitCode: 1 });
    power.emit("suspend");
    power.emit("resume");
    win.emit("unresponsive");
    win.emit("responsive");

    expect(logged).toEqual([
      {
        kind: "process",
        event: "child-process-gone",
        type: "Utility",
        serviceName: "audio.mojom.AudioService",
        name: "Audio Service",
        reason: "crashed",
        exitCode: -1073741819,
      },
      { kind: "process", event: "render-process-gone", reason: "oom", exitCode: 1 },
      { kind: "power", event: "suspend" },
      { kind: "power", event: "resume" },
      { kind: "process", event: "window-unresponsive" },
      { kind: "process", event: "window-responsive" },
    ]);
  });

  it("un log qui leve n'est jamais propage aux emetteurs", () => {
    const app = new EventEmitter();
    const power = new EventEmitter();
    attachMainJournal({
      app,
      powerMonitor: power,
      log: () => {
        throw new Error("disk full");
      },
    });
    expect(() => app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 1 })).not.toThrow();
    expect(() => power.emit("resume")).not.toThrow();
  });
});
