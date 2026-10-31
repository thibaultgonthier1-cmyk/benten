/* Service worker : rend Benten Mobile disponible HORS-LIGNE.
   Stratégie « cache d'abord » sur les fichiers de l'app (ils ne changent pas sans redéploiement) :
   une fois installée sur l'écran d'accueil, l'app s'ouvre sans réseau, donc sans PC allumé. */
const CACHE = "benten-mobile-v9"; // incrémenter à CHAQUE mise à jour de l'app mobile
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match("./index.html"));
    }),
  );
});








