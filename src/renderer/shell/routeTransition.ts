/**
 * Décision de sortie de page (pure, testée). En mode `popLayout`, la page sortante reste dans le
 * contenu défilant pendant son effacement ; si la position de défilement change au même moment
 * (remise en haut, ou reprise au retour), elle « sauterait » pendant son fondu. Elle s'efface donc
 * d'un coup dans ce cas — et aussi lors d'une transition partagée (seule la pochette voyage).
 */
export function exitIsInstant({
  shared,
  prevScroll,
  nextScroll,
}: {
  shared: boolean;
  prevScroll: number;
  nextScroll: number;
}): boolean {
  return shared || Math.round(prevScroll) !== Math.round(nextScroll);
}
