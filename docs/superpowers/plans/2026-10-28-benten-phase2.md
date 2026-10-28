# Benten — Plan d'implémentation, Phase 2 (le vrai lecteur complet)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformer le socle Phase 1 en lecteur complet : recherche, tri/filtre, file d'attente visible, playlists, favoris, shuffle/répétition, veille de dossiers, feuille qualité fonctionnelle + périphériques, et persistance complète de l'état — sans régresser un seul invariant audio.

**Architecture:** On étend le modèle existant sans le refondre. Main (Node) possède SQLite (schéma v2 migré), la veille `chokidar` et l'IPC ; preload expose `window.benten` typé ; Renderer (React + Zustand) possède l'UI et le moteur Web Audio. Toute la logique testable (schéma/requêtes, parsing, **math d'ordre shuffle/repeat**, machine de file, agrégation de veille, sérialisation d'état) est en modules purs testés par Vitest ; les propriétés audio réelles (gapless shuffle, reprise, recréation de contexte) sont vérifiées par un **harnais CDP** qui pilote le vrai renderer Electron et assère l'état/les timings par programme.

**Tech Stack:** electron-vite, Electron 45.1.0, React 18.3.1, TypeScript 5.9.3, better-sqlite3 13.0.3, music-metadata 12.3.2, Zustand 5.0.16, @tanstack/react-virtual 3.14.23, Vitest 5.0.5, **chokidar (à épingler)**.

**Spec:** `docs/superpowers/specs/2026-10-28-benten-phase2-design.md` (raffine `2026-10-28-benten-design.md` §8 ; DA = `design/benten-prototype.html`).

## Global Constraints

- **Invariants audio Phase 1 (spec §2), non négociables :** zéro bug audio (clic/blanc/désync/superposition) ; gapless à l'échantillon près ; fichiers en **lecture seule** (la veille ne touche QUE l'index) ; **un seul `AudioContext` + une seule boucle `tick()`** (recréation de contexte = seule exception, hors lecture) ; `.m4p`/illisible → `playable:false`, sautés silencieusement, jamais de son parasite ni de crash.
- **Nouvelles features audio réutilisent le chemin de programmation existant** (`scheduleNext`/`promoteScheduled`) — pas de second chemin de lecture.
- **Hors-ligne total** : aucun appel réseau au runtime. Tout reste **local** (aucun push/PR).
- **Thème sombre unique**, accent magenta mat **`#e73c82`** (aplat), tokens de `src/renderer/theme/tokens.css` (DA portée, jamais réinventée).
- **Migration SQLite additive** : la v2 préserve toute donnée v1 (aucune table/colonne supprimée destructivement).
- **Versions épinglées à l'exact** ; une seule nouvelle dépendance runtime : **`chokidar`**. Pas de nouvelle dépendance UI si un équivalent sans lib suffit.
- **Pas de `nodeIntegration`** dans le Renderer ; tout IPC gardé par `assertTrusted`.
- **Node ≥ 22.12**, React `18.3.1`.
- **Commits** terminés par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Bibliothèque réelle de dev** (lecture seule) : `C:\Users\Dream\Downloads\REA DS\.prism-profile\documents\Prism Library` (~969 FLAC 24/44,1).
- **Gate dur par tâche :** `npm test` (toute la suite) **vert** + `npm run typecheck` **vert**. Les étapes « VÉRIF RÉELLE (CDP) » sont exigées en plus sur les tâches audio/flux ; si la connexion CDP est impossible dans l'environnement, l'implémenteur lance `npm run dev` et consigne le résultat observé (jamais « supposé »).

## Review Focus

- **Migration v1→v2 sur une base déjà peuplée** (969 pistes réelles) → les données survivent, `user_version` passe à 2, les colonnes/tables apparaissent, aucune piste perdue. *(Test : Tâche 2.)*
- **`audio:read-file` sur un chemin hors des racines indexées, ou via lien symbolique qui s'en échappe** → rejet (pas de lecture de fichier arbitraire). Frontière de préfixe (`/Lib` ne doit pas matcher `/Library`). *(Test : Tâche 5.)*
- **Mutation de la file (retrait/réordonnancement d'une piste FUTURE) pendant la lecture** → la piste courante n'est jamais coupée ; seule la programmation `scheduled`/`preload` est réévaluée. *(Test : Tâche 11.)*
- **Shuffle/repeat avec une piste non lisible (`.m4p`) dans la file, et rafale next/prev** → saut silencieux, bornes correctes, jamais plus d'une source vivante, pas de clic. *(Test : Tâche 12.)*
- **Rafale d'événements de veille (copie d'un album entier, fichier en cours d'écriture, suppression)** → agrégation/debounce, upsert/retrait corrects, watcher qui ne crash jamais, lecture non interrompue. *(Test : Tâche 14.)*

---

## Structure de fichiers (Phase 2)

```
src/
  shared/
    types.ts         # MODIF : TrackRow +albumArtist/+discNo ; PlaylistRow, FavoriteRow,
                     #         SourceRow, RepeatMode, QualityMode, SearchArgs, SortArgs,
                     #         PersistedState ; extension de BentenApi + onLibraryChanged
    channels.ts      # MODIF : nouveaux canaux (search, sources, favorites, playlists, state,
                     #         quality/devices) + canal push LIBRARY_CHANGED
  main/
    index.ts         # MODIF : switch remote-debugging-port (dev), démarrage veille, restaure sources
    ipc.ts           # MODIF : handlers des nouveaux canaux ; read-file confiné aux racines
    library/
      db.ts          # MODIF : migration v2 (colonnes, tables, index NOCASE)
      repository.ts  # MODIF : grouping albumArtist ; sort/filter ; search ; removeTracks/prune ;
                     #         sources/favorites/playlists/app_state CRUD
      metadata.ts    # MODIF : extraction albumArtist + discNo
      indexer.ts     # MODIF : mtime/size ; saut de ré-extraction pochette ; retrait
      watcher.ts     # CREATE : veille chokidar -> indexation incrémentale (logique pure testable)
    audio/
      devices.ts     # MODIF : énumération fine des sorties
  renderer/
    App.tsx          # MODIF : sources persistées, recherche/nav câblées, veille, restauration
    audio/
      engine.ts      # MODIF : order[]/orderPos, setShuffle, setRepeatMode ; rebuild de contexte
      order.ts       # CREATE : math d'ordre shuffle/repeat (PUR)
    state/
      player.ts      # MODIF : shuffle/repeat, mutations de file, favoris, playlists, volume
    lib/
      focusTrap.ts   # CREATE : hook de piège à focus réutilisable (a11y)
      persist.ts     # CREATE : sérialisation/restauration de PersistedState (PUR)
    components/
      QueuePanel.tsx    # CREATE : file d'attente visible + actions
      Playlists.tsx     # CREATE : gestion/affichage des playlists
      SearchResults.tsx # CREATE : résultats de recherche
      SortFilterBar.tsx # CREATE : contrôles tri/filtre
      QualitySheet.tsx  # CREATE/MODIF : feuille qualité fonctionnelle (depuis QualityBadge)
      NowPlaying.tsx    # MODIF : focus trap, boutons shuffle/repeat/queue/favori
      MiniPlayer.tsx    # MODIF : fix rôle .player, favori, volume
scripts/
  cdp-smoke.mjs      # CREATE : harnais CDP (connexion renderer réel, évalue une assertion)
tests/               # miroir Vitest de chaque module pur + fixtures additionnelles
```

---

### Task 1 : Harnais de vérification CDP (infra réutilisable)

**Files:**
- Create: `scripts/cdp-smoke.mjs`
- Modify: `src/main/index.ts` (switch `remote-debugging-port` en dev uniquement), `package.json` (script `check:cdp`)
- Test: `tests/cdp-harness.test.ts` (teste le parseur d'arguments/timeout du script, pas Electron)

**Interfaces:**
- Produces: `node scripts/cdp-smoke.mjs --port 9222 --timeout 20000 --expr "<async IIFE renvoyant {ok:boolean, detail?}>"` — se connecte au premier target `page` du renderer Electron, attend que `window.benten` existe, évalue `--expr`, imprime le JSON résultat, **exit 0 si `ok===true` sinon 1**. Réutilisé par toutes les « VÉRIF RÉELLE ».
- Consumes: —

- [ ] **Step 1 : Test** — `tests/cdp-harness.test.ts` importe les helpers purs de `cdp-smoke.mjs` (ex. `parseArgs(argv)` et `withTimeout(promise, ms)`) : `parseArgs(["--port","9222","--expr","x"])` → `{port:9222, timeout:<défaut>, expr:"x"}` ; `withTimeout` rejette après le délai. (Extraire ces helpers pour qu'ils soient importables sans ouvrir de socket.)
- [ ] **Step 2 : Échec** — `npm run test -- cdp-harness`. Expected: FAIL (module absent).
- [ ] **Step 3 : Implémenter** `scripts/cdp-smoke.mjs` : connexion CDP via WebSocket brut sur `http://127.0.0.1:<port>/json` (pas de nouvelle dépendance), `Runtime.evaluate` de `--expr` avec `awaitPromise:true, returnByValue:true`, timeout propre, sortie JSON + code de sortie. Dans `src/main/index.ts`, ajouter `app.commandLine.appendSwitch("remote-debugging-port", "9222")` **uniquement si `process.env.ELECTRON_RENDERER_URL`** (dev). Ajouter `"check:cdp": "node scripts/cdp-smoke.mjs"` à `package.json`.
- [ ] **Step 4 : Succès** — `npm run test -- cdp-harness`. Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP)** — `npm run dev` en tâche de fond ; `npm run check:cdp -- --expr "(async()=>({ok: typeof window.benten?.ping==='function' && (await window.benten.ping())==='pong'}))()"` → exit 0. Prouve que le harnais pilote le vrai renderer.
- [ ] **Step 6 : Commit** — `chore: electron CDP smoke harness`.

---

### Task 2 : Schéma SQLite v2 (migration additive + index NOCASE)

**Files:**
- Modify: `src/main/library/db.ts`, `src/shared/types.ts`
- Test: `tests/migration.test.ts`

**Interfaces:**
- Produces: migration v2 appliquée par `openDb` quand `user_version < 2`. Après v2 : `tracks` a `album_artist TEXT`, `disc_no INTEGER`, `mtime_ms INTEGER`, `size_bytes INTEGER` ; `albums` a `created_at INTEGER NOT NULL DEFAULT 0` ; index `idx_tracks_artist`/`idx_tracks_title` **recréés `COLLATE NOCASE`** ; nouvelles tables `sources(id, path TEXT UNIQUE NOT NULL, added_at INTEGER NOT NULL)`, `playlists(id, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`, `playlist_tracks(playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(playlist_id, position))`, `favorites(track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, added_at INTEGER NOT NULL)`, `app_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)`. Types partagés étendus : `TrackRow` + `albumArtist: string | null`, `discNo: number | null`.
- Consumes: —

- [ ] **Step 1 : Test** — `tests/migration.test.ts` : (a) ouvre une DB temp en écrivant d'abord le schéma **v1** (copié de la migration existante) + insère 2 artistes/1 album/3 pistes + `user_version=1`, referme, rouvre via `openDb` → `user_version===2`, les 3 pistes et l'album sont toujours là, `album_artist`/`disc_no` existent (valeur `NULL`), `albums.created_at` existe ; (b) une DB neuve via `openDb` est directement en v2 ; (c) l'index `idx_tracks_artist` est bien `COLLATE NOCASE` (`SELECT sql FROM sqlite_master WHERE name='idx_tracks_artist'` contient `NOCASE`) ; (d) les tables `sources/playlists/playlist_tracks/favorites/app_state` existent ; (e) `ON DELETE CASCADE` effectif : supprimer une piste retire sa ligne `favorites`.
- [ ] **Step 2 : Échec** — `npm run test -- migration`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** la **migration v2** comme 2ᵉ entrée de `MIGRATIONS` dans `db.ts` : `ALTER TABLE` pour les nouvelles colonnes, `DROP INDEX`+`CREATE INDEX ... COLLATE NOCASE` pour les deux index de tri, `CREATE TABLE` pour les 5 nouvelles tables. Ne rien supprimer d'autre. Étendre `TrackRow` dans `types.ts`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (Review Focus)** — copier la DB réelle `%APPDATA%/benten/benten.db` (si présente, sinon indexer d'abord un petit dossier) vers un temp, l'ouvrir via un petit script `node -e`, confirmer `user_version===2` et `COUNT(*) FROM tracks` inchangé. Consigner le compte avant/après.
- [ ] **Step 6 : Commit** — `feat: sqlite schema v2 (albumArtist/discNo, NOCASE, phase2 tables)`.

---

### Task 3 : Métadonnées v2 + regroupement d'albums par albumArtist

**Files:**
- Modify: `src/main/library/metadata.ts`, `src/main/library/repository.ts`, `src/shared/types.ts` (`TrackInput` suit `TrackRow`)
- Test: `tests/metadata.test.ts` (ajouts), `tests/repository.test.ts` (ajouts), fixtures : un album « compilation » (2 pistes, même `album`, `artist` différents, `albumArtist` commun) et un album multi-disque (2 pistes, `discNo` 1 et 2).

**Interfaces:**
- Consumes: schéma v2 (Task 2).
- Produces: `readMetadata` renvoie en plus `albumArtist: string | null`, `discNo: number | null` (tags Vorbis `ALBUMARTIST`/`ALBUM ARTIST` et `DISCNUMBER` ; repli `null`). `upsertTracks` groupe les albums par **`COALESCE(NULLIF(TRIM(album_artist),''), artist)`** (nouvelle colonne `albums.artist_id` reste, mais l'artiste d'album est celui-ci) et renseigne `albums.created_at` au 1er insert (horodatage). `getTracksByAlbum` trie par `disc_no IS NULL, disc_no, track_no IS NULL, track_no, title COLLATE NOCASE, id`. `getAlbums` expose l'artiste d'album comme `artist`.
- *(Décision : `albums.artist_id` continue de référencer l'artiste d'album ; un morceau d'une compilation s'insère sous l'artiste d'album, pas son artiste de piste.)*

- [ ] **Step 1 : Tests** — `metadata` : le fixture compilation → chaque piste a `albumArtist` commun non nul ; le fixture multi-disque → `discNo` 1 puis 2. `repository` : insérer les 2 pistes de la compilation (artistes de piste différents, même `albumArtist`) → `getAlbums` renvoie **1 seul album** dont `trackCount===2` et `artist===albumArtist` ; insérer l'album multi-disque → `getTracksByAlbum` renvoie les pistes triées disque 1 avant disque 2.
- [ ] **Step 2 : Échec** — `npm run test -- metadata repository`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** l'extraction dans `metadata.ts` et la nouvelle logique de grouping/sort dans `repository.ts` (adapter `statements`, `upsertTracks`, `tracksByAlbum`, `albums`).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: album grouping by albumArtist + disc/track sort`.

---

### Task 4 : Indexation incrémentale — mtime/size, saut de pochette, retrait

**Files:**
- Modify: `src/main/library/indexer.ts`, `src/main/library/repository.ts`
- Test: `tests/indexer.test.ts` (ajouts), `tests/repository.test.ts` (ajouts)

**Interfaces:**
- Consumes: metadata v2 (Task 3), schéma v2 (Task 2).
- Produces:
  - `indexLibrary` renseigne `mtimeMs`/`sizeBytes` (via `fs.stat`, injectable) et **saute `getArt`** quand la piste existe déjà avec `art_key` non nul **et** `mtime_ms`/`size_bytes` inchangés (fix pochette).
  - `removeTracks(db, paths: readonly string[]): number` — supprime les pistes par `path`, puis **purge** les albums et artistes devenus sans piste ; renvoie le nombre de pistes retirées. Cascade favoris/playlists.
  - Repository : `getTrackByPath(db, path): TrackRow | undefined`, `getTrackStat(db, path): {mtimeMs:number|null, sizeBytes:number|null, artKey:string|null} | undefined`.
- *(Nouvelle signature interne : l'indexeur lit le stat existant pour décider du saut de pochette.)*

- [ ] **Step 1 : Tests** — `indexer` : indexer un fixture (getArt espionné) puis ré-indexer **sans changer** les fichiers → `getArt` **n'est pas rappelé** pour une piste dont `art_key` est non nul et `mtime/size` identiques ; si on change le `mtime` injecté → `getArt` **est** rappelé. `repository` : `removeTracks([p])` retire la piste, purge l'album/artiste s'ils deviennent vides, et une entrée `favorites` pointant cette piste disparaît ; renvoie `1`.
- [ ] **Step 2 : Échec** — `npm run test -- indexer repository`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** le passage de `mtime/size` à l'upsert, la décision de saut via `getTrackStat`, et `removeTracks` + purge.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: incremental index (mtime/size, cover reuse, removeTracks)`.

---

### Task 5 : Sources persistées + sécurité `audio:read-file` confiné aux racines

**Files:**
- Modify: `src/main/library/repository.ts` (CRUD `sources`), `src/main/ipc.ts` (confinement read-file ; `sources:*`), `src/shared/types.ts` (`SourceRow`, extension `BentenApi.sources`), `src/shared/channels.ts`, `src/preload/index.ts`
- Test: `tests/ipc.test.ts` (ajouts), `tests/repository.test.ts` (ajouts)

**Interfaces:**
- Consumes: schéma v2 (Task 2).
- Produces:
  - Repository : `addSource(db, path)`, `getSources(db): SourceRow[]`, `removeSource(db, id)`.
  - `isPathWithinRoots(filePath, roots, realpath?): boolean` (PUR, exporté d'`ipc.ts`) — vrai si `filePath` **résolu** est contenu dans une racine **résolue** ; comparaison sur chemins normalisés avec séparateur de fin (frontière de préfixe). `readAudioFile` prend maintenant `db` et **rejette** un chemin hors des `sources` persistées (après `fs.realpathSync` du fichier ET de la racine). `library:scan` ajoute aussi les racines à `sources`.
  - IPC `sources:list`/`sources:remove` (ajout via scan) ; `window.benten.sources`.
- *(Décision : `audio:read-file` conserve ses gardes existants — absolu, non nul, fichier, taille — PLUS le confinement.)*

- [ ] **Step 1 : Tests** — `ipc` : `isPathWithinRoots("/lib/a/x.flac", ["/lib"])===true` ; `.../lib2/x.flac` hors `["/lib"]` → `false` ; frontière `"/library/x"` hors `["/lib"]` → `false`. `readAudioFile` avec `db` dont `sources` ne contient pas le dossier du fichier → **rejette** ; avec la racine présente → résout. (Pour le lien symbolique : fixture optionnelle ; au minimum tester la frontière de préfixe et l'appartenance.) `repository` : `addSource` idempotent sur `path`, `getSources` renvoie la liste.
- [ ] **Step 2 : Échec** — `npm run test -- ipc repository`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** le CRUD `sources`, `isPathWithinRoots` + confinement dans `readAudioFile(db, path)`, l'ajout aux sources dans le handler `library:scan`, et les canaux/preload `sources`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP, Review Focus)** — app lancée, indexer la vraie biblio ; `check:cdp` : `window.benten.audio.readFile(<flac indexé>)` résout (byteLength>0) ; `readFile("C:\\Windows\\System32\\drivers\\etc\\hosts")` **rejette**. Exit 0 si les deux se comportent comme prévu.
- [ ] **Step 6 : Commit** — `feat: persisted sources + confine audio:read-file to indexed roots`.

---

### Task 6 : Transverses a11y & perf — focus-trap, throttle rAF, rôle .player

**Files:**
- Create: `src/renderer/lib/focusTrap.ts`
- Modify: `src/renderer/App.tsx` (throttle), `src/renderer/components/NowPlaying.tsx` (focus trap), `src/renderer/components/MiniPlayer.tsx` (rôle .player), `src/renderer/components/QualityBadge.tsx` (focus trap si c'est un dialogue)
- Test: `tests/focus-trap.test.ts`, `tests/raf-throttle.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `useFocusTrap(ref, { active, onEscape }): void` (hook) + helper pur `nextFocusIndex(current, count, shiftKey): number` (cyclage Tab/Shift-Tab) exporté pour test.
  - `makeThrottle(intervalMs): (now:number) => boolean` (PUR) — renvoie `true` quand `intervalMs` s'est écoulé depuis le dernier `true` ; utilisé dans la boucle rAF d'`App.tsx` pour cadencer `tick()` + `setPosition` à **~15 Hz (66 ms)**.
- *(Décision : la boucle rAF continue de tourner à la fréquence écran, mais `tick()`/`setPosition` ne s'exécutent que ~15×/s via `makeThrottle`.)*

- [ ] **Step 1 : Tests** — `focus-trap` : `nextFocusIndex(2,3,false)===0` (wrap avant), `nextFocusIndex(0,3,true)===2` (wrap arrière). `raf-throttle` : un `makeThrottle(66)` alimenté de timestamps renvoie `true` à 0, `false` à 30, `true` à 70 (≈ 1 passage par fenêtre de 66 ms).
- [ ] **Step 2 : Échec** — `npm run test -- focus-trap raf-throttle`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** `focusTrap.ts` (piège focus : collecte des éléments focusables, cycle Tab, `Esc`→`onEscape`, restauration du focus au démontage, `role="dialog"`/`aria-modal` posés par les composants) et `makeThrottle` ; câbler dans `App.tsx` la boucle rAF throttlée ; appliquer le trap à `NowPlaying` et à la feuille qualité ; corriger le rôle imbriqué du `.player` (mini-lecteur : conteneur non interactif, boutons focusables distincts).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP)** — app lancée, ouvrir Now-Playing ; `check:cdp` évalue que `document.activeElement` reste dans le dialogue après plusieurs `Tab` simulés et que `Esc` le ferme ; confirmer (via un compteur exposé en dev) que `setPosition` est appelé ~15×/s, pas ~60.
- [ ] **Step 6 : Commit** — `fix: a11y focus trap + .player role + throttle position/tick to ~15Hz`.

---

### Task 7 : Recherche (library:search) + câblage de la barre

**Files:**
- Modify: `src/main/library/repository.ts` (`searchTracks`), `src/main/ipc.ts` (`library:search`), `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`
- Create: `src/renderer/components/SearchResults.tsx`
- Test: `tests/repository.test.ts` (ajouts), `tests/ipc.test.ts` (ajouts)

**Interfaces:**
- Consumes: schéma v2 (Task 2), regroupement albums (Task 3).
- Produces:
  - `searchTracks(db, q: string, page: Page): TrackRow[]` — `LIKE` casse-insensible (`COLLATE NOCASE`) sur `title`/`artist`/`album`, métacaractères `LIKE` (`%`,`_`,`\`) échappés, `q` vide → `[]`.
  - IPC `library:search({ q, limit })` → `TrackRow[]`. `window.benten.library.search`.
  - `App.tsx` : barre de recherche **activée** (retrait de `disabled`/classe `soon`), debounce ~150 ms, affiche `SearchResults` (regroupables en albums) quand `q` non vide, sinon la grille.
- *(Décision : recherche sur pistes ; l'UI groupe en albums via `groupTracksToAlbums` existant.)*

- [ ] **Step 1 : Tests** — `repository` : pistes « Café », « CAFÉ latte » (artiste), « x » (album « Café Bar ») → `searchTracks("caf", …)` renvoie les 3 (NOCASE, cross-colonne) ; `searchTracks("50%", …)` n'interprète pas `%` comme joker (échappement) ; `""` → `[]`. `ipc` : `library:search` valide `q`/`limit` et délègue.
- [ ] **Step 2 : Échec** — `npm run test -- repository ipc`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** `searchTracks` (échappement + `ESCAPE '\'`), le handler IPC, le preload, et le câblage UI (debounce, `SearchResults` à la DA).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP)** — app + vraie biblio ; `check:cdp` : `window.benten.library.search({q:"montagem",limit:50})` renvoie des lignes dont chaque champ matche, et `>0`. (Flux UI : taper dans la barre filtre la vue — confirmé visuellement via `npm run dev` si CDP ne pilote pas le DOM React.)
- [ ] **Step 6 : Commit** — `feat: library search (LIKE NOCASE) + wired search bar`.

---

### Task 8 : Tri / filtre des listes

**Files:**
- Modify: `src/main/library/repository.ts`, `src/main/ipc.ts` (`normalizePage`/`queryLibrary` étendus), `src/shared/types.ts` (`SortField`, `SortDir`, `LibraryFilter`, extension `LibraryQueryArgs`), `src/renderer/App.tsx`
- Create: `src/renderer/components/SortFilterBar.tsx`
- Test: `tests/repository.test.ts` (ajouts), `tests/ipc.test.ts` (ajouts)

**Interfaces:**
- Consumes: Tasks 2, 3, 7 (favoris arrivent en Task 9 ; ici le filtre « favoris » est câblé mais sa donnée vient de la jointure `favorites`).
- Produces:
  - `getAlbums`/`getAllTracks` acceptent `{ sort, dir, filter }` : albums triables par `title|artist|created_at|duration` (durée = `SUM(duration_sec)`), pistes par `title|artist|album|duration|track_no`, `dir` `asc|desc` ; `filter.favoritesOnly` jointe `favorites` ; `filter.losslessOnly` filtre `bit_depth IS NOT NULL`. Valeurs de tri **mises en liste blanche** (jamais d'interpolation brute dans le SQL → anti-injection).
  - `queryLibrary`/`normalizePage` valident et transmettent ces arguments. `SortFilterBar` (DA) pilote la vue.
- *(Décision : les champs de tri sont une énumération fermée mappée vers des colonnes sûres.)*

- [ ] **Step 1 : Tests** — `repository` : 3 albums de titres « b/A/c » → `getAlbums(sort:"title",dir:"asc")` donne `A,b,c` (NOCASE), `dir:"desc"` l'inverse ; tri `duration` ordonne par durée totale. `ipc` : un `sort` inconnu est rejeté/normalisé vers un défaut (pas d'injection). (`favoritesOnly` testé en Task 9 une fois la donnée présente ; ici tester que l'argument est accepté.)
- [ ] **Step 2 : Échec** — `npm run test -- repository ipc`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** la liste blanche de tri + `ORDER BY` dynamiques sûrs, les filtres, la validation IPC, et `SortFilterBar`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: sort & filter for library views`.

---

### Task 9 : Favoris

**Files:**
- Modify: `src/main/library/repository.ts` (favorites CRUD + jointure), `src/main/ipc.ts`, `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/state/player.ts`, `src/renderer/components/{MiniPlayer,NowPlaying}.tsx`, `src/renderer/App.tsx` (vue/filtre favoris)
- Test: `tests/repository.test.ts` (ajouts), `tests/player-store.test.ts` (ajouts)

**Interfaces:**
- Consumes: Tasks 2, 8.
- Produces:
  - Repository : `setFavorite(db, trackId, on: boolean)`, `isFavorite(db, trackId): boolean`, `getFavoriteIds(db): number[]`, et `TrackRow.favorite?` renseigné par les requêtes (jointure `LEFT JOIN favorites`). `filter.favoritesOnly` (Task 8) devient effectif.
  - IPC `favorites:toggle`/`favorites:list`. Store : `favoriteIds: Set<number>`, `toggleFavorite(trackId)`. UI : cœur (magenta mat) dans mini-lecteur + Now-Playing ; entrée vue « Favoris ».
- *(Décision : le store garde l'ensemble des ids favoris pour un rendu instantané ; la persistance est en DB via IPC.)*

- [ ] **Step 1 : Tests** — `repository` : `setFavorite(id,true)` puis `isFavorite===true` et `getFavoriteIds` contient `id` ; `setFavorite(id,false)` l'enlève ; `getAlbums(filter:{favoritesOnly:true})` ne renvoie que des albums ayant ≥1 piste favorite. `player-store` : `toggleFavorite(id)` bascule l'appartenance à `favoriteIds`.
- [ ] **Step 2 : Échec** — `npm run test -- repository player-store`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** le CRUD favoris + jointure, les canaux, le store, l'UI cœur et la vue/filtre favoris.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: favorites (toggle, view, filter)`.

---

### Task 10 : Playlists

**Files:**
- Modify: `src/main/library/repository.ts` (playlists + playlist_tracks), `src/main/ipc.ts`, `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/App.tsx` (nav + vue)
- Create: `src/renderer/components/Playlists.tsx`
- Test: `tests/repository.test.ts` (ajouts)

**Interfaces:**
- Consumes: Tasks 2, 3.
- Produces:
  - Repository : `createPlaylist(db, name): number`, `renamePlaylist(db, id, name)`, `deletePlaylist(db, id)`, `getPlaylists(db): PlaylistRow[]` (avec `trackCount`), `getPlaylistTracks(db, id): TrackRow[]` (ordonnées par `position`), `addToPlaylist(db, id, trackIds)` (append aux positions suivantes), `removeFromPlaylist(db, id, position)` (puis **recompactage** des positions), `reorderPlaylist(db, id, from, to)`.
  - IPC `playlists:*`. UI `Playlists.tsx` (créer/renommer/supprimer, lister, jouer → remplit la file), entrée de nav « Playlists » câblée.
- *(Décision : `position` est dense et recompactée à chaque retrait/réordonnancement, dans une transaction.)*

- [ ] **Step 1 : Tests** — `repository` : créer une playlist, `addToPlaylist(id,[t1,t2,t3])` → `getPlaylistTracks` renvoie `t1,t2,t3` ; `removeFromPlaylist(id, 1)` (position de t2) → `t1,t3` avec positions `0,1` (recompactées) ; `reorderPlaylist(id, 0, 1)` → `t3,t1` ; `deletePlaylist` cascade `playlist_tracks`.
- [ ] **Step 2 : Échec** — `npm run test -- repository`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** le CRUD playlists + ordonnancement transactionnel, les canaux, et l'UI `Playlists` (DA).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat: playlists (CRUD, ordering, play)`.

---

### Task 11 : File d'attente visible + actions (sans couper le son)

**Files:**
- Modify: `src/renderer/state/player.ts` (mutations de file), `src/renderer/audio/engine.ts` (mutation de file à chaud), `src/renderer/components/{NowPlaying,MiniPlayer}.tsx`
- Create: `src/renderer/components/QueuePanel.tsx`
- Test: `tests/player-store.test.ts` (ajouts), `tests/engine.queue.test.ts` (ajouts)

**Interfaces:**
- Consumes: moteur + store Phase 1, Tasks 9/10 (sources de pistes à enfiler).
- Produces:
  - Store : `playNext(tracks)` (insère juste après `currentIndex`), `addToQueue(tracks)` (append), `removeFromQueue(index)`, `moveInQueue(from, to)`, `jumpTo(index)`.
  - Engine : `updateQueue(tracks, { keepCurrent: true })` — remplace la file **sans recharger ni interrompre** la piste courante quand son id reste présent ; recale `queueIndex` sur l'id courant ; **invalide `scheduled`/`preload` et re-pompe** uniquement si la *suivante* a changé. `jumpTo(index)` réutilise le chemin manuel anti-clic (`switchTo`).
  - `QueuePanel` (DA, focus-trap) : liste la file (passées grisées, courante en magenta, à venir), actions retirer/monter/descendre/jouer.
- *(Review Focus : réordonner/retirer une piste FUTURE ne doit jamais couper la courante.)*

- [ ] **Step 1 : Tests** — `player-store` : `playNext([x])` insère `x` en `currentIndex+1` sans changer la piste courante ; `addToQueue` append ; `removeFromQueue`/`moveInQueue` ajustent la liste et conservent `currentTrack`. `engine.queue` (mocké) : lecture en cours, `updateQueue` qui **change seulement la piste suivante** → la source **courante n'est ni stoppée ni rechargée** (même instance), et la source `scheduled` obsolète est annulée puis reprogrammée ; `updateQueue` qui retire la piste courante de la file → comportement défini (passe à la plus proche lisible). **Review Focus** : réordonner deux pistes futures pendant la lecture → `source` courante inchangée (compteur de `load()` non incrémenté).
- [ ] **Step 2 : Échec** — `npm run test -- player-store engine`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** les mutations de store, `updateQueue` à chaud dans le moteur (réutiliser `teardownScheduled`/`clearPreload`/`pump` existants, ne jamais toucher `this.source` si l'id courant persiste), et `QueuePanel`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP, Review Focus)** — app + 2 vrais morceaux en file, lecture lancée ; `check:cdp` : relever `engine.getState().positionSec` avant, muter la file (réordonner les pistes à venir) via le store, relever après → la position **a continué d'avancer**, `status==="playing"`, `trackId` inchangé (pas de coupure).
- [ ] **Step 6 : Commit** — `feat: visible queue + hot queue mutations (no audio cut)`.

---

### Task 12 : Lecture aléatoire & répétition (cœur audio)

**Files:**
- Create: `src/renderer/audio/order.ts`
- Modify: `src/renderer/audio/engine.ts`, `src/renderer/state/player.ts`, `src/renderer/components/{NowPlaying,MiniPlayer}.tsx`
- Test: `tests/order.test.ts`, `tests/engine.queue.test.ts` (ajouts)

**Interfaces:**
- Consumes: moteur (Tasks 7/8 Phase 1 + Task 11).
- Produces:
  - `order.ts` (PUR) : `buildOrder(count, { shuffle, seed, current }): number[]` (identité si non shuffle ; Fisher-Yates seedé avec `current` en tête si shuffle) ; `nextInOrder(order, pos, repeat): number | null` et `prevInOrder(order, pos, repeat): number | null` (`repeat` ∈ `off|all|one` ; `one` renvoie la position courante ; `all` boucle ; `off` renvoie `null` aux bornes).
  - Engine : champs `order:number[]`, `orderPos:number`, `repeat:RepeatMode`, `shuffle:boolean` ; `setRepeatMode(m)`, `setShuffle(on)` (régénère `order` en gardant la courante) ; **toute** la navigation (`findPlayableFrom`→ parcours d'`order`, `onCurrentSourceEnded`, `pump`→ calcul de la suivante via `nextInOrder`, `next`/`prev`) respecte ordre+repeat. `repeat:one` programme la **même** piste comme suivante (gapless). Réutilise `scheduleNext`/`promoteScheduled`.
  - Store : `repeat`, `shuffle`, `setRepeat`, `setShuffle` ; UI boutons (magenta mat actif).
- *(Décision : `order` indexe `queue` ; `orderPos` est la position dans `order`. Un `.m4p` reste sauté via `playable`. `setShuffle`/`updateQueue` régénèrent `order` en conservant la piste courante en tête de la portion à venir.)*

- [ ] **Step 1 : Tests** — `order` : `buildOrder(5,{shuffle:false})` = `[0,1,2,3,4]` ; shuffle seedé → permutation déterministe avec `current` en position 0 ; `nextInOrder([0,1,2],2,"off")===null`, `"all"`→`0`, `"one"`→`2` ; `prevInOrder` symétrique. `engine.queue` (mocké) : en `repeat:"all"`, la fin de la dernière piste programme/again la première (gapless, via `scheduled`) ; en `repeat:"one"`, la fin reprogramme la même ; en shuffle, l'enchaînement suit `order` ; **Review Focus** : file avec un `.m4p` au milieu + rafale `next()` → saut silencieux, bornes correctes, **une seule source vivante**, aucun chevauchement.
- [ ] **Step 2 : Échec** — `npm run test -- order engine`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** `order.ts` puis câbler le moteur (remplacer les `queueIndex±1` par `nextInOrder`/`prevInOrder` sur `order`/`orderPos`, régénérer `order` dans `setQueue`/`updateQueue`/`setShuffle`), et le store/UI.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP, invariant gapless)** — app + file de ≥3 vrais morceaux. `check:cdp` scénario : activer shuffle, lancer, attendre une promotion gapless et vérifier `trackId` a changé **sans** passage par `status:"loading"` à la jointure (chemin `scheduled`), et que la position repart de ~0 ; activer `repeat:"one"`, vérifier que la même piste reboucle. Exit 0 si les timings/états sont ceux attendus.
- [ ] **Step 6 : Commit** — `feat: shuffle & repeat (same gapless path)`.

---

### Task 13 : Feuille Qualité fonctionnelle + périphériques + volume + recréation de contexte

**Files:**
- Modify: `src/main/audio/devices.ts` (énumération fine), `src/main/ipc.ts`, `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/audio/engine.ts` (rebuild de contexte + volume), `src/renderer/App.tsx`, `src/renderer/state/player.ts`
- Create: `src/renderer/components/QualitySheet.tsx`
- Test: `tests/devices.test.ts` (ajouts), `tests/engine.test.ts` (ajouts)

**Interfaces:**
- Consumes: moteur (Task 12), `defaultOutputDevice` (Phase 1).
- Produces:
  - `listOutputDevices(): Promise<AudioDeviceInfo[]>` (Main : énumération fine, repli sur le défaut sans exception).
  - `qualitySampleRate(mode: QualityMode, deviceRate: number | undefined): number` (PUR) — `max`/`balanced` → `deviceRate` (repli 48000/44100), `economy` → 44100.
  - Engine : `setVolume(v01: number)` (gain linéaire, hors des fondus anti-clic) ; `rebuildContext(newContext, decoder)` — **hors lecture** : mémorise `trackId`+position, reconstruit le graphe sur le nouveau contexte, recharge la piste, se repositionne **en pause** à la position. (L'`App` crée le nouveau `AudioContext({sampleRate})` et appelle `rebuildContext`.)
  - IPC `audio:list-devices`. `QualitySheet` (DA, focus-trap) : source affichée, périphérique choisi, 3 modes, volume ; persistance du mode/volume (Task 14).
- *(Décision : un seul contexte à la fois ; le changement de mode recrée proprement le contexte, jamais pendant la lecture — on met en pause, on reconstruit, on reste en pause.)*

- [ ] **Step 1 : Tests** — `devices` : `listOutputDevices` renvoie un tableau non vide (ou repli nommé) sans exception. `engine` : `setVolume(0.5)` met `gain.value≈0.5` hors fondu ; `qualitySampleRate("economy",48000)===44100`, `("max",96000)===96000`, `("balanced",undefined)` → repli défini ; `rebuildContext` (contextes mockés) conserve `trackId` et repositionne à la position mémorisée en `paused`.
- [ ] **Step 2 : Échec** — `npm run test -- devices engine`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** l'énumération fine, `setVolume`, `qualitySampleRate`, `rebuildContext`, le canal devices, et `QualitySheet`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP)** — app + une piste chargée à une position > 0, en pause ; `check:cdp` : déclencher un changement de mode (recréation de contexte), vérifier `getState().trackId` conservé, `positionSec` ≈ la position d'avant, `status:"paused"`, et `window`-level : un seul `AudioContext` actif (pas de fuite). 
- [ ] **Step 6 : Commit** — `feat: functional quality sheet + device list + volume + clean context rebuild`.

---

### Task 14 : Persistance complète de l'état + reprise au lancement + veille de dossiers

> Cette tâche porte DEUX livrables liés par l'état applicatif ; elle est scindée en 14A (persistance) et 14B (veille), chacune avec son cycle de test et son commit.

#### Task 14A : Persistance de l'état + reprise au lancement

**Files:**
- Create: `src/renderer/lib/persist.ts`
- Modify: `src/main/library/repository.ts` (`app_state` get/set), `src/main/ipc.ts` (`state:get`/`state:set`), `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`, `src/renderer/state/player.ts`
- Test: `tests/persist.test.ts`, `tests/repository.test.ts` (ajouts)

**Interfaces:**
- Consumes: Tasks 12, 13 (shuffle/repeat/volume/quality à sauver), sources (Task 5).
- Produces:
  - Repository : `getState(db, key): string | undefined`, `setState(db, key, value)` (upsert `app_state`).
  - `serializeState(player): PersistedState` et `restoreState(raw): PersistedState | null` (PUR, valide/ignore un état corrompu) — `PersistedState` = `{ queueTrackIds, currentIndex, positionSec, shuffle, repeat, volume, qualityMode, nowPlayingOpen }`.
  - IPC `state:get`/`state:set`. `App` : **sauvegarde debouncée** (≥1 s) de l'état ; au démarrage, restaure la file (re-résolution des ids en `TrackRow` via la DB), **charge la piste courante en pause à `positionSec`** (aucun son automatique).
- *(Décision : reprise en pause ; une file dont des ids ont disparu est filtrée proprement.)*

- [ ] **Step 1 : Tests** — `persist` : `restoreState(serializeState(p))` reconstruit les champs ; `restoreState("{bad json")===null` ; `restoreState('{"positionSec":"x"}')` → `null` ou champs assainis (jamais d'exception). `repository` : `setState("k","v")` puis `getState("k")==="v"`, upsert idempotent.
- [ ] **Step 2 : Échec** — `npm run test -- persist repository`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** le get/set `app_state`, `serialize/restoreState`, les canaux, la sauvegarde debouncée et la restauration-en-pause au démarrage (remplace le `KNOWN_LIBRARY` codé en dur par les `sources` persistées ; au 1er lancement sans source, proposer l'ajout).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP)** — app : lancer une file, jouer, se mettre à ~30 s, fermer ; rouvrir ; `check:cdp` : `getState().trackId` = la piste d'avant, `positionSec≈30`, `status:"paused"`, la file restaurée (longueur identique). Exit 0 si la reprise est fidèle.
- [ ] **Step 6 : Commit** — `feat: full playback-state persistence + resume (paused) on launch`.

#### Task 14B : Veille de dossiers (chokidar, re-scan incrémental)

**Files:**
- Create: `src/main/library/watcher.ts`
- Modify: `src/main/index.ts` (démarrer/arrêter la veille sur les sources), `src/main/ipc.ts` (push `library:changed`), `src/shared/{types,channels}.ts`, `src/preload/index.ts` (`onLibraryChanged`), `src/renderer/App.tsx` (rafraîchir sans couper le son), `package.json` (ajouter `chokidar` épinglé)
- Test: `tests/watcher.test.ts`

**Interfaces:**
- Consumes: indexeur incrémental (Task 4), sources (Task 5).
- Produces:
  - `createWatcher(roots, { indexOne, removeOne, onChanged, debounceMs, watch })` — `watch` (fabrique chokidar) injectable ; agrège `add`/`change`/`unlink` par **debounce** (défaut ~1000 ms), appelle `indexOne(path)` / `removeOne(path)` par lot, puis `onChanged(summary)` ; ne **jamais** throw (erreurs par fichier comptées, watcher survit) ; `close()` propre.
  - IPC push : Main envoie `library:changed` via `webContents.send` ; `window.benten.onLibraryChanged(cb): () => void`. `App` se réabonne et **re-`reload()`** la vue (la lecture continue : on ne touche pas au moteur).
- *(Review Focus : rafale/album entier, fichier en écriture, suppression → agrégation, pas de crash, lecture non interrompue.)*

- [ ] **Step 1 : Tests** — `watcher` (chokidar mocké via `watch` injecté, faux timers) : émettre `add` ×5 rapprochés → un **seul** lot `indexOne` après le debounce puis `onChanged` appelé une fois ; un `unlink` → `removeOne` ; `indexOne` qui throw sur un fichier → les autres sont tout de même traités et le watcher ne rejette pas ; `close()` ferme la fabrique.
- [ ] **Step 2 : Échec** — `npm run test -- watcher`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** `watcher.ts` (agrégation/debounce/robustesse), le câblage dans `index.ts` (un watcher sur les `sources`, redémarré quand les sources changent), le push IPC + `onLibraryChanged`, le rafraîchissement UI, et épingler `chokidar`.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : VÉRIF RÉELLE (CDP, Review Focus)** — app + biblio indexée, une piste en lecture ; **copier** (lecture seule préservée : on copie DANS une source de test, jamais la vraie biblio) un FLAC dans un sous-dossier surveillé → `check:cdp` confirme qu'il apparaît dans la biblio (count +1) **et** que `getState().status` est resté `playing`/`trackId` inchangé ; **supprimer** la copie → disparaît (count −1). Nettoyer les fichiers de test créés.
- [ ] **Step 6 : Commit** — `feat: folder watching (chokidar) + incremental re-scan + live refresh`.

---

## Auto-revue (effectuée)

**1. Couverture spec.** Correctifs §3 : schéma v2/NOCASE (T2), albumArtist/discNo grouping (T3), saut pochette + removeTracks (T4), confinement read-file (T5), focus-trap + throttle + rôle .player (T6). Features §4 : recherche (T7), tri/filtre (T8), favoris (T9), playlists (T10), file visible (T11), shuffle/repeat (T12), qualité+périphériques+volume+rebuild (T13), persistance/reprise (T14A), veille (T14B). Câblage barre de recherche (T7) et nav playlists/favoris (T9, T10). Infra CDP (T1). **Aucun élément §4/§3 sans tâche.**

**2. Steps.** Chaque step décide une chose (nom/signature/valeur ou test nommé) ; les corps sont laissés à l'implémenteur sauf là où l'algo est fixé (Fisher-Yates seedé, recompactage de positions) — décrit en une ligne, pas transcrit.

**3. Cohérence des types.** `TrackRow` étendu une fois (T2) et réutilisé ; `updateQueue` (T11) réutilisé par T12 ; `order.ts` défini (T12) et consommé par le moteur ; `PersistedState` défini (T14A) ; `RepeatMode`/`QualityMode` nommés une fois dans `types.ts`. `rebuildContext` (T13) et `setVolume` cohérents avec `AudioEngine` Phase 1.

**4. Review Focus.** Migration peuplée → T2 s.5 ; read-file hors racines/symlink/frontière → T5 s.1/s.5 ; mutation de file future sans coupure → T11 s.1/s.5 ; shuffle/repeat + illisible + rafale → T12 s.1 ; rafale de veille → T14B s.1. Chacun a son test dans la tâche propriétaire.

**5. Proportion.** Plan ≈ même ordre de grandeur que la spec ; signatures + noms de tests + assertions, corps délégués. Pas de transcription.
