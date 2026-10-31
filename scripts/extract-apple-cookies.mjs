/**
 * Extraction des cookies Apple Music depuis Chrome ou Edge (Windows).
 *
 * POURQUOI CE SCRIPT
 * L'import Apple de Benten a besoin d'un fichier `cookies.txt` au format Netscape. Les navigateurs
 * stockent ces cookies chiffrés (AES-256-GCM) avec une clé elle-même protégée par DPAPI au compte
 * Windows. Ce script refait le chemin inverse, localement, sans rien envoyer nulle part :
 *
 *   1. copie la base SQLite des cookies (le navigateur la verrouille : il doit être FERMÉ) ;
 *   2. lit `Local State`, déchiffre `encrypted_key` avec DPAPI (compte courant) ;
 *   3. déchiffre chaque valeur `v10`/`v11` : nonce (12 o) + chiffré + tag (16 o) ;
 *   4. écrit `%APPDATA%\benten\cookies.txt` au format Netscape.
 *
 * USAGE
 *   node scripts/extract-apple-cookies.mjs            # Chrome puis Edge
 *   node scripts/extract-apple-cookies.mjs --browser=edge
 *
 * SÉCURITÉ
 * Le fichier produit contient des jetons de session : il reste sur cette machine, dans le dossier
 * de données de l'app. Ne pas le partager.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const BROWSERS = {
  chrome: join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data"),
  edge: join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "User Data"),
};
const DOMAINS = ["%.apple.com"];
const OUT = join(process.env.APPDATA ?? "", "benten", "cookies.txt");

/** Déchiffre une clé DPAPI via PowerShell (même compte utilisateur). */
function unprotectDpapi(base64) {
  const ps = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${base64}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($plain)
`;
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  return Buffer.from(out, "base64");
}

/** Déchiffre une valeur de cookie Chrome (v10/v11) avec la clé AES-GCM. */
function decryptValue(key, buffer) {
  if (buffer.length < 3 + 12 + 16) return null;
  const prefix = buffer.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return null;
  const nonce = buffer.subarray(3, 15);
  const tag = buffer.subarray(buffer.length - 16);
  const data = buffer.subarray(15, buffer.length - 16);
  const ps = `
$key = [Convert]::FromBase64String('${key.toString("base64")}')
$nonce = [Convert]::FromBase64String('${nonce.toString("base64")}')
$tag = [Convert]::FromBase64String('${tag.toString("base64")}')
$data = [Convert]::FromBase64String('${data.toString("base64")}')
$plain = New-Object byte[] $data.Length
$aes = [System.Security.Cryptography.AesGcm]::new($key)
$aes.Decrypt($nonce, $data, $tag, $plain)
[Convert]::ToBase64String($plain)
`;
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  return Buffer.from(out, "base64");
}

function tryBrowser(name) {
  const root = BROWSERS[name];
  if (!root || !existsSync(root)) return null;
  const dbPath = join(root, "Default", "Network", "Cookies");
  const statePath = join(root, "Local State");
  if (!existsSync(dbPath) || !existsSync(statePath)) return null;

  const work = mkdtempSync(join(tmpdir(), "benten-cookies-"));
  const copy = join(work, "Cookies");
  try {
    copyFileSync(dbPath, copy); // échoue si le navigateur tourne : c'est voulu (verrou exclusif)
  } catch {
    rmSync(work, { recursive: true, force: true });
    return { name, locked: true };
  }

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const encryptedKey = Buffer.from(state.os_crypt.encrypted_key, "base64").subarray(5); // "DPAPI"
  const key = unprotectDpapi(encryptedKey.toString("base64"));

  const db = new Database(copy, { readonly: true });
  const rows = db
    .prepare(
      `select host_key, name, path, expires_utc, is_secure, is_httponly, encrypted_value, value
         from cookies where host_key like ? or host_key like ?`,
    )
    .all(...DOMAINS);
  db.close();
  rmSync(work, { recursive: true, force: true });

  const lines = ["# Netscape HTTP Cookie File", "# Genere par Benten — ne pas partager", ""];
  let kept = 0;
  for (const row of rows) {
    let value = row.value;
    if (!value && row.encrypted_value?.length) {
      const plain = decryptValue(key, Buffer.from(row.encrypted_value));
      if (!plain) continue;
      // Chrome 130+ prefixe le domaine (SHA-256) aux 32 premiers octets : on le retire.
      const hostHash = Buffer.from(
        execFileSync("pwsh", [
          "-NoProfile",
          "-Command",
          `$h=[System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('${row.host_key}'));[Convert]::ToBase64String($h)`,
        ], { encoding: "utf8" }).trim(),
        "base64",
      );
      value = (plain.length > 32 && plain.subarray(0, 32).equals(hostHash)
        ? plain.subarray(32)
        : plain
      ).toString("utf8");
    }
    if (!value) continue;
    // expires_utc : microsecondes depuis 1601 -> secondes Unix.
    const unix = row.expires_utc ? Math.floor(row.expires_utc / 1_000_000 - 11_644_473_600) : 0;
    lines.push(
      [
        row.host_key,
        row.host_key.startsWith(".") ? "TRUE" : "FALSE",
        row.path || "/",
        row.is_secure ? "TRUE" : "FALSE",
        String(unix),
        row.name,
        value,
      ].join("\t"),
    );
    kept += 1;
  }
  if (kept === 0) return { name, empty: true };
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  return { name, kept, out: OUT };
}

const wanted = process.argv.includes("--browser=edge") ? ["edge"] : ["chrome", "edge"];
for (const name of wanted) {
  const result = tryBrowser(name);
  if (!result) continue;
  if (result.locked) {
    console.log(`[${name}] base verrouillée — ferme le navigateur puis relance ce script`);
    continue;
  }
  if (result.empty) {
    console.log(`[${name}] aucun cookie Apple Music (connecte-toi à music.apple.com)`);
    continue;
  }
  console.log(`[${name}] ${result.kept} cookies Apple écrits dans ${result.out}`);
  process.exit(0);
}
console.log("aucun cookie extrait");
process.exit(1);
