// Fenêtre d'aperçu vivant de l'app mobile, sur le PC.
//
// Elle charge le prototype HTML au format téléphone et lui passe l'adresse du serveur local
// ainsi que le jeton réel, pour que la bibliothèque affichée soit la vraie et que la musique
// joue vraiment.
//
// CommonJS : l'API principale d'Electron n'expose pas de module ESM nommé dans cette version.
const { app, BrowserWindow } = require("electron");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const HOST = "http://127.0.0.1:4321";
const tokenFile = join(app.getPath("appData"), "benten", "mobile-token.txt");
const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 380,
    minHeight: 700,
    backgroundColor: "#0a0908",
    autoHideMenuBar: true,
    title: "Benten — aperçu vivant",
    webPreferences: {
      // Le prototype interroge le serveur local en http : même politique que l'app.
      webSecurity: false,
    },
  });

  const url = `file://${join(__dirname, "index.html").replace(/\\/g, "/")}?host=${encodeURIComponent(HOST)}&token=${encodeURIComponent(token)}`;
  await win.loadURL(url);
  console.log(`aperçu : ${win.getBounds().width}x${win.getBounds().height}, jeton ${token.length} caractères`);
});
