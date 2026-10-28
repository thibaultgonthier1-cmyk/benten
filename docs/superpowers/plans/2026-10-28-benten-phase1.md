# Benten — Plan d'implémentation, Phase 1 (socle lisible et jouable)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une app Electron qui scanne la vraie bibliothèque FLAC de l'utilisateur, l'indexe en SQLite, l'affiche dans une grille à la DA Benten, et la lit avec un moteur audio fiable et gapless.

**Architecture:** Electron (process Main Node.js + Renderer Chromium) avec pont `contextBridge` typé dans le preload. Le Main possède le disque : scan de dossiers, extraction de métadonnées, index SQLite, cache de pochettes servi par un protocole custom. Le Renderer (React + TS) possède l'UI et le moteur audio Web Audio. La logique testable (schéma/requêtes DB, parsing de métadonnées, machine à états et planification du moteur) est isolée dans des modules purs ; les appels Web Audio réels sont derrière une interface mockable, avec des étapes de vérification manuelle sur fichiers réels là où l'unité ne suffit pas.

**Tech Stack:** electron-vite, Electron, React 18.3.1, TypeScript, better-sqlite3, music-metadata, Zustand, @tanstack/react-virtual, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-benten-design.md` (lire aussi `design/benten-prototype.html` = référence de DA).

## Global Constraints

- **Hors-ligne total** : aucun appel réseau au runtime (pochettes/métadonnées depuis les fichiers uniquement).
- **Thème sombre unique**, pas de thème clair. Accent magenta mat **`#e73c82`** (aplat, jamais dégradé/brillant).
- **DA = portage** de `design/benten-prototype.html` (tokens, typo Shippori Mincho / Zen Kaku Gothic New, SVG torii/soleil, seigaiha, timings). Ne pas réinventer.
- **FLAC d'abord**, décodage **natif** Chromium ; interface `Decoder` extensible mais une seule implémentation native en Phase 1.
- **Gapless vrai** (enchaînement à l'échantillon près) exigé ; **aucun bit-perfect / WASAPI exclusif** en Phase 1.
- **DRM** : `.m4p` et fichiers non décodables → marqués « protégé / non lisible », jamais lus, jamais de son parasite, jamais de crash.
- **Cible Windows** d'abord ; code portable ; pas de `nodeIntegration` dans le Renderer.
- **Bibliothèque réelle de dev** (lecture seule) : `C:\Users\Dream\Downloads\REA DS\.prism-profile\documents\Prism Library` (FLAC 24-bit/44,1 kHz, ~969 titres).
- **Versions** : Node LTS ≥ 20, React `18.3.1`. Chaque dépendance épinglée à une version exacte.
- **Commits** : messages terminés par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **FLAC corrompu / tronqué / extension inconnue dans un dossier scanné** → le scan saute le fichier et continue (Task 4), jamais d'échec global du scan.
- **`.m4p` DRM ou fichier non décodable envoyé en lecture** → le moteur le marque illisible, passe au suivant, sans bruit ni crash (Task 7).
- **Spam suivant/précédent très rapide** → sources en vol annulées proprement, aucune superposition audio, aucun clic (Task 8).
- **Tags manquants/vides ou non-ASCII** (ex. `$lothbaby6`, accents) → repli sur l'arborescence de dossiers pour artiste/album, rendu Unicode correct (Task 5, Task 9).
- **Grande bibliothèque (~1000+ titres)** → liste virtualisée, scan non bloquant pour l'UI, requêtes DB indexées (Task 5, Task 9).

---

## Structure de fichiers (Phase 1)

```
benten/
  package.json, electron.vite.config.ts, tsconfig.json, vitest.config.ts
  src/
    main/
      index.ts                 # entrée Main : fenêtre, cycle de vie, enregistrement IPC + protocole
      ipc.ts                   # enregistrement des handlers ipcMain.handle (noms de canaux)
      library/
        db.ts                  # ouverture SQLite + migrations (schéma)
        repository.ts          # requêtes typées (upsert/lecture) — PUR, testable
        scanner.ts             # parcours récursif + filtrage extensions — PUR (fs injecté)
        metadata.ts            # extraction tags/qualité via music-metadata — testable
        indexer.ts             # scan -> metadata -> repository (orchestration)
        artcache.ts            # extraction + cache vignettes pochettes
      audio/
        devices.ts             # énumération périphériques de sortie (défaut) côté Main
    preload/
      index.ts                 # contextBridge: expose window.benten (API typée)
    shared/
      types.ts                 # types partagés Main/Renderer (Track, Album, Artist, Quality…)
      channels.ts              # constantes de noms de canaux IPC
    renderer/
      index.html, main.tsx, App.tsx
      theme/tokens.css         # tokens DA portés depuis le prototype
      state/player.ts          # store Zustand (état lecture + file)
      audio/
        engine.ts              # moteur Web Audio (graphe, decode, play/seek)
        schedule.ts            # math de planification gapless — PUR, testable
        decoder.ts             # interface Decoder + impl native (decodeAudioData)
      components/
        LibraryGrid.tsx, AlbumCard.tsx, MiniPlayer.tsx, NowPlaying.tsx, QualityBadge.tsx
  tests/                       # miroir vitest des modules purs
  docs/… , design/benten-prototype.html
```

---

### Task 1 : Scaffold Electron + React + TS + lancement

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `.gitignore`, `.claude/launch.json`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: un projet qui démarre via `npm run dev` (fenêtre Electron affichant « Benten »), et `npm test` (Vitest) qui tourne.

- [ ] **Step 1 : Écrire un test de fumée**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from "vitest";
it("charge la config partagée sans erreur", async () => {
  const { CHANNELS } = await import("../src/shared/channels");
  expect(CHANNELS.LIBRARY_QUERY).toBeTypeOf("string");
});
```

- [ ] **Step 2 : Lancer le test, vérifier l'échec** — Run `npm test`. Expected: FAIL (module absent).
- [ ] **Step 3 : Initialiser le projet** avec `electron-vite` (React + TS), React épinglé `18.3.1`, créer `src/shared/channels.ts` exportant `CHANNELS` (objet constant), Main ouvrant une `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`) qui charge le Renderer, `App.tsx` rendant « Benten », et `.claude/launch.json` (name `benten`, `npm run dev`, port du serveur Vite).
- [ ] **Step 4 : Lancer le test, vérifier le succès** — Run `npm test`. Expected: PASS.
- [ ] **Step 5 : Vérifier le lancement** — Run `npm run dev`. Expected: fenêtre affichant « Benten », aucune erreur console.
- [ ] **Step 6 : Commit** — `chore: scaffold electron + react + ts`.

---

### Task 2 : Pont IPC typé (preload ↔ main)

**Files:**
- Create: `src/shared/types.ts`, `src/main/ipc.ts`
- Modify: `src/preload/index.ts`, `src/main/index.ts`
- Test: `tests/channels.test.ts`

**Interfaces:**
- Produces: `window.benten` dans le Renderer avec, pour la Phase 1 : `ping(): Promise<"pong">`, `library.query(args)`, `library.scan(paths)`, `audio.defaultDevice()`. Les types de retour viennent de `shared/types.ts`.
- Consumes: `CHANNELS` (Task 1).

- [ ] **Step 1 : Test** — `tests/channels.test.ts` vérifie que chaque nom de canal est unique et non vide (garde-fou contre collisions).
- [ ] **Step 2 : Échec** — Run `npm test`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** `registerIpc()` dans `ipc.ts` (un `ipcMain.handle(CHANNELS.PING, …)` renvoyant `"pong"`), l'appeler depuis Main, et exposer via `contextBridge.exposeInMainWorld("benten", …)` une API typée (`invoke` enrobé). Déclarer `window.benten` dans `shared/types.ts`.
- [ ] **Step 4 : Succès** — Run `npm test`. Expected: PASS.
- [ ] **Step 5 : Vérifier le pont** — `npm run dev`, dans la console Renderer `await window.benten.ping()` → `"pong"`.
- [ ] **Step 6 : Commit** — `feat: typed ipc bridge`.

---

### Task 3 : Schéma SQLite + repository typé

**Files:**
- Create: `src/main/library/db.ts`, `src/main/library/repository.ts`
- Test: `tests/repository.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): Database` (crée/migre les tables).
  - `upsertTracks(db, tracks: TrackInput[]): void`.
  - `getAlbums(db, { limit, offset }): AlbumRow[]`, `getTracksByAlbum(db, albumId): TrackRow[]`, `getAllTracks(db, { limit, offset }): TrackRow[]`, `getArtists(db): ArtistRow[]`.
  - Types `TrackInput`, `TrackRow`, `AlbumRow`, `ArtistRow` dans `shared/types.ts` (champs : id, path, title, artist, album, trackNo, durationSec, format, sampleRate, bitDepth, playable, artKey).
- Consumes: —

- [ ] **Step 1 : Test** — ouvre une DB temp, `upsertTracks` de 3 enregistrements (dont 2 même album), assertions : `getAlbums` renvoie 1 album avec le bon `trackCount` ; `getTracksByAlbum` renvoie 2 lignes triées par `trackNo` ; ré-`upsertTracks` du même `path` ne duplique pas (idempotent sur `path`).
- [ ] **Step 2 : Échec** — Run `npm run test -- repository`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** avec `better-sqlite3` : tables `artists`, `albums`, `tracks` (clé unique sur `tracks.path`), index sur `album_id`, `artist`, `title`. Migrations simples par `user_version`. Requêtes préparées.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: sqlite schema + repository`.

---

### Task 4 : Scanner de dossiers + extraction métadonnées

**Files:**
- Create: `src/main/library/scanner.ts`, `src/main/library/metadata.ts`
- Test: `tests/scanner.test.ts`, `tests/metadata.test.ts`, `tests/fixtures/` (copier ~6 vrais fichiers depuis la bibliothèque + 1 `.m4p` + 1 fichier tronqué fabriqué)

**Interfaces:**
- Produces:
  - `scanAudioFiles(root: string, fs?): AsyncIterable<string>` — chemins de fichiers d'extensions connues (`.flac .mp3 .wav .m4a .aac .ogg .opus .aiff`), récursif, ignore les dossiers cachés.
  - `readMetadata(path: string): Promise<TrackInput>` — titre/artiste/album/trackNo (tags, repli sur arborescence `Artiste/Album/NN - Titre`), `durationSec`, `format`, `sampleRate`, `bitDepth`, `playable` (`false` pour `.m4p` et erreurs de parse).
- Consumes: `TrackInput` (Task 3).

- [ ] **Step 1 : Tests** —
  - `metadata` : un `.flac` fixture → `format==="FLAC"`, `sampleRate===44100`, `bitDepth===24`, `playable===true`, titre non vide ; un `.m4p` → `playable===false` ; un fichier tronqué → `playable===false` **sans exception**.
  - `metadata` repli : fichier sans tags dans `Artiste X/Album Y/03 - Titre.flac` → `artist==="Artiste X"`, `album==="Album Y"`, `trackNo===3`.
  - `scanner` : sur un dossier fixture imbriqué → ne renvoie que les extensions connues, inclut les sous-dossiers, exclut `.cache/`.
  - **Review Focus** : un dossier contenant un fichier corrompu → `scanAudioFiles` le renvoie quand même (c'est `readMetadata` qui le marque `playable:false`) et l'itération ne s'interrompt pas.
- [ ] **Step 2 : Échec** — Run `npm run test -- scanner metadata`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** `scanner.ts` (parcours `fs.promises`, `fs` injectable pour les tests) et `metadata.ts` (via `music-metadata` ; `format` dérivé du conteneur/codec ; `.m4p` détecté par extension + absence de piste décodable ; try/catch → `playable:false`).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: folder scanner + metadata extraction`.

---

### Task 5 : Pipeline d'indexation (scan → DB), non bloquant

**Files:**
- Create: `src/main/library/indexer.ts`
- Modify: `src/main/ipc.ts` (`library:scan`, `library:query`)
- Test: `tests/indexer.test.ts`

**Interfaces:**
- Produces:
  - `indexLibrary(db, roots: string[], onProgress?): Promise<{added:number, skipped:number}>` — scanne, lit les métadonnées par lots, `upsertTracks`, émet la progression.
  - IPC : `library:scan(paths)` lance l'indexation et renvoie le résumé ; `library:query(view, {limit,offset})` renvoie albums/titres/artistes.
- Consumes: scanner+metadata (Task 4), repository (Task 3), IPC (Task 2).

- [ ] **Step 1 : Test** — `indexLibrary` sur le dossier fixtures → `added` = nombre de fichiers lisibles, `skipped` inclut le `.m4p` et le corrompu ; une 2ᵉ passe ajoute 0 (idempotent) ; la progression est émise au moins une fois.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** l'orchestration par lots (concurrence bornée, ex. 8) pour ne pas bloquer ; brancher les handlers IPC.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle** — script ponctuel (ou test marqué « réel ») qui indexe `C:\Users\Dream\Downloads\REA DS\.prism-profile\documents\Prism Library` : attendu ~969 titres ajoutés, 0 exception, durée raisonnable. Noter le compte et le temps.
- [ ] **Step 6 : Commit** — `feat: non-blocking indexing pipeline`.

---

### Task 6 : Extraction + cache de pochettes + protocole `benten-art://`

**Files:**
- Create: `src/main/library/artcache.ts`
- Modify: `src/main/index.ts` (enregistrer le protocole), `src/main/library/indexer.ts` (renseigner `artKey`)
- Test: `tests/artcache.test.ts`

**Interfaces:**
- Produces:
  - `getOrCreateArt(track): Promise<string|null>` — extrait la pochette embarquée (ou `cover.*`/`folder.*` du dossier), écrit une vignette en cache, renvoie une clé stable (`artKey`).
  - Protocole `benten-art://<artKey>?size=<n>` servant le fichier caché ; `null` si aucune pochette (le Renderer affiche un repli génératif de la DA).
- Consumes: metadata (Task 4), indexer (Task 5).

- [ ] **Step 1 : Test** — un fixture FLAC avec pochette embarquée → `getOrCreateArt` écrit un fichier et renvoie une clé ; 2ᵉ appel réutilise le cache (pas de réécriture) ; un fichier sans pochette → `null`.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** (hash du contenu/chemin comme clé, vignettes via une lib de redimensionnement légère ou le canvas du Main ; réglage de taille).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: cover art cache + custom protocol`.

---

### Task 7 : Moteur audio — graphe Web Audio, décodage FLAC, play/pause/seek

**Files:**
- Create: `src/renderer/audio/engine.ts`, `src/renderer/audio/decoder.ts`
- Test: `tests/engine.test.ts` (Web Audio mocké)

**Interfaces:**
- Produces:
  - `interface Decoder { canDecode(path): boolean; decode(bytes: ArrayBuffer): Promise<AudioBuffer> }` + `NativeDecoder` (via `AudioContext.decodeAudioData`).
  - `class AudioEngine` : `load(track): Promise<void>`, `play()`, `pause()`, `seek(sec)`, `getState(): {status, positionSec, durationSec, trackId}`, `on(event, cb)` ; prend en ctor un `AudioContext` et un `Decoder` (injectables → mockables).
  - Comportement : fichier non décodable → état `error` sur ce track + événement `unplayable`, **aucun son**, pas d'exception propagée.
- Consumes: `Track` (Task 3).

- [ ] **Step 1 : Tests** (avec `AudioContext`/`decodeAudioData` mockés) —
  - `load` puis `play` → `status==="playing"`, `durationSec` renseigné depuis l'`AudioBuffer`.
  - `pause` puis `getState` → position figée ; `seek(30)` → position = 30.
  - **Review Focus** : `load` d'un track `playable:false` (decoder qui rejette) → `status==="error"`, événement `unplayable` émis, `play()` ne produit aucun nœud source.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** le graphe (`source → gain → analyser → destination`), un seul `AudioContext` réutilisé, position dérivée de `AudioContext.currentTime` moins l'offset de départ.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIFICATION RÉELLE (chantier n°1 du doc)** — `npm run dev`, charger et lire un **vrai** FLAC 24/44,1 de la bibliothèque ; confirmer que `decodeAudioData` le décode et qu'il sort sans grésillement ; tester play/pause/seek ; charger le `.m4p` → « non lisible », silence, pas de crash. **Si `decodeAudioData` échoue sur ces FLAC dans le build livré, arrêter et escalader** (repli à décider : élément `<audio>` ou décodeur WASM).
- [ ] **Step 6 : Commit** — `feat: web audio engine + native flac decode`.

---

### Task 8 : File d'attente + gapless + anti-clic au changement

**Files:**
- Create: `src/renderer/audio/schedule.ts`
- Modify: `src/renderer/audio/engine.ts`
- Test: `tests/schedule.test.ts`, `tests/engine.queue.test.ts`

**Interfaces:**
- Produces:
  - `schedule.ts` (PUR) : `nextStartTime(prevStartTime, prevDurationSec): number` et `shouldPreload(positionSec, durationSec, leadSec): boolean` — math de planification à l'échantillon près.
  - `AudioEngine` étendu : `setQueue(tracks, index)`, `next()`, `prev()`, préchargement/décodage du suivant, programmation de sa source pour démarrer exactement à la fin du courant (gapless) ; `next()/prev()` manuels annulent proprement toute source en vol avec un fondu anti-clic de quelques ms.
- Consumes: engine (Task 7).

- [ ] **Step 1 : Tests** —
  - `schedule` : `nextStartTime` renvoie `prevStart+prevDuration` ; `shouldPreload` passe `true` quand il reste < `leadSec`.
  - `engine.queue` (mocké) : à la fin du courant, la source suivante est programmée à `nextStartTime` sans trou ; **Review Focus** : 10 appels `next()` en rafale → au plus une source active à la fin, toutes les précédentes `stop()`ées (compteur de sources vivantes == 1), aucun chevauchement.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** le préchargement (decode anticipé selon `shouldPreload`), la programmation via `source.start(when)`, et l'annulation (rampe de gain courte puis `stop`).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIFICATION RÉELLE** — lire deux vrais morceaux qui s'enchaînent : confirmer **zéro silence** à la jointure ; spammer suivant/précédent : **aucun clic, aucune superposition**.
- [ ] **Step 6 : Commit** — `feat: gapless queue + click-free switching`.

---

### Task 9 : UI bibliothèque + mini-lecteur + écran de lecture (DA portée)

**Files:**
- Create: `src/renderer/theme/tokens.css`, `src/renderer/state/player.ts`, `src/renderer/components/{LibraryGrid,AlbumCard,MiniPlayer,NowPlaying,QualityBadge}.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/player-store.test.ts`

**Interfaces:**
- Produces: store Zustand `usePlayer` (état dérivé des événements du moteur : track, file, status, position) ; UI branchée sur `window.benten.library.query` et `AudioEngine`.
- Consumes: Tasks 2, 5, 6, 7, 8 ; tokens/markup de `design/benten-prototype.html`.

- [ ] **Step 1 : Test** — `player-store` : `setQueue`+`next` met à jour `currentIndex` et `currentTrack` ; un événement moteur `position` met à jour `positionSec` (logique pure, hors React).
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** : porter `tokens.css` (palette, `#e73c82`, typo, rayons) et le markup/CSS des écrans depuis le prototype ; `LibraryGrid` **virtualisée** (`@tanstack/react-virtual`) sur les albums réels ; pochettes via `benten-art://` (repli génératif si `null`) ; `MiniPlayer` + `NowPlaying` pilotant l'`AudioEngine` ; `QualityBadge` affichant `format · sampleRate/bitDepth`. Rendu Unicode vérifié sur noms accentués/`$`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIFICATION RÉELLE** — `npm run dev` : au 1er lancement, proposer d'ajouter le dossier musique, scanner, afficher la grille réelle (défilement fluide sur ~969 titres), lire un album en gapless, changer de piste, voir pochettes + qualité.
- [ ] **Step 6 : Commit** — `feat: library UI + mini-player + now-playing (DA)`.

---

### Task 10 : Qualité (informatif) + périphérique de sortie + persistance de l'index

**Files:**
- Create: `src/main/audio/devices.ts`
- Modify: `src/renderer/components/QualityBadge.tsx` (feuille qualité informative), `src/main/library/db.ts` (chemin de DB persistant), `src/main/ipc.ts`
- Test: `tests/devices.test.ts`

**Interfaces:**
- Produces: `defaultOutputDevice(): {name, sampleRate?}` côté Main ; feuille « Qualité » informative (source affichée + sortie périphérique, modes présentés mais `AudioContext` calé sur la fréquence par défaut — pas de bit-perfect) ; DB stockée dans `app.getPath("userData")` pour réouverture sans re-scan.
- Consumes: Tasks 3, 7, 9.

- [ ] **Step 1 : Test** — `devices` : `defaultOutputDevice` renvoie un objet avec `name` non vide (ou un repli nommé si indisponible, sans exception).
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** l'énumération (API Electron/OS), la feuille qualité informative, et la persistance du chemin DB + reprise rapide au démarrage.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle** — rouvrir l'app : la bibliothèque s'affiche instantanément (pas de re-scan bloquant) ; la feuille qualité montre la vraie source et la sortie détectée.
- [ ] **Step 6 : Commit** — `feat: quality sheet (informative) + output device + persistent index`.

---

## Auto-revue (effectuée)

- **Couverture spec Phase 1** : scaffold (T1), IPC (T2), bibliothèque/scan/index/pochettes (T3–T6), moteur FLAC + gapless + DRM (T7–T8), UI/DA (T9), qualité informative + périphérique + persistance (T10). Streaming, playlists, favoris, recherche, veille, motion de lancement, empaquetage = **hors Phase 1** (Phases 2–3, plans dédiés).
- **Review Focus** : corrompu (T4 s.1), `.m4p`/illisible (T4 s.1, T7 s.1), spam suivant/précédent (T8 s.1), tags manquants/Unicode (T4 s.1, T9 s.3), grande bibliothèque (T5 s.5, T9 s.3) — chacun a son test/vérif dans la tâche propriétaire.
- **Cohérence des types** : `TrackInput/TrackRow`, `AudioEngine`, `Decoder`, `usePlayer` nommés une seule fois et réutilisés.
- **Audio non unit-testable** : isolé derrière `AudioContext`/`Decoder` mockés ; les propriétés réelles (décodage FLAC, gapless, anti-clic) ont des **étapes de vérification réelle** explicites (T7 s.5, T8 s.5, T9 s.5) sur la bibliothèque de l'utilisateur.
