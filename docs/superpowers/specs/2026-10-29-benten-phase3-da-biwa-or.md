# Benten — Direction artistique « Biwa & Or » (addendum Phase 3)

> Complète et **remplace sur les points cités** `2026-10-29-benten-phase3-design.md` (§2 DA, §6 logo/intro, et les rendus de §4/§7). Tout le reste de la Phase 3 (architecture, écrans, invariants audio, fonctionnalités) est inchangé.

## 1. Intention (paroles de l'utilisateur)

L'utilisateur veut que **toute** l'app soit dans le thème de **Benten / Benzaiten**, la déesse de la musique et de l'eau. Il veut que ses pouvoirs et ses attributs soient représentés, en mélange avec la musique. Les couleurs doivent aller avec elle : on peut changer la couleur et le ton global. Les boutons doivent être bien animés.

Il veut que le rendu soit fait **« pas qu'avec du code »**, avec After Effects et Magnific.

Sur des esquisses animées, il a choisi l'univers **B — « Biwa & Or »** (琵琶) parmi trois. Il a demandé que les effets soient **« vraiment bien améliorés, animés et détaillés »**. Il a validé la description jouée en retour : « c'est bien ».

Il a **refusé le son au lancement** (« pas de son, oublie »).

Références de qualité déjà posées par l'utilisateur, toujours valables :
- niveau Apple Music / Spotify, « à ma manière » ;
- simple, réactif, fluide ;
- fond noir uni ;
- boutons avec de la matière mais **jamais 3D ni exagérés**.

## 2. Le concept

Benzaiten joue du **biwa**, un luth japonais. Sa musique fait onduler l'eau de ses sanctuaires. Dans Benten, **chaque son que l'utilisateur lance « réveille » l'instrument** :
- les contrôles sont des parties du biwa : cordes, médaillon, plectre ;
- les matières sont celles des objets sacrés : laque noire (urushi) et feuille d'or (kinpaku) ;
- les effets sont ceux de l'eau et de l'encre : ondes, voiles d'encre, éclats d'or qui se dispersent.

## 3. Palette (remplace l'accent magenta)

| Rôle | Valeur | Note |
|---|---|---|
| Fond | `#000` uni | **inchangé** (exigence utilisateur) |
| Surfaces | noirs laqués neutres (`#0b0b0d` → `#1c1c20`) | les surfaces existantes, avec un très léger reflet laqué |
| **Accent principal : or** | `--gold` ≈ `#d4aa50` ; clair `#f0d38a` ; profond `#8a6420` | contrôles actifs, progression, sélection, focus. Contraste sur `#000` ≥ 4.5:1 |
| Accent secondaire : rouge laque | ≈ `#b8281b` / `#8e1e14` | touches rares : favori actif, danger, détails du disque |
| Texte | ivoire `#f3efe8`, atténués existants | |

- **Magenta `#e73c82` : retiré partout.** Cela inclut l'icône et l'intro.
- La couleur dynamique des pochettes (§5 de la spec Phase 3) **reste** pour les en-têtes, halos et reflets du disque. L'or reste la couleur de marque.

## 4. Éléments signature (comportement attendu)

1. **Bouton lecture — médaillon d'or.**
   - Disque en feuille d'or ciselée, avec une texture réelle et un reflet qui glisse au survol.
   - Au clic, une **onde dorée** part du centre, comme une corde pincée.
   - Le triangle et la pause se transforment l'un en l'autre par un fondu d'encre d'or.
   - Les variantes miniatures (lignes, tuiles) reprennent le même langage.
2. **Barre de lecture — corde de biwa.**
   - Une corde tendue sur toute la largeur. La partie déjà jouée brille d'or, le reste est une corde sombre.
   - Pendant la lecture, elle **vibre très légèrement**. L'amplitude suit l'énergie du son, lue en lecture seule sur l'`analyser` existant. Pas de vibration en pause.
   - **Au glisser, la corde se tord sous le pointeur**, avec une courbe qui suit la souris. Au relâchement, elle revient en vibrant puis s'amortit, comme un ressort.
   - Une bulle de temps apparaît au survol.
3. **Volume :** même corde, plus fine. Le bouton muet est un petit plectre (bachi).
4. **Disque derrière la pochette.** Il remplace le « vinyle » décrit dans l'ajout Tâche 10 ; le comportement reste le même (sortir, tourner, décélérer).
   - Disque en **laque noire**, décoré de **vagues dorées seigaiha** en maki-e.
   - Les vagues captent la lumière en tournant : reflet spéculaire teinté par la couleur dynamique de la pochette.
   - Il sort de derrière la pochette au lancement, tourne pendant la lecture, et décélère à la pause.
   - Le centre porte une pastille d'or avec la pochette en médaillon.
5. **Transitions et retours visuels.**
   - Voile d'encre qui se dissipe entre deux pages.
   - Éclats de feuille d'or qui s'envolent quand on ajoute à une playlist : ils remplacent la « pochette qui vole » simple.
   - Ondes concentriques sur l'eau à la confirmation d'une action.
   - Ces effets restent **courts** (≤ 600 ms) et ne bloquent jamais l'interaction.
6. **Écran de lecture.**
   - Fond noir.
   - Halo à la couleur de la pochette.
   - Grand disque laqué.
   - Corde de lecture large.
   - Fines lignes d'eau qui ondulent très lentement en arrière-plan.
7. **Logo, icône, intro.**
   - Soleil **or** derrière le torii à kasagi courbé, la géométrie de l'intro actuelle.
   - L'intro After Effects est **refaite en or et laque**, sans son.
   - L'icône Windows est dérivée du même dessin, lisible à 16 px.
8. **États vides et illustrations :** peintures encre et or (Benten, biwa, vagues, torii au bord de l'eau), générées avec Magnific et retouchées. Par exemple : bibliothèque vide, playlist vide, aucun résultat, onboarding.
9. **Égaliseur (Tâche 17B) :** les 10 curseurs sont des **chevalets de koto** sur des cordes. La courbe de réponse est un fil d'or.

## 5. Fabrication (« pas qu'avec du code »)

- **Magnific** (crédits de l'utilisateur ; **plafond total ≈ 15 000 crédits** validé par l'utilisateur ; coût de chaque lot estimé et annoncé, sans attendre de réponse tant que le plafond tient ; dépassement = arrêt et demande) :
  - textures : feuille d'or, laque, vagues seigaiha, papier washi, encre ;
  - illustrations des états vides ;
  - variations pour le logo.
  - Les sources sont rangées dans `design/textures/` et `design/illustrations/`. Les versions optimisées (WebP/AVIF, tailles bornées) vont dans `src/renderer/assets/`.
- **After Effects** (via le plugin Magnific, projet `design/motion/*.aep`) :
  - intro or ;
  - logo animé ;
  - effets superposés : onde de pincement, voile d'encre, éclats d'or, gouttes et ondes.
  - Rendu en séquence avec alpha, puis converti en **WebM VP9 avec transparence** par l'`ffmpeg` installé sur la machine (outil de production, jamais embarqué).
  - Les sorties vont dans `src/renderer/assets/fx/`. Les `.aep` et les rendus maîtres restent dans `design/`.
- **Le code** déclenche, positionne et synchronise ces éléments, et garde l'interactif réactif sous la souris : corde physique, glisser, état des boutons. Un élément qui doit suivre le pointeur image par image est dessiné en SVG/canvas avec les **textures produites**, pas en vidéo.

## 6. Contraintes

- **Hors-ligne :** toutes les ressources sont embarquées. Aucun chargement réseau.
- **Budget poids :** `src/renderer/assets/fx/` + textures ≤ **20 Mo** au total.
- **Performance :**
  - aucune tâche longue (> 50 ms) causée par un effet pendant la lecture ;
  - les vidéos d'effets sont préchargées et réutilisées ;
  - au plus **2** effets vidéo simultanés.
- **Mouvement réduit** (réglage « Réduit » ou préférence système) : aucun effet vidéo, aucune vibration ni rotation ; changements d'état instantanés. Les mêmes informations restent visibles.
- **Invariants audio inchangés.** L'`analyser` est lu en lecture seule. Le graphe audio n'est jamais modifié pour un effet visuel.
- **Accessibilité :** l'or et l'ivoire sur noir gardent ≥ 4.5:1 ; anneaux de focus visibles (or) ; tous les contrôles restent utilisables au clavier.

## 7. Non-objectifs

- Son au lancement : refusé.
- 3D, Lottie, animations décoratives permanentes qui distraient de la musique.
- Changer la structure des écrans ou des fonctionnalités déjà livrées.

## 7 bis. Précisions (décisions du concepteur, à relire par l'utilisateur)

- **L'or est fixe, ce n'est pas un thème au choix.** Quand l'utilisateur dit « si il faut changer la couleur et le ton global fais-le », il autorise le changement de palette ; il ne demande pas de sélecteur de thème. Les ressources sont donc produites directement en or et en laque. Il n'y a pas de système de thèmes.
- **Couleur de pochette ou or :**
  - **or** pour tout ce qui est interactif ou d'état : bouton lecture, cordes (partie jouée), sélection, focus, égaliseur animé « en lecture », favori actif (rouge laque) ;
  - **couleur de pochette** pour l'ambiance : dégradé d'en-tête (album, artiste, playlist), halo de l'écran de lecture, reflet du disque laqué, lignes d'eau de fond.
  - Lors du changement de peau, les écrans déjà livrés suivent cette règle.
- **Ajouts de la Tâche 10 conservés :**
  - le zoom lent (Ken Burns) de la grande pochette ;
  - la « respiration » de la pochette sur l'énergie du son ;
  - le mini-disque qui dépasse derrière la pochette de la barre de lecture.
- **Ajouts de la Tâche 10 remplacés :**
  - les taches de couleur qui dérivent deviennent des lignes d'eau qui ondulent, teintées par la pochette ;
  - le « pop + éclats » du cœur devient des éclats de feuille d'or ;
  - le vinyle devient le disque laqué.
- **Niveaux de mouvement :**
  - **Complet** : tout, comme décrit.
  - **Sobre** :
    - les effets vidéo sont joués à opacité réduite, sans éclats d'or ;
    - la vibration de corde est réduite de moitié ;
    - le disque tourne ;
    - pas de Ken Burns ni de lignes d'eau.
  - **Réduit** : comme le §6.
- **Ressources et code en parallèle.**
  - Les composants sont livrés avec un rendu dessiné en code (SVG/CSS) qui sert de repli permanent et de version « Réduit ».
  - Chaque composant a un point de branchement unique pour sa ressource (texture ou effet). Les vraies ressources s'y branchent dès que l'utilisateur les valide.
  - Validation : images fixes et clips d'effets présentés dans l'onglet de maquettes, puis rendu final dans l'app.

## 8. Effet sur le plan Phase 3

- **Nouvelle tâche « DA Biwa & Or — fondations ».**
  - Tokens or et laque : `--accent` passe à l'or, les dégradés de bouton deviennent dorés.
  - Retrait du magenta.
  - Composants signature réutilisables : `GoldMedallionButton`, `BiwaString` (progression et volume), `LacquerDisc`, `FxOverlay` (lecteur d'effets WebM).
  - Les écrans déjà livrés (Tâches 3 à 9) changent de peau **sans changer de structure**.
- **Nouvelle tâche contrôleur « Production des ressources ».**
  - Magnific : textures et illustrations.
  - After Effects : intro or, logo animé, effets.
  - Conversion WebM alpha.
  - **Validation visuelle par l'utilisateur** avant intégration.
- La Tâche 10 utilise `LacquerDisc` et `BiwaString`. Les Tâches 13, 14, 15 et 17B suivent cette DA.
- La Tâche 9, en cours, reste valide : sa partie non commitée est reprise telle quelle, et l'or arrive par les tokens.
