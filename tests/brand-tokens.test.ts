import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_RGB } from "../src/renderer/lib/palette";

/**
 * DA « Biwa & Or » (Tâche DA1) : l'or remplace le magenta comme accent de marque.
 * (a) plus aucune trace du magenta dans le renderer ; (b) contrastes WCAG des tokens or ;
 * (c) repli de palette doré ; (d) aplats d'or => contenu en `--on-accent`, jamais en blanc.
 */

const ROOT = join(__dirname, "..");
const RENDERER = join(ROOT, "src", "renderer");
const MAGENTA = /e73c82|231,\s*60,\s*130|ee5592|c22e6b|d93578|f04d8f/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** Valeurs des propriétés personnalisées déclarées dans un fichier CSS (dernière déclaration). */
function cssVars(css: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

/** Résout `var(--x)` (récursif) dans la table de variables. */
function resolve(vars: Map<string, string>, name: string, depth = 0): string {
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`variable ${name} absente`);
  const m = /^var\((--[\w-]+)\)$/.exec(raw);
  if (m && depth < 8) return resolve(vars, m[1]!, depth + 1);
  return raw;
}

function hex(h: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`pas un hex : ${h}`);
  let s = m[1]!;
  if (s.length === 3) s = s.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

/** Luminance relative WCAG 2.x. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(hex(a));
  const lb = luminance(hex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const dsTokens = readFileSync(join(RENDERER, "theme", "ds", "tokens.css"), "utf8");
const legacyTokens = readFileSync(join(RENDERER, "theme", "tokens.css"), "utf8");

describe("brand tokens — Biwa & Or", () => {
  it("(a) aucun magenta dans src/renderer (ts, tsx, css)", () => {
    const hits: string[] = [];
    for (const file of walk(RENDERER)) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (MAGENTA.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("(b) --gold ≥ 4.5:1 sur #000, --on-accent ≥ 4.5:1 sur --gold", () => {
    const vars = cssVars(dsTokens);
    const gold = resolve(vars, "--gold");
    expect(gold.toLowerCase()).toBe("#d4aa50");
    expect(resolve(vars, "--accent").toLowerCase()).toBe("#d4aa50");
    expect(contrast(gold, "#000")).toBeGreaterThanOrEqual(4.5);
    const onAccent = resolve(vars, "--on-accent");
    expect(onAccent.toLowerCase()).toBe("#1a1206");
    expect(contrast(onAccent, gold)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve(vars, "--ivory"), "#000")).toBeGreaterThanOrEqual(4.5);
  });

  it("(b') tokens or & laque exposés avec les valeurs du plan", () => {
    const vars = cssVars(dsTokens);
    expect(vars.get("--gold-light")).toBe("#f0d38a");
    expect(vars.get("--gold-deep")).toBe("#8a6420");
    expect(vars.get("--lacquer-red")).toBe("#b8281b");
    expect(vars.get("--lacquer-red-deep")).toBe("#8e1e14");
    expect(vars.get("--ivory")).toBe("#f3efe8");
    expect(vars.get("--accent")).toBe("var(--gold)");
    expect(vars.get("--accent-press")).toBe("#b8913f");
    const norm = (v?: string) => v?.replace(/\s/g, "").replace(/,0\./g, ",.");
    expect(norm(vars.get("--accent-soft"))).toBe("rgba(212,170,80,.14)");
    expect(norm(vars.get("--accent-ring"))).toBe("rgba(212,170,80,.45)");
    expect(vars.get("--grad-btn")?.replace(/\s/g, "")).toBe(
      "linear-gradient(180deg,#f0d38a0%,#d4aa5055%,#b8862f100%)",
    );
  });

  it("(b'') l'ancien theme/tokens.css (chargé après) ne recouvre pas l'or ni l'accent", () => {
    const legacy = cssVars(legacyTokens);
    for (const name of ["--gold", "--accent", "--on-accent", "--magenta", "--magenta-soft", "--magenta-press"]) {
      expect(legacy.has(name), `${name} redéfini dans theme/tokens.css`).toBe(false);
    }
  });

  it("(c) FALLBACK_RGB est l'or [212,170,80]", () => {
    expect(FALLBACK_RGB).toEqual([212, 170, 80]);
  });

  /* ---- WCAG 1.4.11 (non-texte ≥ 3:1) et 1.4.3 (texte ≥ 4.5:1) ---- */

  it("(e) --focus-ring est de l'or plein, ≥ 3:1 sur #000", () => {
    const vars = cssVars(dsTokens);
    const ring = resolve(vars, "--focus-ring");
    expect(ring.toLowerCase()).toBe("#d4aa50");
    expect(contrast(ring, "#000")).toBeGreaterThanOrEqual(3);
  });

  it("(e') toute règle :focus / :focus-visible utilise --focus-ring, jamais --accent-ring ni un or translucide", () => {
    const offenders: string[] = [];
    let focusRules = 0;
    for (const file of walk(RENDERER).filter((f) => f.endsWith(".css"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1]!.trim();
        const body = m[2]!;
        if (!/:focus(-visible)?\b/.test(sel)) continue;
        if (!/(outline|box-shadow)\s*:/.test(body)) continue;
        if (/^\s*outline\s*:\s*none\s*;\s*$/.test(body)) continue;
        focusRules++;
        if (/accent-ring|rgba\(212,\s*170,\s*80/.test(body)) offenders.push(`${relative(ROOT, file)} ${sel}`);
      }
    }
    expect(focusRules).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("(f) --favorite (cœur actif) ≥ 3:1 sur #000, distinct du rouge laque d'aplat", () => {
    const vars = cssVars(dsTokens);
    const fav = resolve(vars, "--favorite");
    expect(contrast(fav, "#000")).toBeGreaterThanOrEqual(3);
    expect(vars.get("--lacquer-red")).toBe("#b8281b");
    const css = walk(RENDERER)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const sel of [".track-row__heart.is-on", ".album-actions__fav.is-on", ".ic.fav.on"]) {
      const esc = sel.replace(/\./g, "\\.");
      const colors = [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, "g"))]
        .map((m) => /(?:^|[;\s])color\s*:\s*([^;]+);/.exec(m[1]!)?.[1]?.trim())
        .filter((c): c is string => c !== undefined);
      expect(colors, sel).toEqual(["var(--favorite)"]);
    }
  });

  it("(g) --danger-text ≥ 4.5:1 sur la surface du menu (cas le plus clair : élément focalisé)", () => {
    const vars = cssVars(dsTokens);
    const danger = resolve(vars, "--danger-text");
    // .cm-panel : rgba(22,22,26,.86) sur noir, + reflet blanc 5 %, + survol/focus blanc 7.5 %.
    const over = (base: number[], top: number[], a: number) => base.map((c, i) => c * (1 - a) + top[i]! * a);
    let s = over([0, 0, 0], [22, 22, 26], 0.86);
    s = over(s, [255, 255, 255], 0.05);
    s = over(s, [255, 255, 255], 0.075);
    const surface = "#" + s.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
    expect(contrast(danger, surface)).toBeGreaterThanOrEqual(4.5);
    const menu = readFileSync(join(RENDERER, "ui", "interaction.css"), "utf8");
    expect(menu).not.toMatch(/f26b7a/i);
    expect(menu).toMatch(/\.cm-item\.is-danger\s*\{[^}]*color\s*:\s*var\(--danger-text\)/);
  });

  it("(d) une règle à aplat d'or ne pose jamais de blanc dessus", () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER).filter((f) => f.endsWith(".css"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2]!;
        if (!/background\s*:\s*var\(--(grad-btn|accent|gold)\)\s*;/.test(body)) continue;
        const color = /(?:^|[;\s])(color|fill)\s*:\s*([^;]+);/.exec(body);
        if (color && color[2]!.trim() !== "var(--on-accent)") {
          offenders.push(`${relative(ROOT, file)} ${m[1]!.trim()} → ${color[1]}: ${color[2]!.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
