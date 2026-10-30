/**
 * Copie `build/icon.ico` dans `out/` après la compilation.
 *
 * Le processus principal charge l'icône depuis `out/icon.ico` (chemin résolu à côté du main compilé).
 * Sans cette copie, la fenêtre et la barre des tâches affichent l'icône Electron générique — l'app
 * paraît « neutre », non officielle.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "build", "icon.ico");
const target = join(root, "out", "icon.ico");

if (!existsSync(source)) {
  console.warn("[icone] build/icon.ico introuvable — la fenetre restera sans icone");
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log("[icone] out/icon.ico copiee");
