/**
 * Tamponne l'exécutable installé : icône, nom de produit, description, version.
 *
 * Pourquoi : une app Electron dont l'exe n'a ni icône ni métadonnées apparaît comme « Electron »
 * dans l'Explorateur, la barre des tâches et le Gestionnaire de tâches — elle a l'air d'un
 * prototype, pas d'une application. `electron-builder` fait ça normalement, mais il est bloqué sur
 * cette machine (privilège de lien symbolique Windows) ; `rcedit` fait le travail seul.
 *
 * Usage : node scripts/stamp-exe.mjs [chemin-de-l-exe]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = process.argv[2] ?? join(process.env.LOCALAPPDATA ?? "", "Programs", "Benten", "Benten.exe");
const icon = join(root, "build", "icon.ico");
const candidates = [
  join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "winCodeSign"),
];
const version = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], { cwd: root }).toString()).version;

function findRcedit() {
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    for (const entry of (execFileSync("cmd", ["/c", "dir", "/b", "/s", `${base}\\rcedit-x64.exe`], { encoding: "utf8" }) ?? "").split(/\r?\n/)) {
      if (entry.trim().toLowerCase().endsWith("rcedit-x64.exe")) return entry.trim();
    }
  }
  return null;
}

if (!existsSync(exe)) {
  console.warn(`[tampon] exe introuvable : ${exe}`);
  process.exit(0);
}
const rcedit = findRcedit();
if (!rcedit) {
  console.warn("[tampon] rcedit introuvable — l'exe garde son icone par defaut");
  process.exit(0);
}

execFileSync(rcedit, [
  exe,
  "--set-icon", icon,
  "--set-file-version", version,
  "--set-product-version", version,
  "--set-version-string", "ProductName", "Benten",
  "--set-version-string", "FileDescription", "Benten — lecteur de musique local",
  "--set-version-string", "CompanyName", "Benten",
  "--set-version-string", "LegalCopyright", "Benten",
]);
console.log(`[tampon] ${exe} : icone et metadonnees appliquees (${version})`);
