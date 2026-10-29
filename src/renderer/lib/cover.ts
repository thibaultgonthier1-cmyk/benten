/**
 * Pochette generative (repli quand `artKey` est null), portee du prototype.
 *
 * Le prototype tirait motif + palette au hasard ; ici on les derive de maniere DETERMINISTE
 * d'une cle (id ou titre d'album) pour qu'une meme pochette reste stable entre deux rendus et
 * entre la carte, le mini-lecteur et la vue lecture. Les motifs et teintes sont ceux du monde
 * visuel sumi-e du prototype.
 */

type Palette = [g1: string, g2: string, acc: string];

const MOTIFS = ["sun", "torii", "wave", "moon", "mountain", "koi"] as const;
export type Motif = (typeof MOTIFS)[number];

/** Palettes encre de nuit + accent (g1 = haut, g2 = bas, acc = accent du motif). */
const PALETTES: readonly Palette[] = [
  ["#241a3a", "#120b1f", "#e7c45a"],
  ["#1b2630", "#0c1116", "#aeb8c2"],
  ["#0f2a33", "#07151a", "#58c5c9"],
  ["#2a1430", "#140a18", "#e0943f"],
  ["#241316", "#120809", "#d6442f"],
  ["#2a1a10", "#140b07", "#e0773f"],
  ["#161a2e", "#0a0c17", "#c9c2e0"],
  // Ex-rose (#e773a0) retiré avec le magenta : laque rouge sombre + or clair (DA « Biwa & Or »).
  ["#2a1210", "#150807", "#f0d38a"],
];

/** Hash entier simple et stable (djb2) sur une chaine. */
function hash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h;
}

function motifShapes(motif: Motif, g1: string, acc: string): string {
  switch (motif) {
    case "torii":
      return (
        `<g stroke="${acc}" stroke-width="12" fill="none" stroke-linecap="round">` +
        `<path d="M55 95 Q150 70 245 95"/><path d="M70 120 H230"/>` +
        `<path d="M90 95 V235"/><path d="M210 95 V235"/></g>` +
        `<circle cx="150" cy="60" r="4" fill="${acc}"/>`
      );
    case "wave":
      return (
        `<g fill="none" stroke="${acc}" stroke-width="3" opacity=".75">` +
        `<path d="M-10 210 Q40 170 90 210 T190 210 T290 210 T390 210"/>` +
        `<path d="M-10 235 Q40 195 90 235 T190 235 T290 235 T390 235"/>` +
        `<path d="M-10 185 Q40 145 90 185 T190 185 T290 185 T390 185"/></g>` +
        `<circle cx="225" cy="90" r="34" fill="${acc}" opacity=".85"/>`
      );
    case "moon":
      return (
        `<circle cx="185" cy="115" r="62" fill="${acc}" opacity=".9"/>` +
        `<circle cx="210" cy="100" r="62" fill="${g1}"/>` +
        `<g stroke="${acc}" stroke-width="2.5" opacity=".4"><path d="M30 215 H130"/><path d="M20 235 H110"/></g>`
      );
    case "mountain":
      return (
        `<path d="M0 300 L110 120 L160 175 L205 120 L300 300 Z" fill="${acc}" opacity=".85"/>` +
        `<path d="M110 120 L150 160 L130 170 Z" fill="#fff" opacity=".5"/>` +
        `<circle cx="235" cy="80" r="30" fill="${acc}" opacity=".55"/>`
      );
    case "koi":
      return (
        `<path d="M70 150 Q130 90 210 120 Q250 135 235 160 Q210 150 200 160 Q150 210 70 150 Z" fill="${acc}" opacity=".9"/>` +
        `<circle cx="110" cy="140" r="5" fill="${g1}"/>` +
        `<g stroke="${acc}" stroke-width="2" opacity=".4" fill="none"><path d="M20 240 Q150 215 280 240"/></g>`
      );
    case "sun":
    default:
      return (
        `<circle cx="150" cy="140" r="78" fill="${acc}" opacity=".92"/>` +
        `<g stroke="${acc}" stroke-width="2" opacity=".5"><path d="M20 230 Q150 205 280 230"/><path d="M10 250 Q150 225 290 250"/></g>`
      );
  }
}

export interface GeneratedCover {
  svg: string;
  /** Teinte d'accent (pour la lueur de survol et le fond de la vue lecture). */
  accent: string;
  palette: Palette;
}

/** Pochette generative deterministe pour une cle donnee. */
export function generativeCover(key: string): GeneratedCover {
  const h = hash(key || "benten");
  const motif = MOTIFS[h % MOTIFS.length]!;
  const palette = PALETTES[(h >>> 3) % PALETTES.length]!;
  const [g1, g2, acc] = palette;
  const gid = `g${(h >>> 1).toString(36)}`;
  const svg =
    `<svg viewBox="0 0 300 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/></linearGradient></defs>` +
    `<rect width="300" height="300" fill="url(#${gid})"/>` +
    motifShapes(motif, g1, acc) +
    `</svg>`;
  return { svg, accent: acc, palette };
}
