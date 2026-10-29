import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { YoutubeManager, type YoutubeJob } from "../src/main/youtube/manager";

/**
 * T15 — la file : un seul travail à la fois, états lisibles, fichier produit retrouvé par
 * comparaison du dossier (jamais en devinant le nom écrit par yt-dlp).
 *
 * `spawn` et `listFiles` sont injectés : aucun binaire, aucun réseau.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = (): boolean => true;
}

function fakeSpawn(script: (child: FakeChild) => void) {
  return (() => {
    const child = new FakeChild();
    setTimeout(() => script(child), 0);
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("YoutubeManager", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "benten-yt-"));
    dirs.push(dir);
    return dir;
  }

  it("refuse un lien non YouTube et ne crée aucun travail", async () => {
    const dir = await tempDir();
    const manager = new YoutubeManager({ binaryPath: "yt-dlp.exe", outputDir: dir, ffmpegPath: "ffmpeg.exe" });
    expect(manager.enqueue("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(manager.jobsList()).toHaveLength(0);
  });

  it("suit les états jusqu'à done et remonte le fichier produit", async () => {
    const dir = await tempDir();
    const seen: string[] = [];
    const done: YoutubeJob[] = [];
    const manager = new YoutubeManager({
      binaryPath: "yt-dlp.exe",
      outputDir: dir,
      ffmpegPath: "ffmpeg.exe",
      spawnImpl: fakeSpawn((child) => {
        child.stdout.emit("data", Buffer.from("[download]  42.3% of 3MiB\n"));
        setTimeout(() => child.stdout.emit("data", Buffer.from("[ExtractAudio] Destination: out.mp3\n")), 5);
        setTimeout(async () => {
          await writeFile(join(dir, "Artist - Title.mp3"), "mp3");
          child.emit("close", 0);
        }, 10);
      }),
      listFiles: async (d) => {
        const { readdir } = await import("node:fs/promises");
        return (await readdir(d)).filter((n) => n.endsWith(".mp3"));
      },
      onProgress: (job) => seen.push(job.state),
      onDone: (job) => {
        done.push(job);
      },
    });

    const job = manager.enqueue("https://youtu.be/dQw4w9WgXcQ", 7);
    expect(job?.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(seen).toContain("downloading");
    expect(seen).toContain("converting");
    expect(done).toHaveLength(1);
    expect(done[0]?.state).toBe("done");
    expect(done[0]?.filePath).toBe(join(dir, "Artist - Title.mp3"));
    expect(done[0]?.playlistId).toBe(7);
  });

  it("passe en erreur quand yt-dlp échoue", async () => {
    const dir = await tempDir();
    const errors: YoutubeJob[] = [];
    const manager = new YoutubeManager({
      binaryPath: "yt-dlp.exe",
      outputDir: dir,
      ffmpegPath: "ffmpeg.exe",
      spawnImpl: fakeSpawn((child) => {
        child.stderr.emit("data", Buffer.from("ERROR: Video unavailable\n"));
        setTimeout(() => child.emit("close", 1), 5);
      }),
      listFiles: async () => [],
      onError: (job) => errors.push(job),
    });
    manager.enqueue("https://youtu.be/dQw4w9WgXcQ");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.state).toBe("error");
    expect(errors[0]?.error).toContain("Video unavailable");
  });

  it("traite deux liens l'un après l'autre", async () => {
    const dir = await tempDir();
    let concurrent = 0;
    let maxConcurrent = 0;
    const manager = new YoutubeManager({
      binaryPath: "yt-dlp.exe",
      outputDir: dir,
      ffmpegPath: "ffmpeg.exe",
      spawnImpl: fakeSpawn((child) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        setTimeout(() => {
          concurrent -= 1;
          child.emit("close", 1);
        }, 5);
      }),
      listFiles: async () => [],
    });
    manager.enqueue("https://youtu.be/dQw4w9WgXcQ");
    manager.enqueue("https://youtu.be/dQw4w9WgXcQ");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(maxConcurrent).toBe(1);
  });
});

