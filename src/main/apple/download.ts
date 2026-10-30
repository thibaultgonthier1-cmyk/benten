// Porté depuis Prism (même auteur, même pipeline). Code d'origine conservé tel quel :
// typage explicite à la frontière dans src/main/apple/index.ts.
// @ts-nocheck
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Runs gamdl across several workers at once.
 *
 * gamdl itself is sequential — it walks a URL list one track at a time. The way
 * to go faster is several independent processes, each with its own slice of the
 * playlist, all writing into the same output tree. Nothing is shared between
 * them, so there is no lock and no race: different tracks, different files.
 *
 * Progress is measured by watching the output folder, which is also what makes
 * it honest: the count is files on disk, not a hopeful percentage.
 */

const AUDIO = new Set(['.m4a', '.aac', '.flac', '.mp3', '.wav']);
const POLL_MS = 1500;

function countAudio(root) {
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (AUDIO.has(path.extname(entry.name).toLowerCase())) count += 1;
    }
  };
  walk(root, 0);
  return count;
}

export class AppleDownloadRunner {
  constructor({ cookiesPath, outputPath, databasePath, gamdlCommand = 'gamdl', workers = 3, onProgress = () => {} } = {}) {
    this.cookiesPath = cookiesPath;
    this.databasePath = databasePath || path.join(outputPath || '.', 'gamdl.db');
    this.outputPath = outputPath;
    this.gamdlCommand = gamdlCommand;
    this.maxWorkers = Math.max(1, Math.min(6, Number(workers) || 3));
    this.onProgress = onProgress;
    this.children = new Set();
    this.state = { running: false, done: 0, total: 0, workers: 0, startedAt: 0, error: '' };
    this.timer = null;
    this.work = null;
  }

  status() {
    return { ...this.state };
  }

  async start(tracks = [], { workers = this.maxWorkers } = {}) {
    if (this.state.running) throw new Error('An Apple download is already running.');
    const urls = tracks.map((track) => String(track.url || track)).filter((url) => /^https?:\/\//.test(url));
    if (!urls.length) throw new Error('No Apple Music links to download.');
    if (!this.cookiesPath || !fs.existsSync(this.cookiesPath)) throw new Error('cookies.txt is missing — export it from music.apple.com first.');

    const count = Math.max(1, Math.min(this.maxWorkers, Number(workers) || this.maxWorkers, urls.length));
    await fsp.mkdir(this.outputPath, { recursive: true });
    const scratch = path.join(this.outputPath, '.chunks');
    await fsp.mkdir(scratch, { recursive: true });

    const baseline = countAudio(this.outputPath);
    this.state = { running: true, done: 0, total: urls.length, workers: count, startedAt: Date.now(), error: '' };

    const chunks = Array.from({ length: count }, () => []);
    urls.forEach((url, index) => chunks[index % count].push(url));

    this.work = (async () => {
      const failures = [];
      await Promise.all(chunks.map(async (slice, index) => {
        const listFile = path.join(scratch, `chunk-${index}.txt`);
        await fsp.writeFile(listFile, slice.join('\n'), 'utf8');
        await new Promise((resolve) => {
          let child;
          try {
            child = spawn(this.gamdlCommand, ['-r', listFile, '-c', this.cookiesPath, '-o', this.outputPath, '--database-path', this.databasePath], {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (error) {
            failures.push(error.message);
            resolve();
            return;
          }
          this.children.add(child);
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
            if (stderr.length > 32 * 1024) stderr = stderr.slice(-16 * 1024);
          });
          let stdout = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > 32 * 1024) stdout = stdout.slice(-16 * 1024);
          });
          child.on('error', (error) => {
            failures.push(error.message);
            this.children.delete(child);
            resolve();
          });
          child.on('close', (code) => {
            this.children.delete(child);
            // gamdl exits 0 even when individual tracks fail; its own summary
            // line ("Finished with N error(s)") is the only failure signal.
            const summary = stdout.match(/Finished with (\d+) error/);
            const errors = summary ? Number(summary[1]) : 0;
            if (code !== 0 || errors > 0) {
              const reason = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).join(' · ');
              failures.push(`worker ${index + 1}: ${reason || `${errors} track(s) failed`}`);
            }
            resolve();
          });
        });
      }));
      return failures;
    })();

    this.timer = setInterval(() => {
      const files = countAudio(this.outputPath);
      this.state.done = Math.max(0, Math.min(this.state.total, files - baseline));
      this.state.workers = this.children.size;
      this.onProgress({ ...this.state });
    }, POLL_MS);
    this.timer.unref?.();

    const failures = await this.work;
    clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    this.state.done = Math.min(this.state.total, Math.max(0, countAudio(this.outputPath) - baseline));
    this.state.workers = 0;
    this.state.error = failures.length ? failures.slice(0, 3).join(' · ') : '';
    this.onProgress({ ...this.state });
    return { ...this.state, failures };
  }

  cancel() {
    for (const child of this.children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    this.children.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    this.state.workers = 0;
    this.onProgress({ ...this.state });
    return this.status();
  }

  dispose() {
    this.cancel();
  }
}





