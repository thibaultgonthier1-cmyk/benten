import { deflateSync, crc32 } from "node:zlib";
import { readFileSync } from "node:fs";

/** PNG minimal valide (w x h, couleur unie) ; `seed` change la couleur donc le contenu. */
export function makePng(seed = 0, w = 4, h = 4): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, seed & 0xff)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Copie d'un FLAC reel avec un bloc METADATA_BLOCK_PICTURE (type 6, couverture avant)
 * insere juste apres STREAMINFO : les fixtures du depot n'ont pas de pochette embarquee.
 */
export function flacWithPicture(flacPath: string, image: Buffer, mime = "image/png"): Buffer {
  const src = readFileSync(flacPath);
  if (src.subarray(0, 4).toString("ascii") !== "fLaC") throw new Error("not a FLAC");
  const streamInfoLen = src.readUIntBE(5, 3);
  const afterStreamInfo = 4 + 4 + streamInfoLen;
  const wasLast = (src[4]! & 0x80) !== 0;

  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const mimeB = Buffer.from(mime, "ascii");
  const pic = Buffer.concat([
    u32(3), // couverture (avant)
    u32(mimeB.length),
    mimeB,
    u32(0), // description vide
    u32(4),
    u32(4),
    u32(24),
    u32(0), // largeur, hauteur, profondeur, nb de couleurs
    u32(image.length),
    image,
  ]);

  const head = Buffer.from(src.subarray(0, afterStreamInfo));
  head[4] = head[4]! & 0x7f; // STREAMINFO n'est plus le dernier bloc
  const picHeader = Buffer.from([
    (wasLast ? 0x80 : 0x00) | 6,
    (pic.length >> 16) & 0xff,
    (pic.length >> 8) & 0xff,
    pic.length & 0xff,
  ]);
  return Buffer.concat([head, picHeader, pic, src.subarray(afterStreamInfo)]);
}
