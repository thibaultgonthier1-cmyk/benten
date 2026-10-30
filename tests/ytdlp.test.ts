import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildYtDlpArgs, checksumFor, ensureYtDlp, parseProgress, validateYoutubeUrl } from "../src/main/youtube/ytdlp";

/**
 * T15 — le cœur du téléchargeur. Les cas de rejet sont ceux du « Review Focus » : c'est la seule
 * barrière entre un lien collé et un `spawn` de yt-dlp.
 */

describe("validateYoutubeUrl", () => {
  it("accepte les formes valides et renvoie l'URL canonique", () => {
    expect(validateYoutubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(validateYoutubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(validateYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(validateYoutubeUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("rejette tout ce qui n'est pas un lien YouTube https valide", () => {
    expect(validateYoutubeUrl("file:///C:/x")).toBeNull();
    expect(validateYoutubeUrl("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(validateYoutubeUrl("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(validateYoutubeUrl("http://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(validateYoutubeUrl("https://youtu.be/abc")).toBeNull();
    expect(validateYoutubeUrl("https://youtu.be/dQw4w9WgXcQ --exec calc")).toBeNull();
    expect(validateYoutubeUrl("https://youtu.be/dQw4w9WgXcQ;calc")).toBeNull();
    expect(validateYoutubeUrl("")).toBeNull();
    expect(validateYoutubeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("buildYtDlpArgs", () => {
  it("produit exactement la ligne d'arguments du plan", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "C:\\out", "C:\\ffmpeg.exe");
    expect(args).toEqual([
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--embed-thumbnail",
      "--add-metadata",
      "--no-playlist",
      "--newline",
      "--ffmpeg-location",
      "C:\\ffmpeg.exe",
      "-o",
      join("C:\\out", "%(artist,uploader)s - %(title)s.%(ext)s"),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
  });
});

describe("buildYtDlpArgs — ffmpeg", () => {
  it("omet --ffmpeg-location quand le chemin est inconnu (yt-dlp cherche dans le PATH)", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "C:\\out", null);
    expect(args).not.toContain("--ffmpeg-location");
    expect(args).toContain("-x");
    expect(args).toContain("mp3");
  });

  it("accepte un chemin réel", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "C:\\out", "C:\\ffmpeg.exe");
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("C:\\ffmpeg.exe");
  });
});

describe("parseProgress", () => {
  it("lit une ligne de téléchargement", () => {
    expect(parseProgress("[download]  42.3% of 3.21MiB at 1.2MiB/s ETA 00:02")).toEqual({
      percent: 42.3,
      stage: "download",
    });
  });

  it("lit l'étape de conversion", () => {
    expect(parseProgress("[ExtractAudio] Destination: a - b.mp3")).toEqual({ percent: 100, stage: "convert" });
  });

  it("ignore les lignes sans avancement", () => {
    expect(parseProgress("[youtube] dQw4w9WgXcQ: Downloading webpage")).toBeNull();
    expect(parseProgress("")).toBeNull();
  });
});

describe("ensureYtDlp", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const fakeBinary = Buffer.from("MZ fake yt-dlp binary");
  const goodSum = createHash("sha256").update(fakeBinary).digest("hex");

  function fakeFetch(sums: string) {
    return (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("SHA2-256SUMS")) return new Response(sums, { status: 200 });
      if (url.endsWith("yt-dlp.exe")) return new Response(fakeBinary, { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  it("télécharge quand l'empreinte correspond", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benten-ytdlp-"));
    dirs.push(dir);
    const path = await ensureYtDlp(dir, fakeFetch(`${goodSum}  yt-dlp.exe\n`));
    expect(existsSync(path)).toBe(true);
    expect((await readFile(path)).equals(fakeBinary)).toBe(true);
  });

  it("supprime et rejette quand l'empreinte ne correspond pas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benten-ytdlp-"));
    dirs.push(dir);
    const wrong = "0".repeat(64);
    await expect(ensureYtDlp(dir, fakeFetch(`${wrong}  yt-dlp.exe\n`))).rejects.toThrow(/empreinte/);
    expect(existsSync(join(dir, "yt-dlp.exe"))).toBe(false);
  });

  it("réutilise un binaire déjà présent sans rien télécharger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benten-ytdlp-"));
    dirs.push(dir);
    await writeFile(join(dir, "yt-dlp.exe"), "already here");
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const path = await ensureYtDlp(dir, counting);
    expect(path).toBe(join(dir, "yt-dlp.exe"));
    expect(calls).toBe(0);
  });

  it("lit l'empreinte du bon fichier dans un fichier de sommes", () => {
    const text = `${"a".repeat(64)}  other.exe\n${"b".repeat(64)}  yt-dlp.exe\n`;
    expect(checksumFor(text, "yt-dlp.exe")).toBe("b".repeat(64));
    expect(checksumFor(text, "missing.exe")).toBeNull();
  });
});

