# Packaging Benten for Windows

Benten ships as a double-clickable Windows app built with
[`electron-builder`](https://www.electron.build/) (pinned exact `24.13.3`).
No terminal is required to run the result.

## TL;DR — build it

```bash
npm install            # deps (incl. chokidar, better-sqlite3)
npm run build:win      # electron-vite build + electron-builder --win
```

Artifacts land in `release/` (git-ignored):

| File                              | What it is                                             | Size   |
| --------------------------------- | ------------------------------------------------------ | ------ |
| `release/Benten Setup 0.1.0.exe`  | **NSIS installer** — installs Benten, Start-menu shortcut + icon | ~120 MiB |
| `release/Benten 0.1.0 Portable.exe` | **Portable** — single file, no install, just double-click | ~120 MiB |
| `release/win-unpacked/Benten.exe` | Unpacked app dir (not a deliverable; used for fast verification) | — |

The NSIS installer is **per-user** (`perMachine: false`, no admin / UAC elevation),
not one-click (`oneClick: false`), and lets the user pick the install directory
(`allowToChangeInstallationDirectory: true`).

### Scripts

| Script              | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `npm run build:win` | Full build → NSIS installer **and** portable `.exe`.               |
| `npm run pack:dir`  | Fast unpacked build (`release/win-unpacked/`) for verification.    |
| `npm run rebuild:native` | Rebuild `better-sqlite3` against the local Electron ABI (dev).|

## Native module (better-sqlite3)

Benten opens its SQLite library DB at startup via `better-sqlite3`, a **native**
module. If that `.node` addon can't load, the app crashes immediately on launch —
so packaging has to get it right.

- `better-sqlite3@13.0.3` ships **N-API prebuilds** (`prebuilds/<platform>-<arch>.node`).
  N-API addons are ABI-stable, so the shipped `win32-x64.node` loads under Electron 45
  without a per-Electron rebuild. `electron-builder` also rebuilds native deps against
  the target Electron by default (`npmRebuild: true`).
- The addon **cannot** be `require()`'d from inside an `app.asar` archive, so
  `electron-builder.yml` lists it under `asarUnpack`:
  ```yaml
  asarUnpack:
    - "**/node_modules/better-sqlite3/**"
    - "**/node_modules/bindings/**"
    - "**/node_modules/file-uri-to-path/**"
    - "**/node_modules/node-gyp-build/**"
  ```
  At runtime it is loaded from
  `resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node`.

**Verified:** both `release/win-unpacked/Benten.exe` and the portable
`Benten 0.1.0 Portable.exe` launch and stay alive (multi-process Electron,
window shown) past the DB-open point — i.e. the native module loads in the
packaged app.

## Caveats

### Unsigned binary → Windows SmartScreen

The installer and portable `.exe` are **not code-signed** (no Authenticode
certificate). On first run, Windows SmartScreen will show:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from starting.

To run it: click **More info**, then **Run anyway**. This is expected for any
unsigned app and is harmless here. To remove the prompt entirely you would need
to sign the binaries with an EV/OV code-signing certificate (set `CSC_LINK` /
`CSC_KEY_PASSWORD`, or `win.certificateFile` + password, before building).

### Building on Windows without admin / Developer Mode (winCodeSign cache)

`electron-builder` downloads a `winCodeSign` helper bundle during the Windows
build. Its archive contains macOS dylib **symlinks**, and extracting symlinks on
Windows requires admin rights or **Developer Mode**. On a stock account the
extraction fails with:

> `Cannot create symbolic link : Le client ne dispose pas d'un privilège nécessaire`

and the build aborts. The bundle's Windows tools extract fine — only the two
irrelevant macOS symlinks fail. Workarounds (any one):

1. **Enable Windows Developer Mode** (Settings → Privacy & security → For
   developers) or run the build from an elevated shell, then rebuild. (Simplest.)
2. Pre-extract the bundle into the electron-builder cache so it isn't re-extracted:
   extract `winCodeSign-2.6.0.7z` (ignoring the 2 symlink errors) into
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` and drop a
   sibling `winCodeSign-2.6.0.state` file containing `{"version":1,"state":"complete", ...}`.

This only affects **building**; it has nothing to do with the shipped app.
Signing itself is not performed (no certificate configured), so the helper is
only touched, never used to sign.

## Offline / privacy

`publish: null` — no auto-update feed, no telemetry, no update server. The app is
fully self-contained and offline.

## Icon

`build/icon.ico` — Benten's mark: the white kanji **弁** on a magenta (`#e73c82`)
rounded square, multi-size (16–256 px). Referenced via `win.icon`. Regenerate with
Pillow if needed (render a PNG, save as multi-size `.ico`).

## Dev-only bridges are absent from production

The CDP debug port (`remote-debugging-port`) is gated on the `ELECTRON_RENDERER_URL`
env var, which is unset in production, and the `window.__benten` test bridge is
guarded by `import.meta.env.DEV` and dead-code-eliminated from the production
renderer bundle (verified: `__benten` does not appear anywhere under `out/`).
