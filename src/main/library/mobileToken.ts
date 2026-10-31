import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Synchronisation téléphone ↔ PC.
 *
 * La page mobile peut demander au PC la liste de sa bibliothèque et télécharger les morceaux qui
 * manquent sur le téléphone. C'est ce qui permet d'importer de la musique « depuis ailleurs » : le
 * PC télécharge (yt-dlp / Apple), le téléphone récupère.
 *
 * SÉCURITÉ — un jeton aléatoire, stocké dans les données de l'app, est exigé sur CHAQUE requête.
 * Sans lui, n'importe qui sur le même Wi-Fi pourrait aspirer la bibliothèque. Le jeton est affiché
 * dans Réglages, à côté de l'adresse, pour être saisi une fois sur le téléphone.
 */

const TOKEN_FILE = "mobile-token.txt";

/** Jeton stable pour cette installation (créé au premier lancement). */
export function ensureMobileToken(userData: string): string {
  const file = join(userData, TOKEN_FILE);
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing.length >= 16) return existing;
    }
  } catch {
    /* fichier illisible : on en régénère un */
  }
  const token = randomBytes(18).toString("hex");
  try {
    writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* écriture impossible : le jeton reste en mémoire pour cette session */
  }
  return token;
}

let currentToken: string | null = null;

export function setMobileToken(token: string): void {
  currentToken = token;
}

export function mobileToken(): string | null {
  return currentToken;
}

/** Comparaison à temps constant : un jeton ne doit pas pouvoir être deviné par timing. */
export function isValidToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || currentToken === null) return false;
  if (candidate.length !== currentToken.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ currentToken.charCodeAt(i);
  }
  return diff === 0;
}
