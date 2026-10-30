/*
 * BENTEN — animation du logo, générée par script (After Effects, ExtendScript).
 *
 * UTILISATION
 *   1. After Effects ouvert, aucun projet nécessaire.
 *   2. Fichier ▸ Exécuter un script ▸ Fichier… ▸ choisir ce fichier (.jsx).
 *      (ou en ligne de commande : afterfx.exe -r "chemin\benten-logo.jsx")
 *   3. Le script crée la composition, les calques, l'animation, et ajoute un rendu PNG dans
 *      le dossier indiqué par SORTIE ci-dessous.
 *
 * CE QUE ÇA FAIT
 *   Soleil d'or qui monte et s'installe, torii qui descend et se pose, onde dorée qui part du
 *   centre, puis maintien. Aucun plugin requis : uniquement des calques de forme et des
 *   expressions, donc reproductible sur n'importe quelle machine.
 *
 * CE QUE ÇA NE FAIT PAS
 *   Ce n'est pas un rendu Magnific : pas de texture peinte, pas de particules génératives.
 *   Pour ça : générer l'image dans Magnific, la placer en calque, et garder l'animation d'ici.
 */

(function bentenLogo() {
  var LARGEUR = 1920;
  var HAUTEUR = 1080;
  var FPS = 30;
  var DUREE = 4.0; // secondes
  var SORTIE = new Folder("~/Desktop/benten-logo-render");

  var OR = [0.831, 0.667, 0.314]; // #d4aa50
  var OR_CLAIR = [0.941, 0.827, 0.541]; // #f0d38a
  var IVOIRE = [0.953, 0.937, 0.91]; // #f3efe8

  // Un projet doit exister : en `-r` (ligne de commande) AE démarre parfois sans projet.
  if (!app.project) app.newProject();
  app.beginUndoGroup("Benten — logo animé");

  // ── Composition ────────────────────────────────────────────────────────────────────────────
  var comp = app.project.items.addComp("Benten — logo", LARGEUR, HAUTEUR, 1, DUREE, FPS);
  comp.bgColor = [0, 0, 0];

  // ── Fond laqué ─────────────────────────────────────────────────────────────────────────────
  var fond = comp.layers.addSolid([0.03, 0.028, 0.025], "Laque", LARGEUR, HAUTEUR, 1);

  // ── Soleil ─────────────────────────────────────────────────────────────────────────────────
  var soleil = comp.layers.addShape();
  soleil.name = "Soleil";
  var soleilGroupe = soleil.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  var soleilForme = soleilGroupe.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Ellipse");
  soleilForme.property("ADBE Vector Ellipse Size").setValue([520, 520]);
  var soleilRemplissage = soleilGroupe.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
  soleilRemplissage.property("ADBE Vector Fill Color").setValue([OR[0], OR[1], OR[2], 1]);
  soleil.property("ADBE Transform Group").property("ADBE Position").setValue([LARGEUR / 2, HAUTEUR / 2 - 40]);

  // Apparition : le soleil monte et grandit (0 → 0,9 s), puis respire très lentement.
  var soleilEchelle = soleil.property("ADBE Transform Group").property("ADBE Scale");
  soleilEchelle.setValueAtTime(0, [70, 70]);
  soleilEchelle.setValueAtTime(0.9, [100, 100]);
  soleilEchelle.setValueAtTime(DUREE, [103, 103]);

  var soleilOpacite = soleil.property("ADBE Transform Group").property("ADBE Opacity");
  soleilOpacite.setValueAtTime(0, 0);
  soleilOpacite.setValueAtTime(0.9, 100);

  // ── Torii : kasagi courbé, shimaki, nuki, deux piliers ─────────────────────────────────────
  var torii = comp.layers.addShape();
  torii.name = "Torii";
  var groupe = torii.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  var formes = groupe.property("ADBE Vectors Group");

  /**
   * Une poutre = un rectangle positionné INDIVIDUELLEMENT dans le groupe.
   *
   * Piège rencontré : le transform de groupe est partagé par toutes ses formes — positionner le
   * groupe pour chaque poutre empile tout au même endroit (on obtient une croix, pas un torii).
   * C'est donc `ADBE Vector Rect Position` (propre à la forme) qu'il faut régler.
   */
  function poutre(nom, largeur, hauteur, x, y) {
    var rect = formes.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([largeur, hauteur]);
    rect.property("ADBE Vector Rect Position").setValue([x, y]);
    var remplissage = formes.addProperty("ADBE Vector Graphic - Fill");
    remplissage.property("ADBE Vector Fill Color").setValue([IVOIRE[0], IVOIRE[1], IVOIRE[2], 1]);
    return rect;
  }

  // Torii : kasagi (haute, large), shimaki (sous-poutre), nuki (traverse), deux piliers.
  poutre("Kasagi", 1180, 80, 0, -300);
  poutre("Shimaki", 1000, 38, 0, -228);
  poutre("Nuki", 1100, 50, 0, -60);
  poutre("Pilier gauche", 76, 430, -430, 130);
  poutre("Pilier droit", 76, 430, 430, 130);

  torii.property("ADBE Transform Group").property("ADBE Position").setValue([LARGEUR / 2, HAUTEUR / 2 - 40]);

  // Le torii descend et se pose (0,25 → 1,1 s), avec une très légère inertie.
  var toriiPosition = torii.property("ADBE Transform Group").property("ADBE Position");
  toriiPosition.setValueAtTime(0.25, [LARGEUR / 2, HAUTEUR / 2 - 200]);
  toriiPosition.setValueAtTime(1.1, [LARGEUR / 2, HAUTEUR / 2 - 40]);
  var toriiOpacite = torii.property("ADBE Transform Group").property("ADBE Opacity");
  toriiOpacite.setValueAtTime(0.25, 0);
  toriiOpacite.setValueAtTime(0.75, 100);

  // ── Onde dorée (anneau qui s'ouvre, comme une corde pincée) ────────────────────────────────
  var onde = comp.layers.addShape();
  onde.name = "Onde";
  var ondeGroupe = onde.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  var ondeForme = ondeGroupe.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Ellipse");
  ondeForme.property("ADBE Vector Ellipse Size").setValue([520, 520]);
  var ondeContour = ondeGroupe.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Stroke");
  ondeContour.property("ADBE Vector Stroke Color").setValue([OR_CLAIR[0], OR_CLAIR[1], OR_CLAIR[2], 1]);
  ondeContour.property("ADBE Vector Stroke Width").setValue(6);
  onde.property("ADBE Transform Group").property("ADBE Position").setValue([LARGEUR / 2, HAUTEUR / 2 - 40]);

  var ondeEchelle = onde.property("ADBE Transform Group").property("ADBE Scale");
  ondeEchelle.setValueAtTime(0.9, [100, 100]);
  ondeEchelle.setValueAtTime(2.0, [260, 260]);
  var ondeOpacite = onde.property("ADBE Transform Group").property("ADBE Opacity");
  ondeOpacite.setValueAtTime(0.9, 0);
  ondeOpacite.setValueAtTime(1.0, 55);
  ondeOpacite.setValueAtTime(2.0, 0);

  // ── Rendu PNG ──────────────────────────────────────────────────────────────────────────────
  if (!SORTIE.exists) SORTIE.create();
  var rqItem = app.project.renderQueue.items.add(comp);
  var modele = rqItem.outputModule(1);
  try {
    modele.applyTemplate("PNG Sequence");
  } catch (e) {
    // Pas de modèle : on laisse le format par défaut, l'utilisateur choisira dans la file.
  }
  modele.file = new File(SORTIE.fsName + "/benten-logo_[#####].png");

  app.endUndoGroup();

  // Rendu immédiat (script lancé en ligne de commande : personne pour cliquer « Rendre »).
  try {
    app.project.renderQueue.render();
  } catch (e) {
    alert("Rendu impossible automatiquement : " + e.toString() + "\nLa composition est prête, lance-le depuis la file de rendu.");
  }

  if (!/headless/i.test($.getenv("BENTEN_AE_QUIET") || "")) alert(
    "Composition créée : « Benten — logo »\n\n" +
      "Rendu PNG préparé vers :\n" +
      SORTIE.fsName +
      "\n\n" +
      "Pour un WebM (utilisable dans l'app) :\n" +
      "  ffmpeg -framerate 30 -i benten-logo_%05d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32 logo.webm",
  );
})();


