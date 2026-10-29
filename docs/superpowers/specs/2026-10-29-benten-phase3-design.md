# Benten — Document de conception, Phase 3 (« niveau grosse boîte »)

Date : 2026-10-29
Statut : **approuvé pour construction** (l'utilisateur : « oui », « pousse au maximum »)
Base : `main` (Phase 1 + Phase 2 + finitions + empaquetage Windows).
Tout reste **local** : aucun push, aucune PR.

---

## 1. Intention

Benten marche (Phase 2 : lecteur complet, fiable, gapless). La Phase 3 en fait une app qui a
**l'air et le toucher d'un produit phare d'une grande entreprise** — façon Apple Music / Spotify,
mais **à la manière de l'utilisateur** — tout en restant **simple**. Mots de l'utilisateur :
« dynamique, bien animé, que les couleurs soient bien faites, que tout s'incorpore parfaitement…
facile à utiliser, bien disposé… le plus poussé possible, tout en restant simple ».

Trois piliers :
1. **Une DA aboutie et cohérente** (validée en maquette + intro v2) appliquée à 100 % de l'app.
2. **Un système de motion** : tout est vivant, fluide, jamais exagéré, jamais en 3D.
3. **L'ergonomie et les features** d'un vrai lecteur moderne (vue Titres, YouTube→MP3, import de
   playlist Apple, outils en option), avec les raccourcis, menus contextuels et glisser-déposer
   qu'on attend d'une app pro.

---

## 2. Direction artistique (validée)

Référence visuelle : la maquette animée et l'intro v2 montrées et validées dans la session
(`design/motion/benten-intro-v2-endframe.png`, `design/motion/benten-intro.aep`).

- **Fond noir pur `#000`, uni, épuré.** Le fond ne porte jamais la couleur.
- **Toute la couleur vit sur le contenu** : pochettes, titres actifs, boutons, accents, et
  **couleur dynamique extraite de chaque pochette** (halo/dégradé discret derrière l'album ou le
  titre en cours — comme Apple Music, mais sur fond noir).
- **Accent de marque : magenta mat `#e73c82`** (contrôles actifs, play, progression, sélection).
- **Matière, pas de 3D** : boutons et cartes « pas plats » — léger dégradé, reflet interne, ombre
  douce, réaction au survol/clic (ressort) — **sans** relief 3D ni effets exagérés.
- **Identité japonaise discrète** : le mark 弁, le **torii affiné + soleil magenta** (logo),
  titres d'affichage en mincho. Jamais chargé : touches, pas de décor.
- **Typographie embarquée (hors-ligne)** : *Shippori Mincho* (affichage) + *Zen Kaku Gothic New*
  (UI), chiffres tabulaires pour les durées. Polices **empaquetées dans l'app** (paquets npm
  `@fontsource/*`), jamais chargées du réseau.
- **Icônes cohérentes** : un seul jeu (trait uniforme, `lucide-react`), + les marks Benten en SVG.
- Thème sombre unique (inchangé).

---

## 3. Système de motion

- **Tout est animé, rien n'est gratuit** : chaque animation explique un changement (apparition,
  navigation, sélection, lecture).
- Bibliothèque : **`framer-motion`** (ressorts, `AnimatePresence`, transitions d'éléments
  partagés `layoutId`). Tokens de motion centralisés (durées, courbes, ressorts).
- Moments clés :
  - **Lancement** : l'intro After Effects (soleil qui monte, torii qui se révèle, « Benten »),
    **skippable**, qui fond dans l'app.
  - **Navigation** : transitions d'écran (fondu + léger glissé), indicateur de nav animé.
  - **Pochette grille → page album** : la pochette **voyage** jusqu'à l'en-tête (élément partagé).
  - **Lecteur → écran de lecture** : la pochette du mini-lecteur **s'agrandit** en plein écran.
  - Survol des cartes (soulèvement, zoom doux, bouton play qui monte), boutons à ressort,
    équaliseur animé sur le titre en cours, pochette qui « respire », squelettes de chargement
    (shimmer), images en fondu, toasts, menus qui s'ouvrent depuis le curseur.
- **Performance** : uniquement `transform`/`opacity` (GPU), 60 fps, listes virtualisées conservées.
- **Accessibilité** : `prefers-reduced-motion` respecté + réglage **intensité du mouvement**
  (Complet / Sobre / Réduit) — repris du design d'origine §6.

---

## 4. Architecture de l'interface

### 4.1 Restructuration du code renderer (sans toucher l'audio)
`App.tsx` (624 lignes) et `tokens.css` (2 017 lignes) sont monolithiques. On restructure :
- **Runtime audio extrait** dans un module dédié (création du moteur, liaison au store, boucle
  rAF/tick, recréation de contexte, persistance, pont dev) — **code déplacé, comportement
  identique**. C'est la seule partie qui touche au son ; elle ne change pas.
- **Store bibliothèque** (albums, pistes, sources, scan, recherche, rafraîchissement veille).
- **Store UI** : routeur maison (route courante + historique précédent/suivant), overlays.
  Pas de dépendance de routage externe.
- **Shell** : barre latérale, barre du haut, zone de contenu (routes animées), barre de lecteur,
  calques (écran de lecture, file, feuilles, menus contextuels, toasts).
- **Design system** : `tokens.css` réduit aux variables ; CSS **par composant**.

### 4.2 Écrans (routes)
- **Accueil** : en-tête teinté par la couleur du titre en cours/dernier joué, rangées
  « Écoutés récemment », « Ajoutés récemment », « Tes playlists », « Favoris ».
- **Titres** : tous les titres **individuellement**, liste virtualisée, **triée par date d'ajout**
  par défaut (tri par colonnes possible), multi-sélection, menu contextuel, glisser vers une
  playlist/la file.
- **Albums** (grille) → **Page album** (grande pochette, en-tête à la couleur de la pochette,
  liste des titres, Lecture / Aléatoire / Ajouter / Favori).
- **Artistes** (grille) → **Page artiste** (albums + titres).
- **Playlists** (grille, mosaïque de 4 pochettes) → **Page playlist** (renommer en place,
  réordonner au glisser, retirer, lire/aléatoire).
- **Favoris**.
- **Recherche** : page de résultats par sections (meilleur résultat, titres, albums, artistes,
  playlists).
- **Téléchargements** (YouTube→MP3).
- **Réglages** : sources (ajouter/retirer/re-scanner), qualité & sortie, intensité du mouvement,
  intro au lancement, outils YouTube, à propos.
- **Écran de lecture** plein écran (pochette animée, fond dynamique, file à côté) + **barre de
  lecteur** repensée.
- **Premier lancement** : accueil + choix du dossier + **scan animé** (compteurs en direct).

### 4.3 Ergonomie « app pro »
- **Menus contextuels** (clic droit) partout : lire, lire ensuite, ajouter à la file, ajouter à
  une playlist, favori, aller à l'album/l'artiste.
- **Glisser-déposer** : titres/albums → playlist (barre latérale) ou file.
- **Raccourcis clavier** : Espace (lecture/pause), ←/→ (piste), Ctrl+F (recherche), Ctrl+L
  (favori), Échap (fermer), `?` (aide des raccourcis), etc.
- **Touches média + contrôle Windows** : `navigator.mediaSession` (touches multimédia du clavier,
  overlay de lecture Windows avec pochette/titre).
- **Toasts** de confirmation, états vides illustrés, chargements en squelette.

---

## 5. Couleur dynamique
Extraction d'une **palette par pochette** côté renderer (image `benten-art://` → canvas →
quantification → couleur dominante + couleur vive lisible sur noir). Fonction **pure et testée**,
cache en mémoire. Utilisée pour : en-tête de page album, halo de l'écran de lecture, en-tête
d'accueil, indicateurs du titre en cours. Contraste garanti (luminosité bornée sur fond noir).

---

## 6. Logo, icône, intro

- **Logo Benten** : le **torii affiné + soleil magenta** (dessin validé de l'intro v2), décliné en
  SVG (barre latérale, splash, états vides) et en **icône d'app** Windows (`build/icon.ico`
  multi-tailles) — remplace le carré « 弁 » actuel de l'exécutable.
- **Intro de lancement** : source **After Effects** (`design/motion/benten-intro.aep`), affinée
  (toit du torii aux extrémités relevées, timing), **rendue en vidéo haute qualité** et jouée au
  lancement, skippable, désactivable dans les réglages, coupée si mouvement réduit.
- **Blender (3D)** : écarté pour cette phase (la DA est plate et épurée ; la 3D jurerait).
- **Magnific (IA)** : optionnel — utilisé seulement s'il est connecté, jamais requis.

---

## 7. Fonctionnalités ajoutées

### 7.1 YouTube → MP3
- Coller un lien YouTube → **téléchargement + conversion MP3** (320 kb/s) → pochette (miniature)
  et titre/artiste intégrés → **ajout à une playlist** choisie.
- Moteur : **yt-dlp** (téléchargé au premier usage dans le dossier de l'app, vérifié par
  empreinte SHA-256, mis à jour sur demande) + **ffmpeg** (embarqué via `ffmpeg-static`).
- Fichiers créés dans **`Musique\Benten\YouTube`**, déclaré automatiquement comme source → la
  veille l'indexe tout seul.
- Écran **Téléchargements** : file d'attente animée, progression, erreurs claires.
- **Sécurité** : seules les URL YouTube (`youtube.com`, `youtu.be`, `music.youtube.com`) sont
  acceptées ; arguments passés en tableau (jamais de shell) ; tout reste gardé par
  `assertTrusted`.
- **Exception assumée au « fichiers en lecture seule »** : Benten **crée** de nouveaux fichiers
  dans *son* dossier de téléchargements ; il ne modifie, ne déplace et ne supprime **jamais** les
  fichiers existants de l'utilisateur.
- **Réseau** : cette fonction (et elle seule) utilise internet ; la lecture reste 100 % locale.

### 7.2 Import de playlist Apple Music
- Import d'un export Apple Music / iTunes : **texte Unicode (.txt, tabulé)**, **.m3u/.m3u8**,
  **.xml (plist)**. **L'ordre du fichier est conservé** (option : trier par « Date d'ajout »
  quand la colonne existe).
- **Correspondance** avec la bibliothèque : normalisation (casse, accents, ponctuation, « feat. »,
  mentions « (Slowed) » etc.), correspondance exacte puis approchée (titre + artiste, durée en
  départage). Rapport clair : trouvés / non trouvés.
- L'utilisateur fournira son export pour la validation réelle.

### 7.3 Outils en option (simples)
- **Minuteur de sommeil** (15/30/45/60 min ou fin du titre) avec **fondu de volume** à la fin.
- **Lecture aléatoire de toute la bibliothèque**.
- **Mode compact** : mini-lecteur **toujours au premier plan** (même fenêtre, même moteur).
- **Historique d'écoute** (alimente « Écoutés récemment ») — nouvelle table SQLite (schéma v3).

---

## 8. Invariants (inchangés, non négociables)
- **Zéro bug audio**, gapless à l'échantillon près, **un seul `AudioContext` + une seule boucle
  `tick()`** ; la refonte **déplace** le runtime audio sans le modifier. Le minuteur de sommeil
  passe par le nœud de volume existant (fondu), jamais par un arrêt sec.
- Fichiers existants **jamais modifiés** (cf. exception 7.1 : création dans le dossier de Benten).
- Hors-ligne pour tout sauf YouTube→MP3. IPC gardées par `assertTrusted`. Migration SQLite
  additive (v2 → v3).

## 9. Non-objectifs (Phase 3)
- **Mobile / iPhone (PWA)** → **Phase 4** (décidé avec l'utilisateur : pas de Mac → PWA).
- Bit-perfect/WASAPI, égaliseur, paroles, formats exotiques.
- Export Lottie (pas de Bodymovin requis : l'intro est rendue en vidéo depuis After Effects).
- 3D Blender.

## 10. Décisions prises par moi (à relire)
- `framer-motion` (motion), `lucide-react` (icônes), `@fontsource/*` (polices embarquées) — versions
  épinglées exactes, compatibles React 18.3.1.
- Routeur maison dans un store Zustand (pas de `react-router`).
- CSS par composant + variables ; pas de CSS-in-JS.
- Palette de pochette extraite côté renderer (pas de module natif type `sharp`).
- Intro livrée en **vidéo** rendue depuis After Effects (pas de Lottie).
- `ffmpeg-static` **embarqué** (installeur ~+70 Mo) ; **yt-dlp téléchargé au premier usage**
  (doit pouvoir se mettre à jour, YouTube change souvent).
- Dossier YouTube : `Musique\Benten\YouTube`, ajouté automatiquement comme source.
- Mode compact = même fenêtre redimensionnée + toujours au premier plan (pas de 2ᵉ fenêtre ni de
  2ᵉ moteur).
- Historique : un titre compte comme « écouté » après 30 s ou la moitié de sa durée.
