import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { enforceSingleInstance, focusWindow, reportFatalStartup } from "../src/main/instance";

/** Faux `app` : verrou d'instance unique pilotable + emetteur d'evenements. */
function fakeApp(gotLock: boolean) {
  return Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn(() => gotLock),
    quit: vi.fn(),
    exit: vi.fn(),
  });
}

function fakeWindow(minimized: boolean) {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe("enforceSingleInstance", () => {
  it("verrou non obtenu : quitte et renvoie false (la 2e instance ne touche a rien)", () => {
    const app = fakeApp(false);
    const onSecond = vi.fn();
    expect(enforceSingleInstance(app, onSecond)).toBe(false);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.listenerCount("second-instance")).toBe(0);
  });

  it("verrou obtenu : renvoie true et rappelle onSecondInstance a chaque second lancement", () => {
    const app = fakeApp(true);
    const onSecond = vi.fn();
    expect(enforceSingleInstance(app, onSecond)).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    app.emit("second-instance", {}, ["benten.exe"], "C:\\");
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it("un rappel qui leve n'est pas propage", () => {
    const app = fakeApp(true);
    enforceSingleInstance(app, () => {
      throw new Error("boom");
    });
    expect(() => app.emit("second-instance")).not.toThrow();
  });
});

describe("focusWindow", () => {
  it("restaure une fenetre reduite, l'affiche et lui donne le focus", () => {
    const w = fakeWindow(true);
    focusWindow(w);
    expect(w.restore).toHaveBeenCalled();
    expect(w.show).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
  });

  it("fenetre non reduite : pas de restore ; aucune fenetre : sans effet", () => {
    const w = fakeWindow(false);
    focusWindow(w);
    expect(w.restore).not.toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
    expect(() => focusWindow(null)).not.toThrow();
  });
});

describe("reportFatalStartup", () => {
  it("affiche un message clair en francais avec le chemin du journal, puis app.exit(1)", () => {
    const app = fakeApp(true);
    const dialog = { showErrorBox: vi.fn() };
    reportFatalStartup(
      { app, dialog },
      new Error("ENOSPC: no space left on device"),
      "C:\\Users\\x\\AppData\\Roaming\\Benten\\logs\\audio-journal.log",
    );
    expect(dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = dialog.showErrorBox.mock.calls[0]! as [string, string];
    expect(title).toMatch(/Benten/);
    expect(body).toMatch(/bibliothèque/);
    expect(body).toContain("ENOSPC");
    expect(body).toContain("audio-journal.log");
    expect(app.exit).toHaveBeenCalledWith(1);
  });

  it("app.exit(1) meme si la boite de dialogue echoue", () => {
    const app = fakeApp(true);
    const dialog = {
      showErrorBox: () => {
        throw new Error("no display");
      },
    };
    expect(() => reportFatalStartup({ app, dialog }, "x", "log")).not.toThrow();
    expect(app.exit).toHaveBeenCalledWith(1);
  });
});
