import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { createReadStream as openAudio } from "node:fs";
import { isValidToken } from "./library/mobileToken";

/**
 * Serveur de l'app mobile, sur le réseau local.
 *
 * But : installer Benten sur l'iPhone. iOS n'accepte d'installer une app web que depuis une origine
 * « sûre » (HTTPS ou localhost) ; en pratique, ouvrir `http://<ip-du-pc>:4321` depuis Safari sur le
 * même Wi-Fi fonctionne, puis « Partager ▸ Sur l'écran d'accueil ». Une fois installée, le service
 * worker la rend autonome : plus besoin du PC.
 *
 * Ce serveur ne sert QUE les fichiers de `mobile/` — aucune route vers la bibliothèque, la base ni
 * les fichiers audio de l'ordinateur. Rien du PC n'est exposé au réseau.
 */

const PORT = 4321;
const ROOT = join(__dirname, "..", "..", "mobile");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

let server: Server | null = null;

/**
 * Source de la bibliothèque pour la synchronisation : renvoie les morceaux indexés (identifiant,
 * titre, artiste, durée, chemin). Branché par le Main après ouverture de la base — le serveur ne
 * connaît pas SQLite, il ne fait que transporter.
 */
export interface MobileLibraryApi {
  list(): { id: number; title: string; artist: string; album: string; durationSec: number; path: string }[];
}

let libraryApi: MobileLibraryApi | null = null;

/** Branche la bibliothèque (appelé une fois la base ouverte). */
export function bindMobileLibrary(api: MobileLibraryApi): void {
  libraryApi = api;
}

/** Adresse IPv4 de la machine sur le réseau local, ou `null` si aucune interface active. */
export function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** URL à ouvrir depuis le téléphone, ou `null` si le serveur n'est pas actif. */
export function mobileUrl(): string | null {
  if (!server) return null;
  const host = lanAddress();
  return host ? `http://${host}:${PORT}/` : `http://localhost:${PORT}/`;
}

/**
 * Démarre le serveur (idempotent). Ne lève jamais : si le port est pris, l'app continue sans
 * fonction mobile plutôt que d'échouer au démarrage.
 */
export function startMobileServer(): void {
  if (server) return;
  if (!existsSync(ROOT)) {
    console.warn(`[mobile] dossier introuvable : ${ROOT}`);
    return;
  }
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const rawPath = url.pathname;

    // --- API de synchronisation (jeton obligatoire) -------------------------------------------
    // Sans jeton, n'importe qui sur le Wi-Fi pourrait aspirer la bibliothèque : il est exigé sur
    // chaque requête et comparé à temps constant.
    if (rawPath === "/api/library" || rawPath.startsWith("/api/audio/")) {
      if (!isValidToken(url.searchParams.get("token"))) {
        response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "jeton invalide" }));
        return;
      }
      if (rawPath === "/api/library") {
        let source: ReturnType<NonNullable<typeof libraryApi>["list"]> = [];
        try {
          source = libraryApi?.list() ?? [];
        } catch (error) {
          // Une erreur de requête ne doit JAMAIS laisser la requête pendre : on répond 500.
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : "erreur" }));
          return;
        }
        const items = source.map(({ path, ...rest }) => ({
          ...rest,
          // L'URL de téléchargement est fournie prête à l'emploi : le téléphone n'a rien à deviner.
          audio: `/api/audio/${rest.id}?token=${url.searchParams.get("token")}`,
        }));
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ tracks: items }));
        return;
      }
      const id = Number(rawPath.slice("/api/audio/".length));
      const track = (libraryApi?.list() ?? []).find((item) => item.id === id);
      if (!track || !existsSync(track.path)) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "morceau introuvable" }));
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(statSync(track.path).size),
        "cache-control": "no-store",
      });
      openAudio(track.path).pipe(response);
      return;
    }

    // `normalize` + préfixe obligatoire : aucune remontée hors de `mobile/`.
    const rel = normalize(decodeURIComponent(rawPath === "/" ? "/index.html" : rawPath)).replace(/^([/\\])+/, "");
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("introuvable");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      // Le service worker exige des réponses fraîches pour se mettre à jour.
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(response);
  });
  server.on("error", (error) => {
    console.warn(`[mobile] serveur indisponible : ${error.message}`);
    server = null;
  });
  server.listen(PORT, () => {
    console.log(`[mobile] prêt sur ${mobileUrl()}`);
  });
}

/** Arrête le serveur (fermeture de l'app). */
export function stopMobileServer(): void {
  server?.close();
  server = null;
}



