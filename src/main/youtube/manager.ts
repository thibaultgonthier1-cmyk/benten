import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildYtDlpArgs, parseProgress, validateYoutubeUrl, type JobState } from "./ytdlp";

/**
 * File de téléchargement YouTube → MP3.
 *
 * Un seul travail à la fois (yt-dlp sature vite sinon et l'utilisateur n'a qu'une barre de
 * progression à lire). Chaque travail traverse `queued → downloading → converting → done | error`.
 * Le fichier produit est retrouvé en comparant le dossier avant/après : on ne devine pas le nom
 * que yt-dlp a écrit, on observe ce qui est apparu.
 *
 * Toutes les dépendances sont injectables (`spawnImpl`, `listFiles`) : la logique de file est
 * testable sans réseau ni binaire.
 */

export interface YoutubeJob {
  id: string;
  url: string;
  playlistId: number | null;
  state: JobState;
  percent: number;
  stage: "download" | "convert" | "queue";
  error: string | null;
  filePath: string | null;
  addedAt: number;
}

export interface YoutubeManagerOptions {
  binaryPath: string;
  outputDir: string;
  /** Chemin réel de ffmpeg ; absent → yt-dlp le cherche dans le PATH. */
  ffmpegPath?: string | null;
  spawnImpl?: typeof spawn;
  listFiles?: (dir: string) => Promise<string[]>;
  onProgress?: (job: YoutubeJob) => void;
  onDone?: (job: YoutubeJob) => void | Promise<void>;
  onError?: (job: YoutubeJob) => void;
}

/** Fichiers `.mp3` d'un dossier, avec leur date de modification. */
async function defaultListFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.toLowerCase().endsWith(".mp3"));
  } catch {
    return [];
  }
}

let counter = 0;

export class YoutubeManager {
  private readonly jobs = new Map<string, YoutubeJob>();
  private readonly queue: string[] = [];
  private running = false;
  private current: ReturnType<typeof spawn> | null = null;

  constructor(private readonly options: YoutubeManagerOptions) {}

  jobsList(): YoutubeJob[] {
    return [...this.jobs.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  /**
   * Met un lien en file. Renvoie `null` si le lien n'est pas un YouTube https valide — la
   * validation est ici la dernière barrière avant le `spawn`.
   */
  enqueue(rawUrl: string, playlistId: number | null = null): YoutubeJob | null {
    const url = validateYoutubeUrl(rawUrl);
    if (!url) return null;
    counter += 1;
    const job: YoutubeJob = {
      id: `yt-${counter}`,
      url,
      playlistId,
      state: "queued",
      percent: 0,
      stage: "queue",
      error: null,
      filePath: null,
      addedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.options.onProgress?.({ ...job });
    void this.drain();
    return job;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const id = this.queue.shift();
        if (!id) break;
        const job = this.jobs.get(id);
        if (!job) continue;
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: YoutubeJob): Promise<void> {
    const { binaryPath, outputDir, ffmpegPath } = this.options;
    const list = this.options.listFiles ?? defaultListFiles;
    const before = new Set(await list(outputDir));

    job.state = "downloading";
    job.stage = "download";
    this.options.onProgress?.({ ...job });

    await new Promise<void>((resolve) => {
      const child = (this.options.spawnImpl ?? spawn)(binaryPath, buildYtDlpArgs(job.url, outputDir, ffmpegPath), {
        shell: false,
        windowsHide: true,
      });
      this.current = child;

      const handleLine = (line: string): void => {
        const parsed = parseProgress(line);
        if (!parsed) return;
        job.percent = parsed.percent;
        job.stage = parsed.stage;
        job.state = parsed.stage === "convert" ? "converting" : "downloading";
        this.options.onProgress?.({ ...job });
      };

      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) job.error = text.slice(-400);
      });

      child.on("error", (error) => {
        job.state = "error";
        job.error = error.message;
        this.options.onError?.({ ...job });
        resolve();
      });

      child.on("close", async (code) => {
        this.current = null;
        if (code !== 0) {
          job.state = "error";
          job.error = job.error ?? `yt-dlp a quitté avec le code ${code}`;
          this.options.onError?.({ ...job });
          return resolve();
        }
        const after = await list(outputDir);
        const fresh = after.filter((name) => !before.has(name));
        const newest = fresh.length ? await pickNewest(outputDir, fresh) : null;
        if (!newest) {
          job.state = "error";
          job.error = "aucun fichier MP3 produit";
          this.options.onError?.({ ...job });
          return resolve();
        }
        job.filePath = join(outputDir, newest);
        job.state = "done";
        job.percent = 100;
        this.options.onProgress?.({ ...job });
        await this.options.onDone?.({ ...job });
        resolve();
      });
    });
  }

  cancel(jobId: string): void {
    this.current?.kill();
    const job = this.jobs.get(jobId);
    if (job && job.state !== "done") {
      job.state = "error";
      job.error = "annulé";
      this.options.onProgress?.({ ...job });
    }
  }
}

async function pickNewest(dir: string, names: string[]): Promise<string | null> {
  let best: { name: string; at: number } | null = null;
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      if (!best || info.mtimeMs > best.at) best = { name, at: info.mtimeMs };
    } catch {
      // Fichier disparu entre le listage et le stat : on l'ignore.
    }
  }
  return best ? best.name : null;
}


