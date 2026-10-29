// Harnais de vérification CDP : se connecte au renderer Electron réel via le Chrome
// DevTools Protocol (WebSocket brut, aucune dépendance), évalue une expression dans le
// contexte de la page et sort 0 si le résultat `ok === true`, sinon 1. Réutilisé par les
// vérifications « réelles » des tâches suivantes pour prouver le comportement du vrai renderer.
//
// Usage : node scripts/cdp-smoke.mjs --port 9222 --timeout 20000 --expr "<IIFE async {ok}>"
//         [--screenshot design/screens/x.png]
// `--screenshot` capture la page (PNG) après l'expression et ajoute `screenshot` (chemin absolu)
// à la sortie JSON ; sans `--expr`, la sortie est `{ok:true, screenshot}`.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Analyse les arguments CLI. Port par défaut 9222, timeout par défaut 20000 ms.
 * @param {string[]} argv
 * @returns {{ port: number, timeout: number, expr?: string, screenshot?: string }}
 */
export function parseArgs(argv) {
  const args = { port: 9222, timeout: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--expr") args.expr = argv[++i];
    else if (a === "--screenshot") args.screenshot = argv[++i];
  }
  return args;
}

/**
 * Enveloppe une promesse d'un délai : rejette avec une erreur « timeout » si elle n'a pas
 * abouti dans `ms` millisecondes. Nettoie toujours son minuteur.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Récupère la liste des cibles débogables exposées par Electron/Chromium. */
async function fetchTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`/json HTTP ${res.status}`);
  return res.json();
}

/** Première cible de type `page` exposant un WebSocket de débogage (le renderer). */
function pickPageTarget(targets) {
  return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

/**
 * Envoie UNE commande CDP (`method`, `params`) sur une connexion neuve, résout avec son `result`
 * brut, puis ferme la connexion. Rejette sur erreur protocole, fermeture prématurée ou délai.
 */
function cdpCall(wsUrl, method, params, timeout) {
  const ws = new WebSocket(wsUrl);
  const id = 1;
  const result = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      if (msg.error) reject(new Error(msg.error.message ?? "CDP error"));
      else resolve(msg.result);
    });
    ws.addEventListener("error", (ev) =>
      reject(new Error(ev?.error?.message ?? ev?.message ?? "websocket error")),
    );
    ws.addEventListener("close", () => reject(new Error("websocket closed before result")));
  });
  return withTimeout(result, timeout).finally(() => {
    try {
      ws.close();
    } catch {
      /* déjà fermé */
    }
  });
}

/**
 * Évalue une expression via `Runtime.evaluate`. `awaitPromise` attend les IIFE async ;
 * `returnByValue` renvoie une valeur sérialisée.
 */
async function evaluate(wsUrl, expression, timeout) {
  const result = await cdpCall(
    wsUrl,
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    timeout,
  );
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "evaluation exception");
  }
  return result?.result?.value;
}

/**
 * Capture la page via `Page.captureScreenshot` (PNG) et l'écrit dans `file` (dossiers créés au
 * besoin). Renvoie le chemin absolu écrit.
 */
async function captureScreenshot(wsUrl, file, timeout) {
  const result = await cdpCall(wsUrl, "Page.captureScreenshot", { format: "png" }, timeout);
  if (typeof result?.data !== "string" || result.data.length === 0) {
    throw new Error("Page.captureScreenshot returned no data");
  }
  const out = resolvePath(file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(result.data, "base64"));
  return out;
}

async function main() {
  const { port, timeout, expr, screenshot } = parseArgs(process.argv.slice(2));
  if (!expr && !screenshot) {
    console.log(JSON.stringify({ ok: false, error: "missing --expr or --screenshot" }));
    process.exit(1);
    return;
  }

  const deadline = Date.now() + timeout;
  try {
    // 1) Attendre qu'une cible `page` du renderer soit disponible (fenêtre pas encore prête).
    let wsUrl;
    while (Date.now() < deadline) {
      try {
        const page = pickPageTarget(await fetchTargets(port));
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* endpoint CDP pas encore à l'écoute */
      }
      await sleep(250);
    }
    if (!wsUrl) throw new Error(`no page target on port ${port} within ${timeout}ms`);

    // 2) Attendre que le pont préchargé `window.benten` soit exposé avant l'évaluation finale.
    while (Date.now() < deadline) {
      const ready = await evaluate(
        wsUrl,
        "typeof window.benten !== 'undefined'",
        Math.max(1000, deadline - Date.now()),
      );
      if (ready === true) break;
      await sleep(250);
    }

    // 3) Évaluer l'expression demandée (si fournie) ; sans `--expr`, seul le cliché décide.
    let value = { ok: true };
    if (expr) value = await evaluate(wsUrl, expr, Math.max(1000, deadline - Date.now()));

    // 4) Capture d'écran éventuelle, prise APRÈS l'expression (même en échec : aide au diagnostic).
    if (screenshot) {
      const path = await captureScreenshot(wsUrl, screenshot, Math.max(1000, deadline - Date.now()));
      value =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? { ...value, screenshot: path }
          : { ok: false, value, screenshot: path };
    }

    console.log(JSON.stringify(value));
    process.exit(value && value.ok === true ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    process.exit(1);
  }
}

// N'exécuter la CLI que lancé directement — importer le module (tests) n'ouvre aucun socket.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
