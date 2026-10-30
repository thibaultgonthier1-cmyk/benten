# Benten — Plan d'implémentation, Phase 3 (« niveau grosse boîte »)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refondre toute l'interface de Benten au niveau d'une app phare (DA noire validée, système de motion, couleurs dynamiques, nouveaux écrans, ergonomie pro, logo + intro After Effects) et ajouter YouTube→MP3, la vue Titres, l'import de playlist Apple et des outils en option — sans toucher au cœur audio.

**Architecture:** Le runtime audio de `App.tsx` est **déplacé tel quel** dans `src/renderer/runtime/`, puis l'UI est reconstruite autour d'un **shell** (barre latérale, barre du haut, routes animées, barre de lecteur, calques) piloté par trois stores Zustand (lecteur existant, bibliothèque, UI/routeur maison). Un **design system** (variables CSS + CSS par composant + tokens de motion `framer-motion`) remplace le `tokens.css` monolithique. Les fonctions pures (palette, tri, sélection, raccourcis, parseurs Apple, correspondance, URL YouTube, minuteur) sont testées par Vitest ; l'apparence est vérifiée sur le **vrai renderer Electron** par captures CDP.

**Tech Stack:** Electron 45.1.0, React 18.3.1, TypeScript 5.9.3, electron-vite 6, Zustand 5.0.16, @tanstack/react-virtual 3.14.23, better-sqlite3 13.0.3, chokidar 3.6.0, Vitest 5.0.5 — **nouveaux** : `framer-motion`, `lucide-react`, `@fontsource/shippori-mincho`, `@fontsource/zen-kaku-gothic-new`, `ffmpeg-static`, `@resvg/resvg-js` (dev), `png-to-ico` (dev).

**Spec:** `docs/superpowers/specs/2026-10-29-benten-phase3-design.md` (référence visuelle : `design/motion/benten-intro-v2-endframe.png`, source motion : `design/motion/benten-intro.aep`).

## Global Constraints

- **Invariants audio (non négociables) :** un seul `AudioContext`, une seule boucle `tick()`, gapless à l'échantillon près, zéro clic/blanc, jamais plus d'une source vivante. Le runtime audio est **déplacé sans modification de comportement** ; aucune tâche UI n'appelle autre chose que l'API existante du store lecteur / `PlayerControls`. Seule exception autorisée : `engine.rampVolume` (Tâche 17), isolée sur le nœud de volume.
- **Fichiers de l'utilisateur jamais modifiés, déplacés ni supprimés.** Seule création autorisée : fichiers de Benten dans `Musique\Benten\YouTube` (Tâche 15).
- **Hors-ligne** pour tout sauf la fonction YouTube→MP3 (Tâche 15). Polices **embarquées** (`@fontsource/*`), jamais chargées du réseau.
- **DA :** fond `#000` uni ; la couleur vit sur le contenu ; accent magenta mat `#e73c82` ; matière douce (dégradé léger, reflet interne, ombre) **sans 3D ni effet exagéré** ; affichage *Shippori Mincho*, UI *Zen Kaku Gothic New*, chiffres tabulaires ; icônes `lucide-react` uniquement (+ marks Benten SVG).
- **Motion :** uniquement `transform`/`opacity` animés ; `prefers-reduced-motion` respecté ; réglage d'intensité `full` / `subtle` / `reduced` appliqué partout via `motionFor()`.
- **Listes longues virtualisées** (≥ 969 titres, ~784 albums) : Titres, Albums, Artistes, résultats.
- **IPC :** tout nouveau handler gardé par `assertTrusted`, arguments validés ; canaux push via `webContents.send`.
- **SQLite :** migration additive v2 → v3 uniquement (aucune perte).
- **Dépendances :** version **exacte** épinglée (pas de `^`/`~`), installée et vérifiée ; React reste `18.3.1`.
- **Gate dur par tâche :** `npm test` complet vert + `npm run typecheck` propre. Les tâches UI ajoutent une **capture CDP du vrai renderer** (`npm run check:cdp -- --screenshot <png>`), regardée avant de déclarer la tâche finie.
- **Commits** terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Bibliothèque réelle de dev (lecture seule) : `C:\Users\Dream\Downloads\REA DS\.prism-profile\documents\Prism Library`.

## Review Focus

- **Régression audio après l'extraction du runtime** (Tâche 2) → la promotion gapless se fait toujours sans passer par `status:"loading"`, un seul `AudioContext` reste vivant, la reprise au lancement se fait en pause. *(Test : Tâche 2, vérif CDP.)*
- **Raccourcis clavier pendant la saisie** (Espace tapé dans la recherche) → ne doit **jamais** lancer/couper la lecture ; seule `Échap` reste active dans un champ. *(Test : Tâche 4.)*
- **Lien YouTube hostile ou non-YouTube** (`file://`, `https://evil.com/?v=`, arguments déguisés `--exec`, espaces/`;`) → refusé avant tout lancement ; yt-dlp appelé avec un tableau d'arguments, jamais un shell. *(Test : Tâche 15.)*
- **Export Apple Music réel** (UTF-16LE avec BOM, en-têtes **français** « Nom / Artiste / Durée / Date d'ajout », accents, « (Slowed) », « feat. ») → l'ordre est conservé, les titres correspondent, les non-trouvés sont listés, jamais de plantage. *(Test : Tâche 16.)*
- **Grande bibliothèque** (969 titres, 784 albums) → Titres/Albums restent virtualisés et fluides ; l'extraction de couleur ne tourne que pour les pochettes visibles (cache borné). *(Test : Tâches 5 et 7.)*

---

## Structure de fichiers (Phase 3)

```
src/renderer/
  main.tsx                      # MODIF : charge le DS + MotionConfig
  App.tsx                       # MODIF : devient un mince assemblage (runtime + Shell)
  runtime/
    audioRuntime.ts             # CREATE : moteur, liaison store, boucle tick, recréation de contexte, persistance, pont dev (DÉPLACÉ)
    restore.ts                  # CREATE : reprise au lancement (DÉPLACÉ)
    mediaSession.ts             # CREATE : touches média + overlay Windows
    playHistory.ts              # CREATE : enregistrement des écoutes
    sleepTimer.ts               # CREATE : minuteur de sommeil
  state/
    player.ts                   # existant (inchangé sauf ajouts mineurs listés)
    library.ts                  # CREATE : albums, titres, artistes, sources, scan, recherche
    ui.ts                       # CREATE : routeur maison + overlays + mode compact
    settings.ts                 # CREATE : intensité du mouvement, intro au lancement
  theme/
    tokens.css                  # MODIF → variables uniquement (le reste migre vers ds/ et composants)
    ds/base.css, ds/tokens.css, ds/motion.ts   # CREATE : design system
  lib/
    palette.ts, useCoverColors.ts, dnd.ts, shortcuts.ts, viewModels.ts   # CREATE (pur + hooks)
  ui/                           # CREATE : briques du DS (Button, IconButton, ContextMenu, Toast, Dialog, Skeleton, AlbumTile, TrackRowItem, BentenLogo…)
  shell/                        # CREATE : Shell, Sidebar, TopBar, RouteView, IntroSplash
  views/                        # CREATE : Home, Tracks, Albums, Album, Artists, Artist, Playlists, Playlist, Search, Downloads, Settings, Onboarding, ImportPlaylistDialog
  player/                       # CREATE : PlayerBar, NowPlayingView, QueuePanel, SleepTimerMenu, CompactPlayer
src/main/
  youtube/ytdlp.ts, download.ts, manager.ts   # CREATE
  importer/applePlaylist.ts, matcher.ts       # CREATE
  library/db.ts, repository.ts, ipc.ts, index.ts   # MODIF
scripts/cdp-smoke.mjs (MODIF), scripts/make-icon.mjs (CREATE)
design/logo/benten-logo.svg (CREATE), build/icon.ico (régénéré)
```

Les anciens composants (`LibraryGrid`, `AlbumCard`, `MiniPlayer`, `NowPlaying`, `QueuePanel`, `Playlists`, `SearchResults`, `SortFilterBar`, `AddToPlaylistSheet`) sont **supprimés dans la tâche qui les remplace**.

---

### Task 1 : Fondations du design system + capture CDP

**Files:**
- Create: `src/renderer/theme/ds/tokens.css`, `src/renderer/theme/ds/base.css`, `src/renderer/theme/ds/motion.ts`, `src/renderer/state/settings.ts`
- Modify: `package.json`, `src/renderer/main.tsx`, `scripts/cdp-smoke.mjs`, `scripts/cdp-smoke.d.mts`
- Test: `tests/motion-tokens.test.ts`, `tests/settings-store.test.ts`, `tests/cdp-harness.test.ts` (ajout)

**Interfaces:**
- Produces:
  - `ds/tokens.css` : variables `--bg:#000`, `--surface-1..3`, `--line`, `--text`, `--text-dim`, `--accent:#e73c82`, `--accent-soft`, `--radius-s/m/l/xl`, `--space-1..8`, `--shadow-1..3` (ombres douces), `--grad-btn` (dégradé magenta du bouton primaire), `--font-display:"Shippori Mincho"`, `--font-ui:"Zen Kaku Gothic New"`, `--z-*`.
  - `ds/base.css` : reset, `@import` des `@fontsource` (Shippori Mincho 500/600 ; Zen Kaku Gothic New 400/500/700), `body{background:#000}`, `font-variant-numeric: tabular-nums` sur `.num`.
  - `ds/motion.ts` : `export type MotionIntensity = "full" | "subtle" | "reduced"`; `export const dur = { fast: 0.15, base: 0.25, slow: 0.45 }`; `export const ease = { out: [0.2, 0.8, 0.2, 1], inOut: [0.65, 0, 0.35, 1] } as const`; `export const springs = { snappy: {type:"spring", stiffness:520, damping:34}, soft: {type:"spring", stiffness:260, damping:30} }`; `export function motionFor(intensity: MotionIntensity, prefersReduced: boolean): { enabled: boolean; d(base: number): number; spring: typeof springs.snappy }`.
  - `state/settings.ts` : store Zustand vanilla `settingsStore` + hook `useSettings(sel)` ; état `{ motionIntensity: MotionIntensity; showIntro: boolean }` ; actions `setMotionIntensity`, `setShowIntro`, `load(): Promise<void>` (lit `app_state` clé `"settings"`, no-op hors fenêtre) ; persistance automatique (écrit à chaque changement) ; purs `serializeSettings(s): string`, `restoreSettings(raw: string): {motionIntensity, showIntro}` (assainit, défauts `full`/`true`, ne lève jamais).
  - `cdp-smoke.mjs` : option `--screenshot <file.png>` → après l'`expr` (ou sans), `Page.captureScreenshot` du target page, écrit le PNG, sortie JSON `{ok:true, screenshot:"<path>"}` ; `parseArgs` renvoie `screenshot`.
- Consumes: —

- [ ] **Step 1 : Tests** — `motion-tokens` : `motionFor("reduced", false)` → `enabled===false` et `d(0.3)===0` ; `motionFor("full", true)` → `enabled===false` ; `motionFor("subtle", false).d(0.3)` ≈ `0.18` (±0.001) ; `motionFor("full", false).d(0.3)===0.3`. `settings-store` : `restoreSettings('{"motionIntensity":"bogus","showIntro":"x"}')` → `{motionIntensity:"full", showIntro:true}` ; `restoreSettings("{bad")` → défauts ; aller-retour `restoreSettings(serializeSettings(s))` identique ; `setMotionIntensity("subtle")` met à jour l'état (sans `window`). `cdp-harness` : `parseArgs(["--screenshot","a.png"]).screenshot==="a.png"`.
- [ ] **Step 2 : Échec** — `npm run test -- motion-tokens settings-store cdp-harness`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** : installer et épingler exactement `framer-motion` (11.18.2 suggéré), `lucide-react` (0.468.0 suggéré), `@fontsource/shippori-mincho` et `@fontsource/zen-kaku-gothic-new` (dernière 5.x) ; créer les fichiers ci-dessus ; `main.tsx` importe `ds/base.css` + `ds/tokens.css` **avant** l'ancien `tokens.css` et enveloppe `<App/>` dans `<MotionConfig reducedMotion="user">` ; ajouter `--screenshot` au harnais.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite complète verte ; typecheck propre.
- [ ] **Step 5 : Vérif réelle** — `npm run dev` ; `npm run check:cdp -- --expr "(()=>({ok:getComputedStyle(document.body).backgroundColor==='rgb(0, 0, 0)' && document.fonts.check('16px \"Zen Kaku Gothic New\"')}))()" --screenshot design/screens/t1.png` → exit 0 ; ouvrir le PNG et confirmer fond noir + police appliquée.
- [ ] **Step 6 : Commit** — `feat(ds): design system foundations, motion tokens, settings store, CDP screenshots`.

---

### Task 2 : Extraction du runtime audio + store bibliothèque (aucun changement visuel)

**Files:**
- Create: `src/renderer/runtime/audioRuntime.ts`, `src/renderer/runtime/restore.ts`, `src/renderer/state/library.ts`
- Modify: `src/renderer/App.tsx`
- Test: `tests/library-store.test.ts`, `tests/audio-runtime.test.ts`

**Interfaces:**
- Produces:
  - `startAudioRuntime(deps?: { createContext?: (opts?: AudioContextOptions) => AudioContext; createDecoder?: (ctx: AudioContext) => Decoder; raf?: typeof requestAnimationFrame; caf?: typeof cancelAnimationFrame }): AudioRuntime` avec `interface AudioRuntime { engine: AudioEngine; controls: PlayerControls; dispose(): void }` — contient **exactement** la logique actuelle de l'effet d'`App.tsx` lignes 87-206 (liaison store, `attachEngine`, `rebuildForQuality`, pont dev, boucle rAF throttlée 66 ms, sauvegarde debouncée + throttle position) ; le pont dev expose en plus `library: libraryStore` et (Tâche 3) `ui: uiStore`.
  - `restorePlaybackState(engine: AudioEngine): Promise<void>` — logique actuelle `App.tsx` 226-274 (idempotente, en pause).
  - `state/library.ts` : store vanilla `libraryStore` + hook `useLibrary(sel)` ; état `{ tracks: TrackRow[]; albums: Album[]; loading: boolean; sources: SourceRow[]; scanning: boolean; scanMsg: string|null; query: string; results: TrackRow[]; searched: boolean }` ; actions `reload()`, `refreshSources()`, `scan(path: string)`, `pickFolderAndScan()`, `setQuery(q: string)` (anti-rebond 150 ms, réponse obsolète ignorée), `subscribeLibraryChanged(): () => void`.
- Consumes: `bindEngine`, `playerStore`, `createControls`, `groupTracksToAlbums`, `serializeState/restoreState` (existants).

- [ ] **Step 1 : Tests** — `library-store` (faux `window.benten`) : `reload()` pagine `library.query` par 1000 jusqu'à une page incomplète et remplit `tracks` + `albums` (groupés) ; `scan("/x")` appelle `library.scan(["/x"])` puis recharge et rafraîchit `sources` ; `setQuery("a")` puis `setQuery("ab")` en < 150 ms → **une seule** recherche, et une réponse tardive pour `"a"` n'écrase pas `"ab"` (faux timers). `audio-runtime` (fabriques injectées, `AudioContext`/`Decoder` simulés) : `startAudioRuntime()` crée **un seul** contexte ; `dispose()` annule la boucle rAF (le faux `caf` est appelé) et rend `playerStore.getState()` détaché du moteur ; pas de `window.__benten` hors dev.
- [ ] **Step 2 : Échec** — `npm run test -- library-store audio-runtime`. Expected: FAIL.
- [ ] **Step 3 : Implémenter** : **déplacer** (copier-coller puis supprimer d'App.tsx) le code existant dans `runtime/` sans changer sa logique ; `App.tsx` appelle `startAudioRuntime()` une fois (ref), `restorePlaybackState`, et lit tout depuis `useLibrary` — **le JSX et l'apparence restent identiques**.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite complète verte (aucun test existant modifié).
- [ ] **Step 5 : Vérif réelle (Review Focus)** — dev + une source scannée (un dossier d'album réel) : via le pont dev, lancer une file de 2 titres, `seek` à 6 s de la fin, vérifier la promotion gapless (`trackId` change, jamais `status:"loading"`) ; recharger la page → reprise **en pause** à la position. Nettoyer la source de test.
- [ ] **Step 6 : Commit** — `refactor: extract audio runtime + library store out of App (no behavior change)`.

---

### Task 3 : Shell, routeur, transitions, barre latérale, barre du haut

**Files:**
- Create: `src/renderer/state/ui.ts`, `src/renderer/shell/{Shell,Sidebar,TopBar,RouteView}.tsx`, `src/renderer/shell/shell.css`, `src/renderer/ui/{Button,IconButton,Skeleton,BentenMark}.tsx`, `src/renderer/ui/ui.css`
- Modify: `src/renderer/App.tsx`, `src/renderer/runtime/audioRuntime.ts` (pont dev `ui`)
- Test: `tests/ui-router.test.ts`

**Interfaces:**
- Produces:
  - `type Route = {name:"home"} | {name:"tracks"} | {name:"albums"} | {name:"album"; id:number} | {name:"artists"} | {name:"artist"; name:string} | {name:"playlists"} | {name:"playlist"; id:number} | {name:"favorites"} | {name:"search"; q:string} | {name:"downloads"} | {name:"settings"}`.
  - `uiStore` / `useUi(sel)` : `{ route: Route; past: Route[]; future: Route[]; compact: boolean; shortcutsHelpOpen: boolean }` ; `navigate(r: Route)` (pousse `route` dans `past`, vide `future`, ignore une route identique), `back()`, `forward()`, `canBack()`, `canForward()`, `setCompact(on)`, `setShortcutsHelpOpen(on)` ; pur `sameRoute(a,b): boolean`.
  - `<Shell>` : grille barre latérale 248 px / contenu / barre de lecteur 88 px ; `<RouteView>` rend la vue de la route avec `AnimatePresence` (fondu + glissé 8 px, durées via `motionFor`).
  - `<Sidebar>` : mark Benten, entrées Accueil, Titres, Albums, Artistes, Playlists, Favoris, Téléchargements, Réglages (icônes lucide), **indicateur actif animé** (`layoutId`), section « Playlists » (liste, cible de dépôt Tâche 9).
  - `<TopBar>` : précédent/suivant (désactivés selon l'historique), champ de recherche (focus → route `search`), emplacement d'actions.
  - `<Button variant="primary"|"ghost"|"subtle">`, `<IconButton label icon>` : ressort au survol/clic (`whileHover` scale 1.03, `whileTap` 0.96), primaire = `--grad-btn` + reflet + ombre ; `<Skeleton w h radius>` shimmer.
- Consumes: Tâche 1 (DS, `motionFor`, `useSettings`), Tâche 2 (`useLibrary`, runtime).

- [ ] **Step 1 : Test** — `ui-router` : `navigate(albums)` puis `navigate(album 3)` → `past=[home,albums]`, `route=album 3` ; `back()` → `route=albums`, `future=[album 3]` ; `navigate(artists)` vide `future` ; `navigate` vers la route courante ne pousse rien ; `canBack()` faux au départ.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** le store et le shell ; **mapper temporairement** les anciennes vues : `home`/`albums`/`favorites` → ancienne grille (`LibraryGrid` + `SortFilterBar`), `playlists` → `Playlists`, `search` → `SearchResults` ; les autres routes → état vide propre (« bientôt » interdit : texte neutre « En construction » tant que la tâche correspondante n'est pas faite). L'onboarding existant (état vide + scan) reste accessible sur `home` quand la bibliothèque est vide.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — dev : captures `--screenshot` de `home` et `playlists` (navigation via `window.__benten.ui.getState().navigate(...)`) ; vérifier barre latérale, indicateur actif, transition (capture à mi-transition facultative).
- [ ] **Step 6 : Commit** — `feat(shell): app shell, router with animated transitions, sidebar, top bar`.

---

### Task 4 : Primitives d'interaction (menus contextuels, toasts, glisser-déposer, raccourcis, touches média)

**Files:**
- Create: `src/renderer/ui/ContextMenu.tsx`, `src/renderer/ui/Toast.tsx`, `src/renderer/ui/ShortcutsHelp.tsx`, `src/renderer/lib/dnd.ts`, `src/renderer/lib/shortcuts.ts`, `src/renderer/runtime/mediaSession.ts`
- Modify: `src/renderer/shell/Shell.tsx`, `src/renderer/runtime/audioRuntime.ts`
- Test: `tests/shortcuts.test.ts`, `tests/dnd.test.ts`, `tests/toast-store.test.ts`, `tests/media-session.test.ts`

**Interfaces:**
- Produces:
  - `ContextMenu` : store `menuStore` ; `openMenu(x: number, y: number, items: MenuItem[])`, `closeMenu()` ; `type MenuItem = { label: string; icon?: LucideIcon; onSelect?: () => void; danger?: boolean; submenu?: MenuItem[]; disabled?: boolean } | "separator"` ; repositionné pour rester dans la fenêtre ; ↑/↓/Entrée/Échap ; animation d'ouverture depuis le point de clic.
  - `Toast` : `toast(message: string, opts?: { icon?: LucideIcon; action?: { label: string; onClick: () => void }; durationMs?: number })` (défaut 2600 ms), pile animée en bas à droite, max 3.
  - `dnd.ts` : `const BENTEN_TRACKS_MIME = "application/x-benten-tracks"`; `setDragTracks(dt: DataTransfer, trackIds: readonly number[]): void`; `readDragTracks(dt: DataTransfer): number[] | null` (null si absent/invalide).
  - `shortcuts.ts` : `type Action = "toggle" | "next" | "prev" | "seekFwd" | "seekBack" | "search" | "favorite" | "close" | "help" | "settings"`; `const KEYMAP: Record<Action, string>` = `{toggle:"Space", next:"Ctrl+ArrowRight", prev:"Ctrl+ArrowLeft", seekFwd:"Shift+ArrowRight", seekBack:"Shift+ArrowLeft", search:"Ctrl+KeyF", favorite:"Ctrl+KeyL", close:"Escape", help:"Shift+Slash", settings:"Ctrl+Comma"}`; `matchShortcut(e: {code:string; ctrlKey:boolean; shiftKey:boolean; altKey:boolean; metaKey:boolean; target: {tagName?:string; isContentEditable?:boolean} | null}): Action | null` — **renvoie `null` si la cible est un champ de saisie (`INPUT`, `TEXTAREA`, `SELECT`, contentEditable) sauf pour `close`** ; `useGlobalShortcuts(handlers: Partial<Record<Action, () => void>>)`.
  - `mediaSession.ts` : `bindMediaSession(store: PlayerStore, controls: PlayerControls, ms?: MediaSession): () => void` — met à jour `metadata` (titre, artiste, album, `artwork` = URL `benten-art://` 512) à chaque changement de piste, `playbackState`, gestionnaires `play/pause/previoustrack/nexttrack/seekto` → `controls` ; renvoie le désabonnement.
- Consumes: Tâches 2-3.

- [ ] **Step 1 : Tests** — `shortcuts` : Espace hors champ → `"toggle"` ; **Espace avec `target.tagName="INPUT"` → `null` (Review Focus)** ; `Escape` dans un INPUT → `"close"` ; `Ctrl+KeyF` → `"search"` ; `Shift+Slash` → `"help"` ; touche inconnue → `null`. `dnd` : aller-retour `setDragTracks`/`readDragTracks` = `[3,7]` ; MIME étranger → `null` ; JSON corrompu → `null`. `toast-store` (faux timers) : 4 toasts → 3 visibles ; disparition après 2600 ms. `media-session` (faux `MediaSession`) : changement de `currentTrack` → `metadata.title` mis à jour ; déclencher `nexttrack` appelle `controls.next` ; le désabonnement retire les gestionnaires.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** ; le `Shell` monte les hôtes (menu, toasts, aide des raccourcis) et `useGlobalShortcuts` câblé sur `controls`/store/routeur ; le runtime appelle `bindMediaSession` et le libère au `dispose`.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — dev : ouvrir un menu contextuel (événement `contextmenu` synthétique), capture ; afficher un toast, capture ; vérifier `navigator.mediaSession.metadata.title` après avoir lancé un titre.
- [ ] **Step 6 : Commit** — `feat(ui): context menus, toasts, drag&drop, keyboard shortcuts, media keys`.

---

### Task 5 : Couleurs dynamiques des pochettes

**Files:**
- Create: `src/renderer/lib/palette.ts`, `src/renderer/lib/useCoverColors.ts`
- Test: `tests/palette.test.ts`

**Interfaces:**
- Produces:
  - `type RGB = [number, number, number]` ; `extractPalette(rgba: Uint8ClampedArray, width: number, height: number): { dominant: RGB; vibrant: RGB }` — ignore les pixels presque noirs (luma < 18) et presque blancs (luma > 245) quand il en reste ; quantification en boîtes 4 bits/canal, dominante = boîte la plus peuplée, vive = boîte maximisant saturation × population ; repli `[231,60,130]` si tout est ignoré.
  - `readableOnBlack(rgb: RGB): RGB` — remonte la luminosité (HSL) jusqu'à un contraste ≥ 4.5:1 sur `#000`.
  - `toCss(rgb: RGB, alpha?: number): string`.
  - `useCoverColors(artKey: string | null, fallbackKey: string): { dominant: string; vibrant: string; accent: string }` — charge `artUrl(artKey, 64)` dans une `Image`, échantillonne 32×32 sur canvas, cache **LRU 512** par `artKey` ; sans pochette → `generativeCover(fallbackKey).accent`.
- Consumes: `artUrl`, `generativeCover` (existants).

- [ ] **Step 1 : Test** — image unie rouge `[220,30,40]` → `dominant` à ±16 près ; moitié noire / moitié bleue → `vibrant` bleu (le noir est ignoré) ; image toute noire → repli magenta ; `readableOnBlack([20,20,60])` donne un contraste ≥ 4.5 (fonction de contraste WCAG recalculée dans le test) ; deux appels identiques → même résultat (déterminisme).
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** les fonctions pures et le hook (aucune extraction tant que le composant n'est pas monté → seules les pochettes visibles sont traitées, Review Focus).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Commit** — `feat(color): cover palette extraction + useCoverColors`.

---

### Task 6 : Grille Albums + page Album

**Files:**
- Create: `src/renderer/views/AlbumsView.tsx`, `src/renderer/views/AlbumView.tsx`, `src/renderer/ui/AlbumTile.tsx`, `src/renderer/ui/TrackRowItem.tsx`, `src/renderer/ui/tiles.css`, `src/renderer/views/views.css`, `src/renderer/lib/viewModels.ts`
- Modify: `src/renderer/shell/RouteView.tsx` (routes `albums`, `album`, `favorites`), suppression de `LibraryGrid.tsx`, `AlbumCard.tsx`, `SortFilterBar.tsx` (et leurs styles) si plus utilisés
- Test: `tests/view-models.test.ts`

**Interfaces:**
- Produces:
  - `viewModels.ts` : `albumSummary(album: Album): { trackCount: number; totalSec: number; quality: string }` (qualité = la plus haute de l'album via `describeQuality`) ; `discGroups(tracks: readonly TrackRow[]): { disc: number | null; tracks: TrackRow[] }[]` (ordre préservé, un seul groupe si pas de `discNo`) ; `formatTotal(sec): string` (« 42 min », « 1 h 05 »).
  - `<AlbumTile album playing onPlay>` : pochette en fondu (blur-up), survol (soulèvement 6 px + zoom 1.05 + bouton play qui monte), équaliseur si l'album joue, clic droit → menu (Lire, Lire ensuite, Ajouter à la file, Ajouter à une playlist ▸, Aller à l'artiste), `draggable` (pistes de l'album), `layoutId={"cover-album-"+id}`.
  - `<TrackRowItem track index playing selected onPlay onContextMenu draggable>` : n°/équaliseur, titre, artiste (lien), album (lien), ♥ (bascule `toggleFavorite`), durée ; survol → bouton play.
  - `<AlbumsView>` : grille virtualisée (`@tanstack/react-virtual`, colonnes selon largeur), tri (Titre / Artiste / Ajouté) via un sélecteur compact ; favoris = même vue filtrée.
  - `<AlbumView id>` : en-tête (pochette 232 px avec `layoutId`, titre en mincho, artiste cliquable, « 12 titres · 42 min · FLAC 24/44,1 »), **dégradé à la couleur `vibrant`** de la pochette sur noir, boutons Lecture (primaire) / Aléatoire / ⋯ ; en-tête compacte au défilement ; liste par disque (`discGroups`).
- Consumes: Tâches 3-5, `useLibrary`, `controls.playAlbum`, `playerStore` (actions existantes).

- [ ] **Step 1 : Test** — `albumSummary` sur 3 pistes (180 s, 200 s, 220 s ; une en FLAC 16/44100, deux en FLAC 24/44100) → `trackCount:3`, `totalSec:600`, `quality` égal à la sortie de `describeQuality` pour la piste **24 bit** (la plus haute) ; `discGroups` sur disques [1,1,2] → 2 groupes ; sans `discNo` → 1 groupe `disc:null` ; `formatTotal(600)==="10 min"`, `formatTotal(3900)==="1 h 05"`.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** les vues et briques ; supprimer les anciens composants remplacés.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — dev (bibliothèque réelle) : captures de la grille Albums, d'une page Album (couleur dynamique visible), et d'une page multi-disques si disponible ; défilement de la grille sans à-coups (virtualisation : le DOM contient < 120 tuiles).
- [ ] **Step 6 : Commit** — `feat(views): albums grid + album page with dynamic color and shared-element cover`.

---

### Task 7 : Vue Titres (tous les titres, ordre d'ajout)

**Files:**
- Create: `src/renderer/views/TracksView.tsx`
- Modify: `src/renderer/lib/viewModels.ts`, `src/renderer/shell/RouteView.tsx`
- Test: `tests/view-models.test.ts` (ajouts)

**Interfaces:**
- Produces:
  - `type TrackSortKey = "added" | "title" | "artist" | "album" | "duration"`; `sortTracks(tracks: readonly TrackRow[], key: TrackSortKey, dir: "asc" | "desc"): TrackRow[]` — `"added"` trie par `id` (ordre d'indexation = ordre d'ajout), textes en `localeCompare(..., "fr", {sensitivity:"base"})`, départage stable par `id`.
  - `selectionAfterClick(sel: ReadonlySet<number>, index: number, mods: {shift: boolean; ctrl: boolean}, anchor: number | null): { sel: Set<number>; anchor: number }` — clic simple = sélection unique ; Ctrl = bascule ; Maj = plage depuis l'ancre.
  - `<TracksView>` : en-têtes de colonnes cliquables (tri, flèche animée), défaut **« Ajouté », du plus ancien au plus récent** (comme la playlist Apple de l'utilisateur) avec bascule ; liste virtualisée de `TrackRowItem` ; double-clic = lire la liste triée à partir de ce titre ; multi-sélection ; menu contextuel sur la sélection (Lire, Lire ensuite, Ajouter à la file, Ajouter à une playlist ▸, ♥) ; glisser la sélection.
- Consumes: Tâches 4, 6.

- [ ] **Step 1 : Test** — `sortTracks` : `"added"/"asc"` → ids croissants ; `"title"/"asc"` avec « Éclat », « eau », « Zèbre » → ordre `eau, Éclat, Zèbre` ; égalité → départage par id ; `selectionAfterClick` : clic 2 → `{2}` ancre 2 ; Maj+clic 5 → `{2,3,4,5}` ; Ctrl+clic 3 → retire 3.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** la vue (lecture via le chemin existant `controls.playAlbum` sur un album éphémère, comme `playTracks` actuel).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle (Review Focus)** — dev : capture de la vue Titres (969 titres) ; le DOM contient < 80 lignes rendues ; double-clic lance la lecture.
- [ ] **Step 6 : Commit** — `feat(views): tracks view (all titles, date-added order, multi-select)`.

---

### Task 8 : Artistes + page Artiste

**Files:**
- Create: `src/renderer/views/ArtistsView.tsx`, `src/renderer/views/ArtistView.tsx`
- Modify: `src/renderer/lib/viewModels.ts`, `src/renderer/shell/RouteView.tsx`
- Test: `tests/view-models.test.ts` (ajouts)

**Interfaces:**
- Produces:
  - `groupArtists(albums: readonly Album[]): { name: string; albums: Album[]; trackCount: number; artKey: string | null }[]` — clé = `album.artist.trim().toLocaleLowerCase("fr")` (insensible à la casse), `name` = première graphie rencontrée, tri `localeCompare` fr base, `artKey` = première pochette disponible.
  - `<ArtistsView>` : grille virtualisée d'avatars ronds (pochette), nom, « n albums ».
  - `<ArtistView name>` : en-tête teinté (couleur de la première pochette), Lecture / Aléatoire de tout l'artiste, rangée « Albums » (AlbumTile), liste « Titres » (TrackRowItem).
- Consumes: Tâches 5-7.

- [ ] **Step 1 : Test** — `groupArtists` sur albums de « Ridsa » (2 titres), « ridsa » (1 titre), « Various Artists » (compilation, 3 titres) → **2 groupes** triés (`Ridsa` avec `trackCount:3`, `Various Artists` avec 3) ; `artKey` = première pochette non nulle.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle** — captures Artistes + une page Artiste.
- [ ] **Step 6 : Commit** — `feat(views): artists grid + artist page`.

---

### Task 9 : Playlists + page Playlist + page Recherche

**Files:**
- Create: `src/renderer/views/PlaylistsView.tsx`, `src/renderer/views/PlaylistView.tsx`, `src/renderer/views/SearchView.tsx`, `src/renderer/ui/Dialog.tsx`, `src/renderer/ui/PlaylistMosaic.tsx`
- Modify: `src/renderer/shell/Sidebar.tsx` (liste des playlists = cibles de dépôt), `src/renderer/lib/viewModels.ts`, `src/renderer/shell/RouteView.tsx` ; suppression de `Playlists.tsx`, `SearchResults.tsx`, `AddToPlaylistSheet.tsx` (le sous-menu « Ajouter à une playlist ▸ » + « Nouvelle playlist… » les remplace)
- Test: `tests/view-models.test.ts` (ajouts)

**Interfaces:**
- Produces:
  - `mosaicArtKeys(tracks: readonly TrackRow[]): string[]` — jusqu'à 4 `artKey` **distincts** dans l'ordre.
  - `buildSearchSections(q: string, tracks: readonly TrackRow[], playlists: readonly PlaylistRow[]): { top: {kind:"track"|"album"|"artist"; id: string} | null; tracks: TrackRow[]; albums: Album[]; artists: string[]; playlists: PlaylistRow[] }` — meilleur résultat : correspondance exacte (normalisée sans accents/casse) titre > artiste > album, sinon premier titre ; playlists filtrées par nom.
  - `<Dialog open title onClose actions>` accessible (piège à focus `lib/focusTrap`, Échap), remplace `window.confirm`.
  - `<PlaylistsView>` : grille (mosaïque 2×2, nom, « n titres »), tuile « Nouvelle playlist ».
  - `<PlaylistView id>` : en-tête mosaïque + couleur dynamique, renommer **en place**, réordonner au glisser (→ `playlists.reorder`), retirer, Lecture/Aléatoire, supprimer (Dialog).
  - Barre latérale : déposer des titres sur une playlist → `playlists.add` + toast « Ajouté à … ».
  - `<SearchView q>` : sections (meilleur résultat en grande carte, titres, albums, artistes, playlists), squelettes pendant la recherche, état « aucun résultat » seulement après réponse (`searched`).
- Consumes: Tâches 4-8, `window.benten.playlists.*`.

- [ ] **Step 1 : Test** — `mosaicArtKeys` (a,a,b,null,c,d,e) → `[a,b,c,d]` ; `buildSearchSections("pardon", …)` → `top` = le titre « Pardon » ; recherche « ridsa » → `top` artiste ; playlists filtrées par nom (insensible accents/casse).
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** ; supprimer les anciens composants remplacés.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — créer une playlist de test, y glisser 3 titres, réordonner, capture ; recherche « montagem » capture ; supprimer la playlist de test (base propre).
- [ ] **Step 6 : Commit** — `feat(views): playlists, playlist page, search page, dialog`.

---

### Task 10 : Barre de lecteur, écran de lecture, file d'attente

**Files:**
- Create: `src/renderer/player/PlayerBar.tsx`, `src/renderer/player/NowPlayingView.tsx`, `src/renderer/player/QueuePanel.tsx`, `src/renderer/player/player.css`
- Modify: `src/renderer/shell/Shell.tsx`, `src/renderer/lib/viewModels.ts` ; suppression de `components/MiniPlayer.tsx`, `components/NowPlaying.tsx`, `components/QueuePanel.tsx` ; `QualitySheet` restylé en popover depuis le badge qualité
- Test: `tests/view-models.test.ts` (ajouts)

**Interfaces:**
- Produces:
  - `fractionFromPointer(clientX: number, rect: {left: number; width: number}): number` (borné [0,1]) ; `nextVolumeOnMute(current: number, remembered: number): { volume: number; remembered: number }` (couper mémorise, rétablir restaure, défaut 0.8).
  - `<PlayerBar>` : pochette (`layoutId="cover-now"`) cliquable → écran de lecture, titre/artiste (liens), ♥, contrôles à ressort (aléatoire, préc., play/pause morphé, suiv., répétition 3 états), barre de progression (survol = info-bulle du temps, glisser = seek), volume + muet, bouton file, badge qualité (popover), emplacements minuteur (Tâche 17) et mode compact (Tâche 17).
  - `<NowPlayingView>` (calque plein écran) : fond noir + **halo à la couleur de la pochette** + pochette floutée très atténuée, grande pochette qui « respire », titre en mincho, contrôles, progression, panneau « À suivre » repliable ; ouverture/fermeture animées (pochette partagée), Échap ferme.
  - `<QueuePanel>` (tiroir droit) : à suivre / déjà joués, réordonner au glisser (`moveInQueue`), retirer, sauter.
- Consumes: `PlayerControls`, `playerStore`, Tâches 4-5. **Aucune modification du moteur.**

- [ ] **Step 1 : Test** — `fractionFromPointer(150,{left:100,width:200})===0.25` ; hors borne → 0 ou 1 ; `nextVolumeOnMute(0.6, 0.8)` → `{volume:0, remembered:0.6}` ; `nextVolumeOnMute(0, 0.6)` → `{volume:0.6, remembered:0.6}` ; `nextVolumeOnMute(0, 0)` → `{volume:0.8, …}`.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** ; supprimer les anciens composants.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte (les tests du moteur et du store lecteur inchangés et verts).
- [ ] **Step 5 : Vérif réelle** — lancer un titre réel : captures barre de lecteur, écran de lecture (halo coloré), file ouverte ; vérifier via le pont dev qu'il n'y a qu'**un** `AudioContext` et que la lecture continue pendant l'ouverture/fermeture de l'écran de lecture.
- [ ] **Step 6 : Commit** — `feat(player): player bar, now playing, queue panel redesign`.

---

### Task 11 : Accueil + historique d'écoute (schéma v3)

**Files:**
- Modify: `src/main/library/db.ts` (migration v3), `src/main/library/repository.ts`, `src/main/ipc.ts`, `src/shared/{types,channels}.ts`, `src/preload/index.ts`
- Create: `src/renderer/runtime/playHistory.ts`, `src/renderer/views/HomeView.tsx`
- Test: `tests/migration.test.ts` (ajout), `tests/repository.test.ts` (ajout), `tests/play-history.test.ts`, `tests/ipc.test.ts` (ajout)

**Interfaces:**
- Produces:
  - Migration v3 : `CREATE TABLE play_history(id INTEGER PRIMARY KEY, track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, played_at INTEGER NOT NULL); CREATE INDEX idx_history_played ON play_history(played_at);`
  - Repository : `recordPlay(db, trackId: number, at: number): void`, `recentlyPlayed(db, limit: number): TrackRow[]` (titres **distincts**, du plus récent), `recentAlbums(db, limit: number): AlbumRow[]` (par `albums.created_at` décroissant).
  - IPC/API : `window.benten.history.record(trackId)`, `window.benten.history.recent(limit)`, `window.benten.library.recentAlbums(limit)` (gardés, validés).
  - `shouldCountPlay(positionSec: number, durationSec: number): boolean` — vrai si `positionSec ≥ 30` ou `positionSec ≥ durationSec/2` ; `bindPlayHistory(store: PlayerStore, record: (id:number)=>void): () => void` — enregistre **une fois** par lecture d'un titre (réarmé au changement de titre).
  - `<HomeView>` : salutation selon l'heure (« Bonjour » 5-17 h, « Bonsoir » 17-22 h, « Bonne nuit » sinon) + sous-titre japonais (今宵 / 今日), en-tête teinté par la couleur du titre en cours ou du dernier joué ; rangées défilantes (accrochage + flèches) : Écoutés récemment, Ajoutés récemment, Tes playlists, Favoris ; état vide → onboarding (Tâche 12).
- Consumes: Tâches 3-6, 9.

- [ ] **Step 1 : Tests** — migration v2→v3 sur base peuplée : données conservées, `user_version===3`, cascade de `play_history` à la suppression d'un titre ; `recentlyPlayed` après plays A(t1), B(t2), A(t3) → `[A, B]` ; `shouldCountPlay(29, 300)===false`, `(30,300)===true`, `(50,90)===true` ; `bindPlayHistory` : un titre qui dépasse 30 s enregistre 1 fois même si `setPosition` continue ; changement de titre réarme ; IPC `history.record` refuse un id non entier.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — migration sur une **copie** de la base réelle (`%APPDATA%\benten\benten.db`) : nombre de titres inchangé ; capture de l'Accueil.
- [ ] **Step 6 : Commit** — `feat(home): home screen + play history (schema v3)`.

---

### Task 12 : Réglages + premier lancement + gestion des sources

**Files:**
- Create: `src/renderer/views/SettingsView.tsx`, `src/renderer/views/Onboarding.tsx`
- Modify: `src/main/ipc.ts` (progression du scan poussée), `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/state/library.ts`
- Test: `tests/ipc.test.ts` (ajout), `tests/library-store.test.ts` (ajout)

**Interfaces:**
- Produces:
  - Canal push `library:scan-progress` (`ScanSummary` à chaque lot, via `event.sender.send`) ; `window.benten.onScanProgress(cb: (p: ScanSummary) => void): () => void`.
  - `libraryStore` : `scanProgress: ScanSummary | null` mis à jour pendant `scan()`, remis à `null` à la fin.
  - `<SettingsView>` : sections **Bibliothèque** (sources : ajouter (sélecteur), retirer (Dialog), re-scanner avec progression), **Lecture & qualité** (mode qualité, sortie, volume), **Apparence & mouvement** (intensité `full/subtle/reduced`, « Afficher l'intro au lancement »), **YouTube** (emplacement réservé, câblé Tâche 15), **À propos** (version, « 100 % local »).
  - `<Onboarding>` : affiché sur `home` quand aucune piste : logo animé, « Choisir mon dossier de musique », scan **animé** (compteurs analysés/ajoutés qui défilent, barre), puis entrée dans l'Accueil.
- Consumes: Tâches 1-3, 11.

- [ ] **Step 1 : Tests** — `ipc` : le handler `library:scan` envoie ≥ 1 message `library:scan-progress` au `sender` (faux sender) avant de résoudre ; `library-store` : `scanProgress` passe de `null` → valeurs → `null`.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle** — captures Réglages et Onboarding (l'onboarding s'affiche quand `tracks.length===0` **ou** quand le champ dev-only `uiStore.forceOnboarding` vaut `true` — champ ajouté dans cette tâche, uniquement posé via le pont dev, ignoré sinon) ; changer l'intensité → les transitions se raccourcissent/s'annulent.
- [ ] **Step 6 : Commit** — `feat(settings): settings view, onboarding with animated scan, sources management`.

---

### Task 13 : Logo + icône d'application

**Files:**
- Create: `design/logo/benten-logo.svg`, `src/renderer/ui/BentenLogo.tsx`, `scripts/make-icon.mjs`
- Modify: `src/renderer/ui/BentenMark.tsx` (utilise le logo), `src/renderer/index.html` (favicon), `package.json` (script `icon`), `build/icon.ico` (régénéré)
- Test: `tests/logo.test.ts`

**Interfaces:**
- Produces:
  - `benten-logo.svg` : soleil magenta `#e73c82` + torii blanc **affiné** (mêmes proportions que l'intro v2 : piliers fins, kasagi qui dépasse **aux extrémités légèrement relevées**, shimagi, nuki) sur fond transparent ; variante carrée sur fond `#000` pour l'icône.
  - `<BentenLogo size withWordmark? animated?>` : SVG inline ; `animated` = soleil qui monte + torii qui se révèle (framer-motion, respecte `motionFor`).
  - `scripts/make-icon.mjs` : rasterise la variante carrée en PNG 16/24/32/48/64/128/256 (`@resvg/resvg-js`) et assemble `build/icon.ico` (`png-to-ico`) ; `npm run icon`.
- Consumes: Tâche 1.

- [ ] **Step 1 : Test** — le SVG contient un `circle` de couleur `#e73c82` et ≥ 5 éléments de torii ; après `npm run icon`, l'en-tête ICO de `build/icon.ico` déclare 7 images de tailles `[16,24,32,48,64,128,256]` (lecture binaire de l'en-tête `ICONDIR`).
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter** (épingler `@resvg/resvg-js` 2.6.2 et `png-to-ico` 2.1.8 en dev, vérifier l'installation).
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle** — capture de la barre latérale avec le nouveau logo ; ouvrir le PNG 256 généré.
- [ ] **Step 6 : Commit** — `feat(brand): Benten logo (torii + sun), animated mark, app icon`.

---

### Task 14 : Intro de lancement

> **14A est faite par le contrôleur dans After Effects** (pas par un sous-agent) : affiner `design/motion/benten-intro.aep` (kasagi aux extrémités relevées en chemin bézier, timing), rendre `design/motion/benten-intro-final.mp4` (H.264, 2560×1440, 30 fps, ~3,5 s, ≥ 30 Mb/s), sauvegarder le `.aep`. 14B intègre la vidéo.

**Files (14B):**
- Create: `src/renderer/shell/IntroSplash.tsx`, `src/renderer/assets/intro.mp4` (copie de `design/motion/benten-intro-final.mp4`)
- Modify: `src/renderer/App.tsx`, `src/renderer/lib/viewModels.ts`
- Test: `tests/view-models.test.ts` (ajout)

**Interfaces:**
- Produces:
  - `shouldShowIntro(s: { showIntro: boolean; motionIntensity: MotionIntensity }, prefersReduced: boolean): boolean` — faux si `showIntro` faux, si `reduced`, ou si `prefersReduced`.
  - `<IntroSplash onDone>` : vidéo plein écran sur noir (`object-fit: contain`), lecture muette auto, **passable** (clic, Échap, toute touche, bouton « Passer »), fondu de sortie 500 ms vers l'app (déjà montée derrière), une seule fois par lancement ; garde-fou : `onDone` après 6 s si la vidéo ne démarre pas.
- Consumes: Tâches 1, 3.

- [ ] **Step 1 : Test** — table de vérité de `shouldShowIntro` (4 cas).
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS.
- [ ] **Step 5 : Vérif réelle** — dev : captures à 0,5 s / 2 s / après fondu ; « Passer » saute à l'app ; avec l'intensité `reduced`, aucune intro.
- [ ] **Step 6 : Commit** — `feat(intro): After Effects launch intro (skippable, respects reduced motion)`.

---

### Task 15 : YouTube → MP3

**Files:**
- Create: `src/main/youtube/ytdlp.ts`, `src/main/youtube/download.ts`, `src/main/youtube/manager.ts`, `src/renderer/views/DownloadsView.tsx`
- Modify: `src/main/ipc.ts`, `src/main/index.ts`, `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/main/library/indexer.ts` (export `indexOne` déjà présent — réutilisé), `electron-builder.yml` (`asarUnpack` de `ffmpeg-static`), `package.json` (`ffmpeg-static` épinglé, 5.2.0 suggéré), `src/renderer/views/SettingsView.tsx` (section YouTube)
- Test: `tests/youtube-download.test.ts`, `tests/ytdlp.test.ts`

**Interfaces:**
- Produces:
  - `validateYoutubeUrl(raw: string): string | null` — accepte uniquement `https://` sur `www.youtube.com|youtube.com|m.youtube.com|music.youtube.com` (`/watch?v=<11 car.>`, `/shorts/<id>`) et `youtu.be/<id>` ; renvoie l'URL **canonique** `https://www.youtube.com/watch?v=<id>` ; tout le reste → `null` (autres hôtes, `file:`, `http:`, identifiant invalide, espaces, `;`, présence de `--`).
  - `buildYtDlpArgs(url: string, outDir: string, ffmpegPath: string): string[]` = `["-x","--audio-format","mp3","--audio-quality","0","--embed-thumbnail","--add-metadata","--no-playlist","--newline","--ffmpeg-location", ffmpegPath, "-o", join(outDir, "%(artist,uploader)s - %(title)s.%(ext)s"), url]`.
  - `parseProgress(line: string): { percent: number; stage: "download" | "convert" } | null` (`[download]  42.3% …` → 42.3 ; `[ExtractAudio]` → `convert`).
  - `ensureYtDlp(binDir: string, fetchImpl: typeof fetch): Promise<string>` — télécharge `yt-dlp.exe` de la dernière release GitHub (`https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`) et `SHA2-256SUMS`, vérifie l'empreinte, **supprime et rejette** en cas de non-correspondance ; renvoie le chemin ; réutilise un binaire présent.
  - `manager.ts` : `enqueue(url: string, playlistId: number | null): Job` ; états `queued | downloading | converting | done | error` ; à la fin : `indexOne` du fichier produit puis `playlists.add` si `playlistId`. Dossier de sortie `app.getPath("music")\Benten\YouTube` créé et **ajouté comme source** (veille redémarrée).
  - IPC : `youtube:enqueue(url, playlistId|null)`, `youtube:jobs()`, `youtube:status()` (`{installed, version}`), `youtube:update()` ; push `youtube:progress` (job). Lancement via `spawn(ytdlpPath, args, { shell: false })`.
  - `<DownloadsView>` : champ « Coller un lien YouTube » (validation en direct), choix de playlist, liste des tâches animée (progression, étape, erreur lisible), « Ouvrir le dossier ». Entrée barre latérale + coller rapide dans la barre du haut.
- Consumes: Tâches 3-4, 9, 12 ; `addSource`, `indexOne`, `addToPlaylist` (existants).

- [ ] **Step 1 : Tests** — `validateYoutubeUrl` : `https://youtu.be/dQw4w9WgXcQ` et `https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x` → URL canonique ; **rejets (Review Focus)** : `file:///C:/x`, `https://evil.com/watch?v=dQw4w9WgXcQ`, `https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ`, `http://youtu.be/dQw4w9WgXcQ`, `https://youtu.be/abc`, `https://youtu.be/dQw4w9WgXcQ --exec calc`, `https://youtu.be/dQw4w9WgXcQ;calc`. `buildYtDlpArgs` égal au tableau exact ci-dessus. `parseProgress` sur 3 lignes réelles. `ensureYtDlp` (faux fetch) : empreinte correcte → fichier écrit ; empreinte fausse → rejet et fichier absent ; binaire existant → aucun téléchargement.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — dev : télécharger un court extrait **libre de droits** fourni par le contrôleur ; le MP3 apparaît dans `Musique\Benten\YouTube`, est indexé (veille) et ajouté à une playlist de test ; capture de l'écran Téléchargements ; supprimer ensuite le fichier et la playlist de test **créés par le test** (jamais un fichier de l'utilisateur).
- [ ] **Step 6 : Commit** — `feat(youtube): YouTube to MP3 downloader (yt-dlp + ffmpeg) with downloads view`.

---

### Task 16 : Import de playlist Apple Music

**Files:**
- Create: `src/main/importer/applePlaylist.ts`, `src/main/importer/matcher.ts`, `src/renderer/views/ImportPlaylistDialog.tsx`, `tests/fixtures/import/` (export `.txt` UTF-16LE à en-têtes FR, `.m3u8`, `.xml`)
- Modify: `src/main/ipc.ts` (`import:preview`, `import:commit`, `dialog:pick-file`), `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/views/PlaylistsView.tsx` (bouton « Importer une playlist »)
- Test: `tests/apple-import.test.ts`, `tests/matcher.test.ts`

**Interfaces:**
- Produces:
  - `type ImportedTrack = { title: string; artist: string; album?: string; durationSec?: number; dateAdded?: number }`.
  - `parseAppleTxt(buf: Buffer): ImportedTrack[]` — détecte BOM UTF-16LE / UTF-8, colonnes par **nom d'en-tête** EN ou FR (`Name|Nom`, `Artist|Artiste`, `Album`, `Time|Durée` (secondes), `Date Added|Date d'ajout`), ordre du fichier conservé.
  - `parseM3u(text: string): ImportedTrack[]` (`#EXTINF:<sec>,<Artiste> - <Titre>`), `parseApplePlist(xml: string): ImportedTrack[]` (ordre de `Playlist Items`).
  - `parseImportFile(name: string, buf: Buffer): ImportedTrack[]` (selon l'extension).
  - `normalizeKey(s: string): string` — minuscules, sans accents, sans ponctuation, sans `feat./ft.`, sans mentions entre parenthèses/crochets (`(Slowed)`, `[Remastered]`…), espaces réduits.
  - `matchTracks(imported: readonly ImportedTrack[], library: readonly TrackRow[]): { imported: ImportedTrack; track: TrackRow | null; score: number }[]` — exact sur `normalizeKey(titre)+artiste` d'abord, sinon similarité (Dice sur bigrammes) titre ≥ 0.82 avec artiste ≥ 0.6, départage par écart de durée ; ordre d'entrée conservé.
  - IPC `import:preview(path)` → `{ items: {title, artist, matchedTrackId|null, score}[] }` ; `import:commit({ name, trackIds, sortByDateAdded })` → `{ playlistId }`.
  - `<ImportPlaylistDialog>` : choisir le fichier → aperçu (trouvés / non trouvés, compteurs), option « trier par date d'ajout », nom de playlist → créer → navigation vers la playlist + toast.
- Consumes: Tâches 4, 9.

- [ ] **Step 1 : Tests (Review Focus)** — `parseAppleTxt` sur le fixture UTF-16LE à en-têtes **français** → 4 titres dans l'ordre, accents intacts, durées en secondes ; fichier UTF-8 à en-têtes anglais → même résultat ; `parseM3u` et `parseApplePlist` → ordre conservé ; `normalizeKey("Montagem Aghanim (Slowed) [feat. X]")==="montagem aghanim"` ; `matchTracks` : « C’est la vie » (apostrophe typographique) ↔ « C'est la vie » trouvé ; titre absent → `track:null` ; tri par date d'ajout respecté au commit.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte.
- [ ] **Step 5 : Vérif réelle** — importer le fixture contre la bibliothèque réelle ; capture de l'aperçu ; supprimer la playlist créée par le test. (L'export réel de l'utilisateur sera testé dès qu'il l'enverra.)
- [ ] **Step 6 : Commit** — `feat(import): Apple Music playlist import (txt/m3u/xml) with fuzzy matching`.

---

### Task 17 : Outils en option — minuteur de sommeil, aléatoire total, mode compact

**Files:**
- Create: `src/renderer/runtime/sleepTimer.ts`, `src/renderer/player/SleepTimerMenu.tsx`, `src/renderer/player/CompactPlayer.tsx`
- Modify: `src/renderer/audio/engine.ts` (ajout **isolé** `rampVolume`), `src/renderer/state/library.ts` (`shuffleAll`), `src/main/ipc.ts` + `src/main/index.ts` (`window:set-compact`), `src/shared/{types,channels}.ts`, `src/preload/index.ts`, `src/renderer/player/PlayerBar.tsx`, `src/renderer/shell/Shell.tsx`
- Test: `tests/sleep-timer.test.ts`, `tests/engine.test.ts` (ajout), `tests/ipc.test.ts` (ajout)

**Interfaces:**
- Produces:
  - `engine.rampVolume(to01: number, seconds: number): void` — `linearRampToValueAtTime` sur le **nœud de volume uniquement** (jamais `gain`, jamais les sources) ; met à jour la valeur mémorisée de volume à la fin.
  - `createSleepTimer(deps: { now(): number; setTimeout; clearTimeout; fade(to: number, sec: number): void; pause(): void; getVolume(): number; setVolume(v: number): void; onTrackEnd(cb: () => void): () => void }): { start(min: 15|30|45|60): void; startEndOfTrack(): void; cancel(): void; remainingSec(): number | null }` — à l'échéance : fondu 8 s vers 0, `pause()`, puis **restaure** le volume d'origine ; « fin du titre » : pause au prochain changement de titre.
  - `libraryStore.shuffleAll(): void` — aléatoire activé + lecture de toute la bibliothèque depuis un index aléatoire (chemin existant).
  - IPC `window:set-compact(on: boolean)` → fenêtre 420×132, `setAlwaysOnTop(true)`, non redimensionnable en compact ; `false` → restaure taille/position précédentes. `<CompactPlayer>` : pochette, titre, contrôles, progression ; double-clic → sortie du mode compact.
- Consumes: Tâches 3, 10.

- [ ] **Step 1 : Tests** — `sleep-timer` (faux timers) : `start(15)` → à 15 min `fade(0,8)` appelé, puis `pause()` à +8 s, puis volume restauré à sa valeur initiale ; `cancel()` avant l'échéance → rien ; `startEndOfTrack()` → `pause()` au premier `onTrackEnd`. `engine` : `rampVolume(0.2, 8)` programme une rampe **sur le nœud de volume** et ne touche ni le nœud `gain` ni les sources (moteur simulé). `ipc` : `window:set-compact` refuse un non-booléen.
- [ ] **Step 2 : Échec** — Expected: FAIL.
- [ ] **Step 3 : Implémenter**.
- [ ] **Step 4 : Succès** — Expected: PASS ; suite verte (tests moteur existants inchangés).
- [ ] **Step 5 : Vérif réelle** — minuteur réglé court via le pont dev → fondu puis pause sans clic ; capture du mode compact.
- [ ] **Step 6 : Commit** — `feat(tools): sleep timer with fade, shuffle all, compact always-on-top mode`.

---

### Task 18 : Nettoyage + empaquetage

**Files:**
- Modify: `src/renderer/theme/tokens.css` (retrait des styles morts : ne garder que ce qui est encore référencé), suppression des fichiers devenus inutiles, `PACKAGING-NOTES.md`, `electron-builder.yml` (si besoin)
- Test: suite complète + `npm run typecheck` + `npm run build`

- [ ] **Step 1 : Inventaire** — `grep` de chaque sélecteur/composant ancien ; supprimer tout ce qui n'est plus importé/référencé.
- [ ] **Step 2 : Gates** — `npm test` vert, `npm run typecheck` propre, `npm run build` sans erreur.
- [ ] **Step 3 : Empaquetage** — `npm run icon && npm run pack:dir` → `release/win-unpacked/Benten.exe` lancé : processus vivant après 8 s ; puis `npm run build:win` → installeur + portable produits ; noter tailles et chemins dans `PACKAGING-NOTES.md`.
- [ ] **Step 4 : Commit** — `chore: remove dead UI code, refresh packaging for Phase 3`.

---

## Auto-revue (effectuée)

**1. Couverture de la spec.** DA §2 → T1 (tokens/polices/icônes), appliquée T3-T12 ; motion §3 → T1 (`motionFor`, intensité, reduced motion) + chaque vue ; restructuration §4.1 → T2/T3 ; écrans §4.2 → Accueil T11, Titres T7, Albums/Album T6, Artistes T8, Playlists/Playlist/Recherche T9, Téléchargements T15, Réglages/Onboarding T12, Lecture T10 ; ergonomie §4.3 → T4 (+ usage T6-T10) ; couleur dynamique §5 → T5 ; logo/icône/intro §6 → T13/T14 ; YouTube §7.1 → T15 ; import Apple §7.2 → T16 ; outils §7.3 → T17 (+ historique T11) ; invariants §8 → contraintes globales + vérifs T2/T10/T17 ; empaquetage → T18. Mobile (Phase 4) hors plan, conformément à la spec.

**2. Steps.** Chaque step fixe un nom/signature/valeur ou un test nommé ; les corps sont laissés aux implémenteurs, sauf les règles que la spec ou l'utilisateur fixent (raccourcis, tableau d'arguments yt-dlp, seuils d'historique, tailles d'icône).

**3. Cohérence des types.** `Route`/`uiStore` (T3) réutilisés T6-T17 ; `MotionIntensity`/`motionFor` (T1) réutilisés T3, T13, T14 ; `MenuItem`/`toast`/`setDragTracks` (T4) réutilisés T6-T10 ; `useCoverColors` (T5) réutilisé T6, T8-T11 ; `TrackRowItem`/`AlbumTile` (T6) réutilisés T7-T11 ; `viewModels.ts` accumule ses fonctions pures sans collision de noms.

**4. Review Focus.** Régression audio → T2 s.5 (+ T10 s.5) ; raccourcis pendant la saisie → T4 s.1 ; URL YouTube hostiles → T15 s.1 ; export Apple réel FR/UTF-16 → T16 s.1 ; grande bibliothèque → T5 (extraction à la demande) + T7 s.5.

**5. Proportion.** Signatures, valeurs et assertions ; pas de corps transcrits. Plan à la mesure d'une refonte complète + 4 fonctionnalités.
