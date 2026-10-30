import { basename, dirname, extname } from "node:path";
import type { IAudioMetadata } from "music-metadata";
import type { TrackInput } from "../../shared/types";

/** Extensions dont la lecture est bloquee par un DRM (jamais lisibles). */
const DRM_EXTENSIONS: ReadonlySet<string> = new Set([".m4p"]);

interface PathGuess {
  artist: string;
  album: string;
  title: string;
  trackNo: number | null;
}

/** Deduit artiste/album/titre/numero de `<Artiste>/<Album>/NN - Titre.ext`. */
function guessFromPath(path: string): PathGuess {
  const base = basename(path, extname(path));
  const m = /^(\d{1,3})\s*[-._]\s*(.+)$/.exec(base);
  const albumDir = dirname(path);
  const artistDir = dirname(albumDir);
  // À la racine, dirname(x) === x : pas de dossier exploitable.
  const album = albumDir === artistDir ? "" : basename(albumDir);
  const artist = artistDir === dirname(artistDir) ? "" : basename(artistDir);
  return {
    artist,
    album,
    title: (m ? m[2] : base).trim(),
    trackNo: m ? Number(m[1]) : null,
  };
}

/** Libelle de format affichable, derive du codec/conteneur (repli : extension). */
function formatLabel(ext: string, container: string | undefined, codec: string | undefined): string {
  const c = (codec ?? "").toLowerCase();
  const k = (container ?? "").toLowerCase();
  if (c.includes("alac")) return "ALAC";
  if (c.includes("flac") || k === "flac") return "FLAC";
  if (c.includes("opus")) return "OPUS";
  if (c.includes("vorbis")) return "OGG";
  if (c.includes("layer 3")) return "MP3";
  if (c.includes("aac")) return "AAC";
  if (k === "wave" || k === "wav") return "WAV";
  if (k === "aiff" || k === "aifc") return "AIFF";
  return ext.replace(/^\./, "").toUpperCase();
}

/**
 * music-metadata est ESM-only alors que le main est compile en CJS : import dynamique
 * (paresseux, mis en cache) plutot qu'un `require` statique qui depend de require(esm).
 */
let parserModule: Promise<typeof import("music-metadata")> | undefined;
const loadParser = (): Promise<typeof import("music-metadata")> =>
  (parserModule ??= import("music-metadata"));

const clean = (s: string | undefined): string => (s ?? "").trim();

/**
 * Lit l'en-tete et les tags d'un fichier audio. Ne leve JAMAIS : un fichier
 * illisible, tronque ou protege (.m4p) donne `playable: false` (titre/artiste/album
 * restent deduits de l'arborescence pour pouvoir l'afficher).
 */
export async function readMetadata(path: string): Promise<TrackInput> {
  const ext = extname(path).toLowerCase();
  const guess = guessFromPath(path);
  const unplayable: TrackInput = {
    path,
    title: guess.title,
    artist: guess.artist,
    album: guess.album,
    albumArtist: null,
    trackNo: guess.trackNo,
    discNo: null,
    durationSec: 0,
    format: ext.replace(/^\./, "").toUpperCase(),
    sampleRate: null,
    bitDepth: null,
    playable: false,
    artKey: null,
    mtimeMs: null,
    sizeBytes: null,
  };

  if (DRM_EXTENSIONS.has(ext)) return unplayable;

  try {
    const { parseFile } = await loadParser();
    const meta: IAudioMetadata = await parseFile(path, { skipCovers: true });
    const { common, format } = meta;
    // Sans frequence d'echantillonnage on n'a pas de piste decodable.
    if (!format.sampleRate) return unplayable;
    return {
      path,
      title: clean(common.title) || guess.title,
      artist: clean(common.artist) || clean(common.albumartist) || guess.artist,
      // Un fichier téléchargé (YouTube/Apple) posé à plat n''a pas de tag album : on prend alors
      // l''ARTISTE comme album, sinon tous les téléchargements s''entassent dans un album nommé
      // d''après le dossier (« YouTube ») et la vue Albums devient un cimetière de 1 titre.
      album: clean(common.album) || clean(common.artist) || clean(common.albumartist) || guess.album,
      albumArtist: clean(common.albumartist) || null,
      trackNo: common.track.no ?? guess.trackNo,
      discNo: common.disk?.no ?? null,
      durationSec: format.duration ?? 0,
      format: formatLabel(ext, format.container, format.codec),
      sampleRate: format.sampleRate,
      bitDepth: format.bitsPerSample ?? null,
      playable: true,
      artKey: null,
      mtimeMs: null,
      sizeBytes: null,
    };
  } catch {
    return unplayable;
  }
}

