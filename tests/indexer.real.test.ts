import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/main/library/db";
import { indexLibrary } from "../src/main/library/indexer";
import type { ScanSummary } from "../src/shared/types";

/**
 * Verification sur une vraie bibliotheque. Ignore par defaut ; lancer avec :
 *   BENTEN_REAL_LIB="C:\chemin\vers\bibliotheque" npx vitest run tests/indexer.real.test.ts
 */
const REAL = process.env["BENTEN_REAL_LIB"];

describe.skipIf(!REAL)("indexLibrary sur une bibliotheque reelle", () => {
  it("indexe sans exception et reste idempotent", { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "benten-real-"));
    const db = openDb(join(dir, "real.db"));
    try {
      let events = 0;
      let last: ScanSummary | undefined;
      const t0 = performance.now();
      const first = await indexLibrary(db, [REAL!], (p) => {
        events++;
        last = p;
      });
      const ms = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const second = await indexLibrary(db, [REAL!]);
      const ms2 = Math.round(performance.now() - t1);
      console.log(
        `[real] pass1 added=${first.added} skipped=${first.skipped} errors=${last?.errors} ` +
          `scanned=${last?.scanned} progressEvents=${events} time=${ms}ms | ` +
          `pass2 added=${second.added} skipped=${second.skipped} time=${ms2}ms`,
      );
      expect(first.added).toBeGreaterThan(0);
      expect(second.added).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
