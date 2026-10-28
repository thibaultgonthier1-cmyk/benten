import { execFileSync } from "node:child_process";

/**
 * Peripherique de sortie audio par defaut, vu depuis le process Main.
 *
 * v1 est INFORMATIF : on expose le NOM du peripherique detecte (et sa frequence si on l'obtient
 * sans risque). On ne pilote PAS la sortie (pas de bit-perfect / WASAPI exclusif — Phase 2) : le
 * graphe Web Audio du Renderer suit la frequence par defaut negociee par Chromium avec l'OS.
 */
export interface OutputDevice {
  /** Nom lisible du peripherique (toujours non vide : repli nomme si l'enumeration echoue). */
  name: string;
  /** Frequence d'echantillonnage de la sortie en Hz, si disponible. */
  sampleRate?: number;
}

/** Repli nomme, renvoye quand l'OS ne nous donne rien (jamais d'exception vers l'appelant). */
const FALLBACK: OutputDevice = { name: "Sortie systeme par defaut" };

/**
 * Meilleur effort : nom convivial d'un peripherique de rendu audio actif sous Windows, via une
 * breve requete CIM PowerShell. Borne dans le temps, sortie masquee, et TOUT est avale : la
 * fonction renvoie `null` plutot que de lever.
 */
function queryWindowsDeviceName(): string | null {
  try {
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      "(Get-CimInstance Win32_SoundDevice |" +
      " Where-Object { $_.Status -eq 'OK' } |" +
      " Select-Object -First 1 -ExpandProperty Name)";
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 2500, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const name = out.split(/\r?\n/)[0]?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Peripherique de sortie par defaut. Ne leve JAMAIS : en cas d'indisponibilite (plateforme non
 * geree, enumeration en echec, timeout), renvoie un repli nomme. `sampleRate` reste absent tant
 * qu'on ne peut pas l'obtenir de facon fiable sans dependance supplementaire.
 */
export function defaultOutputDevice(): OutputDevice {
  try {
    if (process.platform === "win32") {
      const name = queryWindowsDeviceName();
      if (name) return { name };
    }
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}
