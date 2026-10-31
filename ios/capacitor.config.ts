import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Configuration de l'enveloppe iOS.
 *
 * `webDir: "../mobile"` : Capacitor COPIE la page mobile existante dans l'app native. Il n'y a donc
 * qu'une seule base de code pour le téléphone — la PWA installable et l'app `.ipa` partagent
 * exactement le même HTML/CSS/JS.
 *
 * `server.iosScheme: "capacitor"` : origine interne stable, ce qui permet à IndexedDB et au service
 * worker de fonctionner comme sur le web.
 */
const config: CapacitorConfig = {
  appId: "com.benten.player",
  appName: "Benten",
  webDir: "../mobile",
  ios: {
    contentInset: "always",
    backgroundColor: "#0a0908",
  },
};

export default config;
