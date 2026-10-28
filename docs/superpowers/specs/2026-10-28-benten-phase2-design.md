# Benten — Document de conception, Phase 2 (le vrai lecteur complet)

Date : 2026-10-28
Statut : **approuvé pour construction** (l'utilisateur a demandé « lance »)

> Ce document raffine le design global (`2026-10-28-benten-design.md`, périmètre
> Phase 2 = §8) en décisions d'implémentation concrètes, ancrées sur le code réel de
> la Phase 1. Il sert de base au plan (`superpowers:writing-plans`). Tout reste
> **100 % local** : aucun réseau, aucun push, aucune PR — comme en Phase 1.

---

## 1. Intention et pourquoi

La Phase 1 a livré un socle jouable : scan + index SQLite, grille d'albums
virtualisée, moteur Web Audio **gapless à l'échantillon près** et sans clic,
feuille qualité informative, index persistant. Mais ce n'est pas encore un
lecteur qu'on *vit* au quotidien : on ne peut pas chercher un morceau, se faire
une playlist, mettre un favori, voir sa file d'attente, lancer un shuffle, ni
reprendre là où on s'est arrêté ; et un ajout de fichier dans la bibliothèque
n'apparaît qu'au prochain re-scan manuel.

La Phase 2 transforme le socle en **lecteur complet** : recherche, tri/filtre,
file d'attente visible, playlists, favoris, lecture aléatoire/répétition, veille
de dossiers (re-scan incrémental), feuille qualité **fonctionnelle** + détection
fine des périphériques, et **persistance complète de l'état de lecture** (reprise
exacte). On câble aussi la barre de recherche et la navigation que la Phase 1
affichait grisées (« bientôt »).

**Le but reste la sensation + la fiabilité** : chaque feature doit respecter les
invariants audio de la Phase 1. Aucune feature ne vaut un seul bug de son.

---

## 2. Invariants non négociables (hérités de la Phase 1)

Ces propriétés sont **prouvées** en Phase 1 et doivent rester vraies après chaque
tâche de la Phase 2 :

- **Zéro bug audio.** Pas de clic, de blanc, de grésillement, de désync, de
  superposition, même en spammant suivant/précédent.
- **Gapless à l'échantillon près.** L'enchaînement album/mix reste sans trou. Les
  nouveautés (shuffle, repeat, queue réordonnée, playlists) **passent par le même
  chemin de programmation `scheduleNext`/`promoteScheduled`** du moteur — on ne crée
  pas un second chemin de lecture.
- **Fichiers en lecture seule.** Benten **lit** les fichiers, ne les modifie,
  déplace ni supprime **jamais**. La veille de dossiers observe le disque ; elle ne
  touche qu'à l'**index SQLite**, jamais aux fichiers.
- **Un seul `AudioContext`, une seule boucle `tick()`.** Pas de second contexte, pas
  de timer interne concurrent. Le changement de fréquence (feuille qualité) est la
  **seule** exception et recrée le contexte proprement, hors lecture.
- **DRM / illisible** : `.m4p` et fichiers non décodables restent marqués
  `playable:false`, jamais lus, jamais de son parasite, jamais de crash. Ils sont
  sautés silencieusement par la file (y compris en shuffle/repeat).
- **Hors-ligne total, thème sombre unique, DA Benten** (`#e73c82` magenta mat,
  tokens de `src/renderer/theme/tokens.css` portés de `design/benten-prototype.html`).

---

## 3. Correctifs Phase-1 à intégrer (repérés en revue)

Chacun est rattaché à une tâche du plan et doit être couvert par un test ou une
vérification réelle.

1. **Schéma v2 — `albumArtist` + `discNo`.** Ajouter `album_artist` et `disc_no` à
   `tracks` (migration v1→v2, non destructive). Le **regroupement d'albums** utilise
   `albumArtist` quand il existe (sinon `artist`) → compilations / « various
   artists » et albums multi-disques groupent correctement, et le tri intra-album
   devient `(disc_no, track_no, title)`. `metadata.ts` extrait ces deux champs des
   tags (Vorbis `ALBUMARTIST`/`DISCNUMBER`), avec repli `null`.

2. **Schéma v2 — collation NOCASE sur les index de tri.** Les `ORDER BY ... COLLATE
   NOCASE` existants (`repository.ts`) ne sont pas servis par les index actuels
   (`idx_tracks_artist`, `idx_tracks_title` sans collation). Recréer ces index en
   **`COLLATE NOCASE`** pour que le tri casse-insensible soit indexé.

3. **Sécurité — confiner `audio:read-file` aux racines indexées.** Aujourd'hui
   (`src/main/ipc.ts` `validateAudioPath`) tout chemin absolu existant est lisible et
   les liens symboliques sont suivis. Phase 2 : le fichier demandé doit être
   **contenu dans une des racines persistées** (table `sources`), **après résolution
   des liens** (`fs.realpathSync` sur le fichier **et** sur la racine ; comparaison de
   préfixe sur chemins normalisés, séparateur inclus pour éviter `/library` vs
   `/library-evil`). Hors racines → rejet. `assertTrusted` continue de garder
   l'appelant.

4. **Perf — throttle de la boucle position / `tick()` sous 60 Hz.** La boucle rAF
   d'`App.tsx` appelle `engine.tick()` + `setPosition` **à chaque frame**. Phase 2 :
   cadencer `tick()` et la mise à jour de position à **~15 Hz** (≈ toutes les 66 ms)
   via accumulation de temps dans la boucle rAF — assez pour une barre fluide et le
   préchargement, sans re-render du lecteur 60 fois/s. `PRELOAD_LEAD_SEC = 10 s` rend
   15 Hz largement suffisant pour la programmation gapless.

5. **a11y — focus trap + rôle du `.player`.** Les dialogues **Now-Playing** et
   **Qualité** (et les nouveaux : file d'attente, playlists) piègent le focus
   (Tab/Shift-Tab cyclent dedans, `Esc` ferme, focus restauré à la fermeture,
   `role="dialog"` + `aria-modal`). Corriger le `.player` (mini-lecteur) qui imbrique
   des éléments interactifs dans un conteneur lui-même interactif/mal rôlé.

6. **Perf — ne pas re-parser la pochette si `artKey` déjà valide.** À la ré-indexation
   (`indexer.ts`), si la ligne `tracks` existe déjà avec un `art_key` non nul **et** que
   le fichier n'a pas changé (même `mtime`/taille, cf. veille), **sauter** l'appel
   `getArt`. Ne ré-extraire que les pochettes manquantes ou les fichiers modifiés.

---

## 4. Périmètre fonctionnel Phase 2

### 4.1 Modèle de données (SQLite v2)

Nouvelles colonnes et tables (migration additive depuis v1 ; aucune perte) :

- `tracks` : `+ album_artist TEXT`, `+ disc_no INTEGER`, `+ mtime_ms INTEGER`,
  `+ size_bytes INTEGER` (les deux derniers pour la veille incrémentale et le saut
  de ré-extraction de pochette). `albums` groupe désormais par
  `(COALESCE(album_artist, artist), title)` — nouvelle logique d'upsert.
- `sources (id, path UNIQUE, added_at)` — racines de bibliothèque persistées.
- `playlists (id, name, created_at, updated_at)` et
  `playlist_tracks (playlist_id, track_id, position, PRIMARY KEY(playlist_id, position))`
  avec `ON DELETE CASCADE` depuis `playlists` et `tracks`.
- `favorites (track_id PRIMARY KEY, added_at)` avec `ON DELETE CASCADE` depuis `tracks`.
- `app_state (key TEXT PRIMARY KEY, value TEXT)` — magasin clé/valeur JSON pour l'état
  de lecture persistant et les réglages légers (mode qualité, volume, shuffle/repeat).

**Décision (ma décision) :** playlists et favoris référencent `tracks.id`. L'upsert
sur `path` **conserve l'id** d'une piste ré-indexée (`ON CONFLICT(path)`), donc une
re-scan ne casse ni favoris ni playlists ; seule une **vraie suppression** de fichier
(veille) retire la piste et, en cascade, ses appartenances. Acceptable pour un usage
local mono-utilisateur.

### 4.2 Recherche

- Recherche **incrémentale** (debounce ~150 ms) sur titre / artiste / album.
- **Décision (ma décision) :** `LIKE` casse-insensible (`COLLATE NOCASE`) sur les
  colonnes indexées, pas de FTS5. ~1000 titres → largement assez rapide, et on évite
  la complexité d'un index FTS natif. Requête `library:search(q, {limit})` renvoyant
  des pistes (groupables en albums côté UI). Échappement des métacaractères `LIKE`
  (`%`, `_`).
- Câble la barre de recherche de `App.tsx` (retrait de `disabled`/`soon`).

### 4.3 Tri / filtre

- Albums : tri par **titre**, **artiste**, **date d'ajout** (nouveau `added_at` dérivé
  du `MIN(track.id)` ou d'un `created_at` d'album — **décision :** ajouter
  `albums.created_at`), **durée totale**. Ordre asc/desc.
- Pistes : tri par titre / artiste / album / durée / n° de piste.
- Filtres : **favoris uniquement**, et optionnellement par format/qualité (ex.
  « lossless seulement »). Les arguments de tri/filtre étendent `LibraryQueryArgs`
  (`sort`, `dir`, `filter`) de façon rétrocompatible.

### 4.4 File d'attente (queue) visible

- Panneau latéral/sheet montrant la file courante : piste en cours mise en évidence,
  pistes à venir, pistes passées grisées.
- Actions : **jouer maintenant** (jump), **retirer**, **réordonner** (glisser-déposer
  ou boutons haut/bas), **lire ensuite** / **ajouter à la file** depuis un album/piste.
- La file est la **source de vérité partagée** entre store et moteur (déjà le cas en
  Phase 1 : `engine.setQueue` + `playerStore`). Les mutations de file passent par des
  actions du store qui se répercutent dans le moteur **sans interrompre la lecture de
  la piste courante** (réordonner/retirer une piste *future* ne doit pas couper le
  son ; ça invalide seulement la programmation `scheduled`/`preload` si la *suivante*
  change — on re-pompe proprement).

### 4.5 Playlists

- CRUD : créer, renommer, supprimer ; ajouter / retirer / réordonner des pistes.
- Jouer une playlist (remplit la file). Persistées en SQLite.
- Entrée de navigation « Playlists » câblée. IPC `playlists:*`.

### 4.6 Favoris

- Toggle favori sur une piste (cœur). Vue « Favoris » (= file jouable). Filtre
  « favoris uniquement » dans les listes. IPC `favorites:*`.

### 4.7 Lecture aléatoire & répétition

- **Repeat** : `off` / `all` / `one`. **Shuffle** : `on` / `off`.
- **Décision (ma décision), au cœur de l'audio :** le moteur gagne un **ordre de
  lecture** `order: number[]` (permutation des indices de `queue`) et un `orderPos`.
  Toute la logique existante (`findPlayableFrom`, `onCurrentSourceEnded`, `pump`,
  `next`/`prev`) parcourt désormais `order` au lieu des indices bruts. `shuffle`
  régénère `order` (Fisher-Yates) en **gardant la piste courante en tête** ;
  l'éteindre restaure l'ordre naturel en repositionnant `orderPos` sur la piste
  courante. `repeat:one` reprogramme la **même** piste comme « suivante » (gapless
  boucle) ; `repeat:all` fait boucler `order` en fin de file ; `repeat:off` s'arrête
  en fin de file comme aujourd'hui. **Contrainte ferme :** on réutilise
  `scheduleNext`/`promoteScheduled` — pas de nouveau chemin de lecture. Tâche isolée,
  tests unitaires lourds (ordre, saut d'illisibles, bornes, rafale next/prev) +
  **vérification réelle CDP** (gapless shuffle, repeat-one sans clic, repeat-all en
  boucle).

### 4.8 Veille de dossiers (re-scan incrémental)

- **Décision (ma décision) :** `chokidar` (épinglé) côté **Main**, un watcher par
  racine persistée, `ignoreInitial: true`, **debounce ~1 s** pour regrouper les
  rafales (copie d'album).
- `add`/`change` → `readMetadata` (+ pochette si `artKey` manquant ou `mtime`/taille
  changés) → upsert. `unlink` → `removeTracks([path])` + purge des albums/artistes
  devenus vides (cascade favoris/playlists). `addDir`/`unlinkDir` gérés par agrégation
  des événements fichier.
- Émet un **événement IPC** `library:changed` (push Main→Renderer) ; l'UI rafraîchit
  la vue courante **sans interrompre la lecture** et sans re-scan bloquant.
- Robustesse : un fichier en cours d'écriture / verrouillé est réessayé ; une erreur
  de lecture est comptée et ignorée (jamais de crash du watcher).

### 4.9 Feuille Qualité fonctionnelle + détection fine des périphériques

- **Détection fine :** au-delà du périphérique par défaut, énumérer les sorties
  (`navigator.mediaDevices.enumerateAudioOutputDevices` côté Renderer et/ou API OS
  côté Main) avec leurs capacités connues (fréquence). Afficher la source par piste
  (déjà fait : `QualityBadge`) **et** la sortie choisie.
- **Modes fonctionnels (dans les limites de Web Audio, honnêteté de la Phase 1) :**
  - **Fidélité maximale** : `AudioContext` à la fréquence native du périphérique,
    aucun resample inutile, gain linéaire.
  - **Équilibré** : suit la fréquence par défaut du périphérique.
  - **Économe** : `AudioContext` à fréquence réduite (ex. 44,1 kHz forcé).
  - Changer de mode/fréquence **recrée l'`AudioContext`** (API Web Audio : la
    fréquence est fixée à la création) **proprement, hors lecture** : on mémorise
    piste+position, on reconstruit le moteur, on recharge, on reprend à la position —
    sans clic, sans double contexte. **Toujours pas de bit-perfect / WASAPI exclusif**
    (addon natif = plus tard, cf. design §5.5).
- Réglage **volume** (gain) persistant.

### 4.10 Persistance complète de l'état de lecture

- Sauver dans `app_state` (debouncé) : piste courante (id), **position**, file
  (liste d'ids), `orderPos`/seed de shuffle, modes shuffle/repeat, volume, mode
  qualité, vue/navigation courante, `nowPlayingOpen`.
- Au démarrage : restaurer la file et la piste, **se positionner à la position
  sauvegardée en pause** (on ne redémarre pas le son tout seul — reprise *prête*, pas
  *jouante*, sauf si l'utilisateur préfère ; **décision :** reprise en **pause** à la
  bonne position, respect de l'attente « reprends où tu t'es arrêté » sans son
  surprise au lancement).
- Les sources persistées (table `sources`) remplacent le `KNOWN_LIBRARY` codé en dur
  d'`App.tsx` : au 1er lancement sans source, on propose d'ajouter un dossier ; ensuite
  on recharge les sources mémorisées et on lance la veille.

---

## 5. Architecture & conventions (inchangées depuis la Phase 1)

- **Process** : Main (Node, disque/IPC/SQLite/veille) ↔ preload (`contextBridge`,
  `window.benten` typé) ↔ Renderer (React, moteur Web Audio, state Zustand).
- **IPC** typé par canaux `invoke` + **nouveaux canaux** regroupés par domaine
  (`playlists:*`, `favorites:*`, `library:search`, `sources:*`, `state:*`) **plus un
  canal push** `library:changed` (Main→Renderer via `webContents.send`, exposé par un
  `onLibraryChanged(cb)` dans `window.benten`). Tous gardés par `assertTrusted`.
- **Logique testable isolée** : schéma/requêtes DB, parsing métadonnées, **math
  d'ordre shuffle/repeat**, machine de file — modules **purs**, Vitest. Les appels
  Web Audio réels restent derrière `AudioContext`/`Decoder` mockables ; les propriétés
  réelles (gapless shuffle, reprise, veille) ont des **vérifications réelles** (dev
  Electron + CDP) explicites.
- **Types partagés** étendus dans `src/shared/types.ts` (jamais dupliqués) :
  `PlaylistRow`, `RepeatMode`, `QualityMode`, `SearchArgs`, extension de `TrackRow`
  (`albumArtist`, `discNo`), `PersistedState`, etc.
- **Versions épinglées.** Nouvelle dépendance : **`chokidar`** (version exacte). Rien
  d'autre.
- **Commits** terminés par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Méthode** : `superpowers:subagent-driven-development` — implémenteur frais +
  reviewer indépendant **Opus** par tâche, suite de tests complète + **vérif
  Electron/CDP réelle** par tâche, revue de branche finale, puis fusion **locale**
  dans `main` et `superpowers:finishing-a-development-branch`.

---

## 6. Non-objectifs / anti-objectifs (Phase 2)

- Pas de bit-perfect / WASAPI exclusif (addon natif = plus tard).
- Pas de mobile, de streaming, de comptes, de cloud, de synchro.
- Pas d'édition de tags ni de renommage/déplacement de fichiers (lecture seule).
- Pas de formats exotiques (ALAC/DSD) ni de paroles/égaliseur (post-v1).
- Pas de séquence de lancement animée ni d'empaquetage installeur → **Phase 3**.
- **Anti-objectif :** toute régression audio (clic, trou gapless, désync,
  superposition, son au lancement non voulu) fait échouer la Phase 2 même si les
  features « marchent ».

---

## 7. Laissé au constructeur (décidable sans l'utilisateur)

- Détail exact des canaux IPC et noms de colonnes/index.
- Choix fin de la lib de drag-and-drop pour la file/playlists (ou boutons haut/bas
  sans dépendance — préférence : **sans nouvelle dépendance UI** si possible).
- Forme précise du magasin `app_state` (clés, cadence de debounce).
- Découpage exact en tâches et ordre (le plan le fixe), tant que les invariants §2 et
  les correctifs §3 sont tenus et vérifiés.
- Stratégie fine de la veille (agrégation d'événements, délais de retry).

---

## 8. Décisions prises par moi (à relire)

- **Recherche = `LIKE` NOCASE** (pas FTS5) — suffisant à cette échelle, zéro build natif.
- **Playlists/favoris par `track_id`**, cascade sur suppression réelle de fichier.
- **Shuffle/repeat via un `order[]` dans le moteur existant**, même chemin gapless.
- **Changement de fréquence = recréation propre de l'`AudioContext` hors lecture.**
- **Reprise au lancement en pause** à la position sauvegardée (pas de son surprise).
- **`chokidar`** pour la veille, un watcher par racine, debounce ~1 s.
- **Throttle position/tick à ~15 Hz.**
- **Confinement `audio:read-file` aux racines persistées, liens résolus.**
