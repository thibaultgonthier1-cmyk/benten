/**
 * Recadrage des pochettes qui contiennent des BANDES.
 *
 * Beaucoup de visuels de vidéos (YouTube, clips) sont des cadres 16:9 avec des bandes blanches ou
 * noires ajoutées, ou une vignette letterboxée collée dans une image carrée. Affichée en carré,
 * la pochette montre alors deux bandes claires — le défaut visible dans la grille.
 *
 * Ici, on ne devine pas : on mesure. On regarde les lignes (et colonnes) de bord, on vérifie
 * qu'elles sont à la fois UNIFORMES (pas de détail) et NEUTRES (blanc, noir, gris), et on rogne
 * jusqu'à la première ligne qui contient du contenu.
 *
 * Le calcul est pur (aucune dépendance) : il est testable sur des tableaux de pixels fabriqués.
 */

/** Ordre des octets fourni par `nativeImage.getBitmap()` (Electron). */
export const BITMAP_CHANNELS = 4; // BGRA
const B = 0;
const G = 1;
const R = 2;

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Écart maximal entre deux pixels d'une même ligne pour la considérer uniforme (0-255). */
const UNIFORM_TOLERANCE = 18;
/** Écart maximal entre la moyenne d'une ligne et le blanc/le noir pour la considérer neutre. */
const NEUTRAL_TOLERANCE = 26;
/** Une bande doit représenter au moins cette fraction pour valoir un recadrage. */
const MIN_BAND_FRACTION = 0.04;
/** On ne rogne jamais plus de la moitié de l'image (sinon on a mal mesuré). */
const MAX_CROP_FRACTION = 0.5;

function luminance(pixels: Uint8Array | Uint8ClampedArray, index: number): number {
  return 0.114 * pixels[index + B]! + 0.587 * pixels[index + G]! + 0.299 * pixels[index + R]!;
}

/** Vrai si la ligne `y` est uniforme ET neutre (blanc, noir ou gris clair/foncé). */
function isBlankRow(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  y: number,
  stride: number,
): boolean {
  let min = 255;
  let max = 0;
  let sum = 0;
  const rowStart = y * stride;
  for (let x = 0; x < width; x += 1) {
    const value = luminance(pixels, rowStart + x * BITMAP_CHANNELS);
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  if (max - min > UNIFORM_TOLERANCE) return false; // du détail : c'est du contenu
  const mean = sum / width;
  return mean <= NEUTRAL_TOLERANCE || mean >= 255 - NEUTRAL_TOLERANCE;
}

/** Même test, sur une colonne. */
function isBlankColumn(
  pixels: Uint8Array | Uint8ClampedArray,
  height: number,
  x: number,
  stride: number,
): boolean {
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let y = 0; y < height; y += 1) {
    const value = luminance(pixels, y * stride + x * BITMAP_CHANNELS);
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  if (max - min > UNIFORM_TOLERANCE) return false;
  const mean = sum / height;
  return mean <= NEUTRAL_TOLERANCE || mean >= 255 - NEUTRAL_TOLERANCE;
}

/**
 * Boîte de contenu d'une image, bandes de bord exclues.
 *
 * @returns la zone utile si elle vaut la peine d'être recadrée, sinon `null` (image à garder telle
 *          quelle — c'est le cas de la grande majorité des pochettes).
 */
export function findContentBox(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: number = width * BITMAP_CHANNELS,
): ContentBox | null {
  if (width < 8 || height < 8) return null;

  const maxRows = Math.floor(height * MAX_CROP_FRACTION);
  const maxCols = Math.floor(width * MAX_CROP_FRACTION);

  let top = 0;
  while (top < maxRows && isBlankRow(pixels, width, top, stride)) top += 1;
  let bottom = height - 1;
  while (bottom > height - 1 - maxRows && isBlankRow(pixels, width, bottom, stride)) bottom -= 1;
  let left = 0;
  while (left < maxCols && isBlankColumn(pixels, height, left, stride)) left += 1;
  let right = width - 1;
  while (right > width - 1 - maxCols && isBlankColumn(pixels, height, right, stride)) right -= 1;

  // Rien de significatif : on ne touche pas à l'image.
  if (top / height < MIN_BAND_FRACTION && (height - 1 - bottom) / height < MIN_BAND_FRACTION) {
    if (left / width < MIN_BAND_FRACTION && (width - 1 - right) / width < MIN_BAND_FRACTION) {
      return null;
    }
  }

  // On a buté sur le plafond : la « bande » couvre la moitié de l'image, donc la mesure est
  // suspecte (fond uni, mauvaise vignette). Mieux vaut ne rien rogner que rogner au hasard.
  if (top >= maxRows || height - 1 - bottom >= maxRows || left >= maxCols || width - 1 - right >= maxCols) {
    return null;
  }

  const box: ContentBox = {
    x: left,
    y: top,
    width: Math.max(1, right - left + 1),
    height: Math.max(1, bottom - top + 1),
  };

  // Sécurité : une boîte dégénérée produirait une vignette inutilisable.
  if (box.width < width * 0.25 || box.height < height * 0.25) return null;
  return box;
}
