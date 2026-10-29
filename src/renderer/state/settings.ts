import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { MotionIntensity } from "../theme/ds/motion";

/**
 * Réglages d'interface (Phase 3) : intensité du mouvement et affichage de l'intro au lancement.
 *
 * Persistés dans le magasin clé/valeur `app_state` (IPC `window.benten.state`) sous la clé
 * `"settings"`, en JSON. Chaque changement est écrit aussitôt (best-effort, jamais bloquant) ;
 * `load()` amorce l'état au lancement. Hors fenêtre (tests node), le store fonctionne en mémoire
 * pure : `load()` est un no-op et aucune écriture n'est tentée.
 */

export const SETTINGS_KEY = "settings";

/** Champs persistés. */
export interface PersistedSettings {
  motionIntensity: MotionIntensity;
  showIntro: boolean;
}

export const DEFAULT_SETTINGS: Readonly<PersistedSettings> = Object.freeze({
  motionIntensity: "full",
  showIntro: true,
});

export interface SettingsState extends PersistedSettings {
  setMotionIntensity(intensity: MotionIntensity): void;
  setShowIntro(show: boolean): void;
  /** Lit la clé `"settings"` d'`app_state` et l'applique (no-op hors fenêtre, ne lève jamais). */
  load(): Promise<void>;
}

/** Sous-ensemble de l'API IPC `state` dont le store a besoin (injectable pour les tests). */
export interface SettingsStateApi {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const INTENSITIES: readonly MotionIntensity[] = ["full", "subtle", "reduced"];

const isIntensity = (v: unknown): v is MotionIntensity =>
  typeof v === "string" && (INTENSITIES as readonly string[]).includes(v);

/** Sérialise uniquement les champs persistés (ordre de clés stable). */
export function serializeSettings(s: PersistedSettings): string {
  return JSON.stringify({ motionIntensity: s.motionIntensity, showIntro: s.showIntro });
}

/**
 * Restaure des réglages depuis leur JSON persisté. Assainit champ par champ (valeur invalide →
 * défaut) et ne lève jamais : JSON corrompu, `null`, tableau ou chaîne vide → défauts.
 */
export function restoreSettings(raw: string): PersistedSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS };
  }
  const o = parsed as Record<string, unknown>;
  return {
    motionIntensity: isIntensity(o.motionIntensity)
      ? o.motionIntensity
      : DEFAULT_SETTINGS.motionIntensity,
    showIntro: typeof o.showIntro === "boolean" ? o.showIntro : DEFAULT_SETTINGS.showIntro,
  };
}

/** Accès défensif à l'IPC : `undefined` hors fenêtre (tests node) ou si le pont est absent. */
function windowStateApi(): SettingsStateApi | undefined {
  return typeof window !== "undefined" ? window.benten?.state : undefined;
}

export type SettingsStore = StoreApi<SettingsState>;

/**
 * Crée un store de réglages indépendant. `getApi` fournit l'API de persistance (par défaut
 * `window.benten.state`, absente en node) ; il est résolu à chaque usage pour suivre le pont.
 */
export function createSettingsStore(
  getApi: () => SettingsStateApi | undefined = windowStateApi,
): SettingsStore {
  // Vrai pendant l'application d'une valeur lue : on ne réécrit pas ce qu'on vient de charger.
  let hydrating = false;

  const store = createStore<SettingsState>((set) => ({
    ...DEFAULT_SETTINGS,

    setMotionIntensity(intensity) {
      if (!isIntensity(intensity)) return;
      set({ motionIntensity: intensity });
    },

    setShowIntro(show) {
      set({ showIntro: show === true });
    },

    async load() {
      const api = getApi();
      if (!api) return;
      let raw: string | undefined;
      try {
        raw = await api.get(SETTINGS_KEY);
      } catch {
        return; // amorçage best-effort : on garde l'état courant.
      }
      if (typeof raw !== "string") return;
      hydrating = true;
      try {
        set(restoreSettings(raw));
      } finally {
        hydrating = false;
      }
    },
  }));

  // Persistance automatique : chaque changement d'un champ persisté est écrit aussitôt.
  store.subscribe((next, prev) => {
    if (hydrating) return;
    if (next.motionIntensity === prev.motionIntensity && next.showIntro === prev.showIntro) return;
    const api = getApi();
    if (!api) return;
    try {
      void api.set(SETTINGS_KEY, serializeSettings(next)).catch(() => {
        /* écriture best-effort : l'état en mémoire reste la vérité de la session. */
      });
    } catch {
      /* pont IPC défaillant : idem. */
    }
  });

  return store;
}

/** Store singleton de l'application. */
export const settingsStore: SettingsStore = createSettingsStore();

/** Hook React sélecteur sur le store singleton. */
export function useSettings<T>(selector: (state: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}
