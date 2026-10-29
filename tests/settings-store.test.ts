import { describe, it, expect } from "vitest";
import {
  createSettingsStore,
  settingsStore,
  serializeSettings,
  restoreSettings,
  DEFAULT_SETTINGS,
} from "../src/renderer/state/settings";

describe("restoreSettings", () => {
  it("assainit des valeurs invalides vers les défauts", () => {
    expect(restoreSettings('{"motionIntensity":"bogus","showIntro":"x"}')).toEqual({
      motionIntensity: "full",
      showIntro: true,
      groupVersions: true,
    });
  });

  it("JSON invalide → défauts, sans lever", () => {
    expect(restoreSettings("{bad")).toEqual({ motionIntensity: "full", showIntro: true, groupVersions: true });
    expect(restoreSettings("")).toEqual(DEFAULT_SETTINGS);
    expect(restoreSettings("null")).toEqual(DEFAULT_SETTINGS);
    expect(restoreSettings("[1,2]")).toEqual(DEFAULT_SETTINGS);
  });

  it("conserve les valeurs valides", () => {
    expect(restoreSettings('{"motionIntensity":"reduced","showIntro":false}')).toEqual({
      motionIntensity: "reduced",
      showIntro: false,
      groupVersions: true,
    });
  });

  it("aller-retour serialize → restore identique", () => {
    const s = { motionIntensity: "subtle" as const, showIntro: false, groupVersions: false };
    expect(restoreSettings(serializeSettings(s))).toEqual(s);
  });

  it("serializeSettings ne garde que les champs persistés", () => {
    const store = createSettingsStore();
    expect(JSON.parse(serializeSettings(store.getState()))).toEqual(DEFAULT_SETTINGS);
  });
});

describe("groupVersions (Tâche 7)", () => {
  it("défaut true, y compris quand la clé est absente d'un JSON plus ancien", () => {
    expect(DEFAULT_SETTINGS.groupVersions).toBe(true);
    expect(restoreSettings('{"motionIntensity":"subtle","showIntro":false}').groupVersions).toBe(true);
    expect(restoreSettings('{"groupVersions":"no"}').groupVersions).toBe(true);
  });

  it("sérialisé avec les autres réglages et restauré (aller-retour)", () => {
    const s = { motionIntensity: "full" as const, showIntro: true, groupVersions: false };
    expect(JSON.parse(serializeSettings(s))).toEqual(s);
    expect(restoreSettings(serializeSettings(s)).groupVersions).toBe(false);
  });

  it("setGroupVersions met à jour l'état et persiste", () => {
    const writes: string[] = [];
    const store = createSettingsStore(() => ({
      get: async () => undefined,
      set: async (_k: string, v: string) => {
        writes.push(v);
      },
    }));
    expect(store.getState().groupVersions).toBe(true);
    store.getState().setGroupVersions(false);
    expect(store.getState().groupVersions).toBe(false);
    expect(JSON.parse(writes.at(-1)!).groupVersions).toBe(false);
  });
});

describe("settings store (hors fenêtre)", () => {
  it("état initial par défaut", () => {
    const s = createSettingsStore().getState();
    expect(s.motionIntensity).toBe("full");
    expect(s.showIntro).toBe(true);
  });

  it("setMotionIntensity met à jour l'état sans window", () => {
    const store = createSettingsStore();
    store.getState().setMotionIntensity("subtle");
    expect(store.getState().motionIntensity).toBe("subtle");
  });

  it("setShowIntro met à jour l'état sans window", () => {
    const store = createSettingsStore();
    store.getState().setShowIntro(false);
    expect(store.getState().showIntro).toBe(false);
  });

  it("load() est un no-op hors fenêtre", async () => {
    const store = createSettingsStore();
    await expect(store.getState().load()).resolves.toBeUndefined();
    expect(store.getState().motionIntensity).toBe("full");
  });

  it("le singleton settingsStore est utilisable sans window", () => {
    settingsStore.getState().setMotionIntensity("reduced");
    expect(settingsStore.getState().motionIntensity).toBe("reduced");
    settingsStore.getState().setMotionIntensity("full");
  });
});

describe("settings store (persistance via api injectée)", () => {
  it("load() lit la clé settings puis chaque changement est persisté", async () => {
    const writes: Array<[string, string]> = [];
    const reads: string[] = [];
    const api = {
      async get(key: string) {
        reads.push(key);
        return '{"motionIntensity":"subtle","showIntro":false}';
      },
      async set(key: string, value: string) {
        writes.push([key, value]);
      },
    };
    const store = createSettingsStore(() => api);
    await store.getState().load();
    expect(reads).toEqual(["settings"]);
    expect(store.getState().motionIntensity).toBe("subtle");
    expect(store.getState().showIntro).toBe(false);
    // Le chargement lui-même ne réécrit pas la valeur lue.
    expect(writes).toEqual([]);

    store.getState().setMotionIntensity("reduced");
    expect(writes.at(-1)).toEqual([
      "settings",
      '{"motionIntensity":"reduced","showIntro":false,"groupVersions":true}',
    ]);
    store.getState().setShowIntro(true);
    expect(writes.at(-1)).toEqual([
      "settings",
      '{"motionIntensity":"reduced","showIntro":true,"groupVersions":true}',
    ]);
  });

  it("load() tolère un échec de lecture et une valeur absente", async () => {
    const failing = createSettingsStore(() => ({
      get: async () => {
        throw new Error("ipc down");
      },
      set: async () => {},
    }));
    await expect(failing.getState().load()).resolves.toBeUndefined();
    expect(failing.getState().motionIntensity).toBe("full");

    const empty = createSettingsStore(() => ({ get: async () => undefined, set: async () => {} }));
    await empty.getState().load();
    expect(empty.getState().showIntro).toBe(true);
  });

  it("un échec d'écriture ne lève pas", () => {
    const store = createSettingsStore(() => ({
      get: async () => undefined,
      set: () => Promise.reject(new Error("disk full")),
    }));
    expect(() => store.getState().setMotionIntensity("subtle")).not.toThrow();
    expect(store.getState().motionIntensity).toBe("subtle");
  });
});
