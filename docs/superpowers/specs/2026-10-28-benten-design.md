# Benten — Document de conception

*Lecteur de musique local, hors-ligne, haute-fidélité. v1 = desktop (Windows d'abord).*

Date : 2026-10-28
Statut : **à valider** (rien n'est construit tant que ce doc n'est pas approuvé)

---

## 1. Intention et pourquoi

Benten est un lecteur de musique **local et hors-ligne** pour une collection de
fichiers déjà possédés par l'utilisateur. L'objectif n'est pas « un lecteur de
plus » : c'est un lecteur **sans compromis** sur deux axes que les lecteurs
gratuits bâclent — la **fiabilité de lecture** (jamais de coupure, de grésillement,
de bug au changement de piste) et la **sensation** (une direction artistique forte,
du motion design partout, une fluidité type Apple).

L'utilisateur possède une bibliothèque essentiellement **sans perte** (FLAC
24-bit/44,1 kHz, ~970 morceaux) et veut l'écouter dans un objet beau, rapide et
fiable, sur PC d'abord, puis sur téléphone.

Le nom vient de **Benzaiten (弁才天)**, déesse japonaise de la musique et de tout
ce qui coule (eau, mots, son). Il ancre la direction artistique.

**Contexte d'origine.** L'utilisateur dispose aujourd'hui d'un lecteur fourni
(« Prism »). Benten n'en dérive **rien** : ni design, ni métadonnées, ni code, ni
format de bibliothèque. La seule chose partagée est l'emplacement physique des
**fichiers musicaux de l'utilisateur**, qui se trouvent dans ce dossier et sont sa
propriété. Benten les **lit** pour les jouer ; il ne lit ni ne réutilise les données
internes de Prism.

---

## 2. Objectifs / Non-objectifs / Anti-objectifs

### Objectifs (v1)
- Lire une bibliothèque locale de fichiers audio, **FLAC en priorité**, sans aucun
  défaut de lecture (pas de clic, de blanc, de désync, de plantage en changeant
  de piste rapidement et répétitivement), **et un vrai enchaînement gapless**
  (morceaux qui se collent sans silence, pour les mixes/albums continus).
- Scanner un ou plusieurs **dossiers** choisis par l'utilisateur, en extraire une
  bibliothèque structurée (artistes, albums, titres, pochettes, durées, qualité).
- **Détecter et afficher la vraie qualité** de chaque fichier (format, profondeur,
  fréquence d'échantillonnage) et proposer un réglage de **fidélité de sortie**
  adapté au matériel — sans jamais prétendre dépasser la source.
- Direction artistique **mythologie japonaise / sumi-e**, accent **magenta mat**,
  fond nuit épuré, **motion design** soigné (lancement, transitions, écran de
  lecture) — le look déjà validé en maquette.
- Interface complète d'un vrai lecteur : accueil, recherche, albums, titres,
  artistes, **playlists**, **file d'attente**, **favoris**, lecture aléatoire/répétition,
  mini-lecteur persistant, écran de lecture plein écran.
- **Fluidité** irréprochable sur une bibliothèque de ~1000 titres (listes
  virtualisées, pochettes en chargement paresseux, animations GPU).
- Architecture pensée pour **ajouter des formats et le mobile plus tard** sans
  tout casser (registre de décodeurs extensible, cœur partageable).

### Non-objectifs (v1, à faire plus tard)
- Application mobile (téléphone) — l'architecture la prépare, mais la v1 est desktop.
- Streaming / services en ligne, comptes, bibliothèque cloud, synchronisation
  multi-appareils.
- Formats exotiques (ALAC, DSD, APE…) — le registre de décodeurs est prêt à les
  recevoir, mais la v1 couvre ce que l'utilisateur possède réellement.
- Paroles synchronisées, égaliseur avancé, scrobbling — candidats post-v1.
- Édition de tags / gestion/renommage de fichiers.

### Anti-objectifs (feraient échouer le projet même si ça « marche »)
- **Tout bug de lecture ou de son** : un seul grésillement/coupure récurrent ruine
  la promesse. La fiabilité audio prime sur toute fonctionnalité.
- **Une DA générique ou « IA ».** Le look doit être singulier et assumé.
- **De la latence ou du jank** à l'ouverture, au changement de piste, au scroll.
- **Contournement de DRM.** Les fichiers protégés (p. ex. `.m4p`) ne sont pas
  « crackés » : ils sont détectés et présentés comme non lisibles, proprement.
- Toucher, copier ou dépendre des données internes du lecteur Prism.

---

## 3. Public et plateforme

- **Utilisateur** : une personne, sa propre machine, sa propre musique. Pas de
  multi-utilisateur, pas de serveur.
- **Plateforme v1** : desktop, **Windows en priorité** (Windows 11), l'architecture
  Electron restant portable macOS/Linux.
- **Hors-ligne total** : aucune requête réseau nécessaire au fonctionnement (les
  pochettes et métadonnées viennent des fichiers et des dossiers).

---

## 4. Ce qu'on sait de la bibliothèque réelle (mesuré)

Scan en lecture seule du dossier fourni (bibliothèque « profil ») :

- **~969 fichiers, 100 % FLAC** dans la bibliothèque principale.
- Échantillon mesuré : **FLAC 24-bit / 44 100 Hz** (lossless, profondeur studio).
- Tous dossiers/copies confondus : 1318 FLAC, 32 MP3, 18 WAV, 5 m4a, **2 m4p
  (DRM, non lisibles)**, 1 ogg, 1 aiff.
- Arborescence type : `.../<Artiste>/<Album>/NN - Titre.flac` — exploitable pour
  regrouper, avec repli sur les tags FLAC (Vorbis comments) pour artiste/album/
  titre/numéro, et pochette embarquée ou `cover.*`/`folder.*` du dossier.
- Contenu : beaucoup de phonk/montagem brésilien, rap FR/US, nombreuses versions
  « slowed / super slowed ».

**Conséquence de conception** : le moteur v1 est optimisé pour **FLAC lossless**
(décodage natif Chromium), avec prise en charge native de MP3/WAV/M4A-AAC/OGG/
AIFF, détection propre des `.m4p` protégés, et un registre extensible pour la suite.

---

## 5. Architecture technique

### 5.1 Stack (choix retenu avec l'utilisateur)
- **Electron** (process principal Node.js + process de rendu Chromium).
- **React + TypeScript**, bundlé par **Vite** (via `electron-vite`).
- **Raison** : accès complet au système de fichiers pour lire directement les
  dossiers de musique, décodage audio natif de Chromium (dont FLAC), réutilisation
  directe du look HTML/CSS déjà validé, et chemin naturel vers le mobile ensuite
  (le cœur UI/logique React se repartage avec React Native/Capacitor plus tard).

### 5.2 Découpage en process
- **Main (Node)** : cycle de vie app, fenêtre, accès disque, scan de bibliothèque,
  extraction de métadonnées, index persistant, détection matériel audio, IPC.
- **Preload** : pont `contextBridge` sûr (pas de `nodeIntegration` dans le rendu) —
  expose une API typée minimale au rendu.
- **Renderer (React)** : toute l'UI, le moteur de lecture Web Audio, le motion,
  l'état applicatif.
- **IPC** typé et nommé (`library:scan`, `library:query`, `audio:devices`,
  `art:get`, etc.), par **canaux à réponse** (`ipcRenderer.invoke`).

### 5.3 Modèle de bibliothèque
- **Sources** : l'utilisateur ajoute un ou plusieurs dossiers racine. Par défaut,
  on propose d'ajouter le dossier de sa musique existante. Les sources sont
  mémorisées.
- **Scan** : parcours récursif, filtré par extensions connues ; extraction de tags
  (via une bibliothèque de métadonnées de type `music-metadata`), durée, qualité
  (format + profondeur + fréquence depuis l'en-tête), pochette embarquée.
- **Index persistant** : base locale **SQLite** (`better-sqlite3`) — tables
  artistes/albums/titres/playlists/état. Permet de rouvrir instantanément sans
  re-scanner, et de requêter/filtrer ~1000+ titres sans latence.
- **Veille** : surveillance des dossiers (`chokidar` ou équivalent) pour refléter
  ajouts/suppressions sans re-scan complet.
- **Pochettes** : extraites et mises en cache en vignettes (plusieurs tailles) sur
  disque, servies au rendu par un protocole custom (`benten-art://`), pour un
  rendu fluide des grilles.

### 5.4 Moteur audio (le cœur de la promesse « zéro bug »)
- **Décodage** : priorité au décodage **natif** du moteur Chromium
  (FLAC, MP3, WAV, M4A/AAC, OGG/Opus, AIFF). 
- **Lecture** : `AudioContext` Web Audio comme graphe de sortie (gain, analyser
  pour visualiseur, futur égaliseur), alimenté par la source décodée. Deux pistes
  possibles à trancher au moment du plan :
  - **A — `MediaElementAudioSourceNode`** (élément `<audio>` relié au graphe) :
    simple, streaming fichier, faible mémoire ; le changement de piste et le
    gapless demandent un soin particulier.
  - **B — `AudioBufferSourceNode`** (fichier décodé en mémoire) : contrôle total,
    **gapless** et changement de piste instantanés et sans glitch, au prix de la
    mémoire ; adapté à des morceaux de quelques minutes.
  **Décision (confirmée avec l'utilisateur) : le vrai gapless est une exigence
  v1.** On retient l'**option B** pour la piste courante **et le préchargement +
  décodage de la suivante**, avec **planification à l'échantillon près** sur
  l'horloge de l'`AudioContext` : la source suivante est programmée pour démarrer
  exactement à la fin de la courante, sans aucun silence. La bibliothèque étant
  homogène en 44,1 kHz, l'enchaînement se fait sans rééchantillonnage. Objectif
  ferme également : **changement manuel sans clic ni blanc, même en spammant
  suivant/précédent** (annulation propre des sources en vol, fondu anti-clic de
  quelques millisecondes, un seul graphe réutilisé). Repli A (élément `<audio>`)
  réservé aux fichiers anormalement longs, hors chaîne gapless.
- **Registre de décodeurs extensible** : interface `Decoder` (peut décoder ? →
  décode) ; implémentation native par défaut ; emplacement prêt pour ALAC/DSD via
  WASM ou module natif **plus tard**, sans toucher au reste.
- **DRM / illisibles** : `.m4p` et fichiers non décodables sont détectés au scan,
  marqués « protégé / non lisible », exclus de la lecture et signalés proprement
  (jamais de plantage, jamais de bruit).
- **Robustesse** : fichier manquant/corrompu → message clair + passage au suivant ;
  jamais de son parasite ; buffer et états d'erreur explicites.

### 5.5 Fidélité / sélection de qualité
- **Source détectée** par fichier (ex. « FLAC · 24-bit / 44,1 kHz »), affichée.
- **Sortie détectée** : périphériques et leurs capacités (fréquence/profondeur)
  listés côté Main.
- **Modes** :
  - **Fidélité maximale** — vise le rendu le plus proche de la source (idéalement
    bit-perfect / fréquence native quand le matériel le permet).
  - **Équilibré** — suit la fréquence du périphérique (défaut raisonnable).
  - **Économe** — ré-échantillonnage à la baisse, moins de ressources.
- **Honnêteté technique à documenter dans l'UI** : Web Audio ré-échantillonne vers
  la fréquence de l'`AudioContext`, donc le **vrai bit-perfect / mode exclusif
  WASAPI** sur Windows dépasse ce que Chromium offre nativement. **Décision** : v1
  = meilleure qualité possible via Web Audio (fréquence d'`AudioContext` calée sur
  le périphérique, pas de resample inutile, gain en linéaire) ; **bit-perfect/
  exclusif WASAPI via module natif de sortie = chantier phase 2** (non promis en
  v1). On n'affiche jamais une qualité qu'on ne délivre pas réellement.

### 5.6 État applicatif et persistance
- État de lecture (piste, position, file, aléatoire/répétition, volume), réglages
  (sources, mode qualité, périphérique, DA/mouvement), playlists et favoris.
- Persistance : SQLite pour la bibliothèque/playlists/favoris ; réglages légers en
  fichier de config ; reprise exacte à la réouverture (« reprends où tu t'es
  arrêté »).

---

## 6. Direction artistique et interface (look validé)

La maquette cliquable a été validée. Elle fait foi pour la DA ; voici ce qui est
fixé et ce qui reste ouvert.

- **Univers** : encre de nuit (sumi-e), mythologie japonaise, **thème sombre unique
  assumé**. Fond épuré, lueurs d'encre qui dérivent lentement, motif seigaiha discret.
- **Accent** : **magenta mat** (aplat vif, jamais brillant ni dégradé) pour les
  commandes (play, états actifs). Or et vermillon en touches mythologiques.
- **Typo** : display mincho (type *Shippori Mincho*), UI gothique japonaise (type
  *Zen Kaku Gothic New*), chiffres tabulaires pour les temps.
- **Tokens de design** : palette, type, rayons, espacements centralisés (repris de
  la maquette) et partagés par toute l'app.
- **Écrans v1** : Lancement animé → Accueil/bibliothèque (grilles de pochettes) →
  Recherche → Albums/Titres/Artistes → Playlists → **Écran de lecture** plein écran
  (grande pochette animée, anneau « vinyle », scrubber) → Mini-lecteur persistant →
  Feuille « Qualité » → Réglages.

### Système de motion
- **Lancement** : séquence torii dessiné à l'encre + soleil magenta + wordmark
  (déjà maquettée), skippable.
- **Micro-interactions** : survols de pochettes, pressions de boutons (magenta mat,
  léger scale), transitions d'écran.
- **Écran de lecture** : pochette qui « respire », anneau en rotation à la lecture,
  fond coloré dérivé de la pochette.
- **Règles** : animations **GPU-friendly** (transform/opacity), budget de perf tenu
  à 60 fps, respect strict de `prefers-reduced-motion`, et un réglage interne
  « intensité du mouvement » (Complet / Sobre / Réduit).

---

## 7. Performance (exigence de premier ordre)
- **Listes virtualisées** pour titres/albums (~1000+ éléments) — rendu constant.
- **Pochettes** en vignettes mises en cache, chargement paresseux hors écran.
- **Changement de piste** : préchargement/décodage de la suivante, bascule sans
  allocation lourde, aucun glitch audio.
- **Démarrage** : ouverture rapide via index SQLite (pas de re-scan bloquant ; scan
  incrémental en tâche de fond).
- **Animations** : jamais de layout thrash ; `will-change` ciblé ; pause des
  animations hors écran.

---

## 8. Phasage proposé

- **Phase 1 — Socle lisible et jouable** : fenêtre Electron + squelette React +
  tokens DA ; ajout de dossier + scan + index SQLite ; grille bibliothèque réelle ;
  moteur audio FLAC fiable (play/pause/seek/suivant/précédent sans bug) ; mini-
  lecteur + écran de lecture ; détection/affichage qualité.
- **Phase 2 — Vrai lecteur complet** : file d'attente, playlists, favoris,
  aléatoire/répétition, recherche, tri/filtre ; feuille qualité fonctionnelle +
  détection périphériques ; veille des dossiers ; persistance de l'état complet.
- **Phase 3 — Finition & motion** : séquence de lancement, transitions, pochettes
  animées, réglage d'intensité de mouvement, réglages/onboarding, empaquetage
  Windows (installeur).
- **Plus tard (hors v1)** : mobile, bit-perfect/WASAPI exclusif, formats exotiques
  (ALAC/DSD), paroles, égaliseur.

---

## 9. Choix laissés au constructeur (décidables sans l'utilisateur)
- Bibliothèques précises de métadonnées, surveillance de fichiers, state management
  (p. ex. Zustand) et bundler config, tant que les objectifs et la DA sont tenus.
- Schéma exact de la base SQLite et format du cache de pochettes.
- Détail des canaux IPC et de l'arborescence de code.
- Stratégie fine gapless/anti-clic (A vs B §5.4), tant que le résultat est « zéro
  bug audio ».
- Tooling de test et d'empaquetage.

---

## 10. Décisions prises par moi (à relire)
- **Stack** Electron + React + TS + Vite — confirmée avec l'utilisateur.
- **SQLite** comme index de bibliothèque (vs JSON) — pour la fluidité sur 1000+
  titres.
- **FLAC-first**, natif Chromium ; registre extensible pour la suite.
- **Bit-perfect/WASAPI exclusif = phase 2**, pas une promesse v1 (honnêteté audio).
- **Thème sombre unique** (la DA est intrinsèquement nocturne), pas de thème clair
  en v1.
- **Windows d'abord** pour l'empaquetage, code portable.

---

## 11. Précisions issues de la relecture indépendante (2026-10-28)

### Résolu par moi (ne change pas ce qui est construit)
- **DA = artefact validé à porter, pas à réinventer.** La référence officielle de
  la direction artistique est le fichier **`design/benten-prototype.html`** : il
  porte les tokens, le magenta mat (`#e73c82`), les SVG torii/soleil, le motif
  seigaiha et les timings de motion. La phase 3 consiste à **porter** cet artefact
  dans l'app React, pas à inventer une DA.
- **Feuille « Qualité » v1 = informative.** v1 : affichage de la qualité **source**
  + `AudioContext` calé sur la fréquence par défaut du périphérique, 100 % Web
  Audio, **aucun module natif**. La vraie matrice de capacités par périphérique et
  le bit-perfect / WASAPI exclusif restent en **phase 2** (addon natif requis).
- **Développement sur les vrais fichiers.** Source stable accessible en lecture
  seule : `C:\Users\Dream\Downloads\REA DS\.prism-profile\documents\Prism Library`
  (Benten permet de toute façon de pointer/re-pointer les dossiers, donc la
  stabilité du chemin est gérée par la fonctionnalité « sources »). **Toute
  première étape de la phase 1** : vérifier que `decodeAudioData` décode de façon
  fiable ces FLAC 24-bit/44,1 kHz dans le build Electron/Chromium livré — à prouver
  sur un échantillon réel (dont `.m4p` DRM, mp3, wav, m4a), jamais à supposer.

### Résolu avec ta réponse
- **Gapless = exigence v1.** Écoutes de mixes/albums qui s'enchaînent → le vrai
  gapless (enchaînement à l'échantillon près, voir §5.4) fait partie de la v1, pas
  d'un report. Sans risque ici : toute la bibliothèque est en 44,1 kHz.
- **Matériel : filaire + Bluetooth.** Barre « zéro bug » **stricte en filaire**
  (jack/USB) : aucun clic, blanc, grésillement, désync. En **Bluetooth**, le
  gapless et l'absence de glitch **côté app** sont préservés (la jointure se fait
  en amont, dans le graphe audio), mais la **latence propre au Bluetooth et les
  éventuelles coupures du lien** ne sont pas maîtrisables par l'app et ne comptent
  pas comme des bugs Benten. **Pas de bit-perfect** promis en v1 (sans objet en
  Bluetooth) ; bit-perfect / WASAPI exclusif en filaire = phase 2.
