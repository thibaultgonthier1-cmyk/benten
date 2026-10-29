# Benten Phase 3 — Plan addendum « Biwa & Or »

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin Benten in the Benzaiten « Biwa & Or » art direction: gold-on-lacquer palette, biwa-string progress and volume, a gold medallion play button, a lacquer disc, and ink and gold-leaf effects. Assets are produced in Magnific and After Effects, and every asset has a permanent code-drawn fallback.

**Architecture:**
- Tokens change first: `--accent` becomes gold, so every screen follows.
- Four signature components (`GoldMedallion`, `BiwaString`, `LacquerDisc`, `FxOverlay`) are code-drawn. Each has a single asset slot, resolved through `assets/manifest.ts`.
- The controller produces assets in parallel: Magnific textures and illustrations, and After Effects WebM-alpha effects. Assets plug into the slots once the user validates them.
- Pure logic (string physics, the FX scheduler, motion levels) is unit-tested. Visuals are checked with isolated CDP screenshots.

**Tech Stack:** Electron 45, React 18.3.1, TS, framer-motion 11.18.2, Vitest. Dev-only tooling: system `ffmpeg` 9.0.2 (WinGet) for the WebM VP9 alpha conversion, never shipped.

**Spec:** `docs/superpowers/specs/2026-10-29-benten-phase3-da-biwa-or.md`, which extends `docs/superpowers/specs/2026-10-29-benten-phase3-design.md` and `docs/superpowers/plans/2026-10-29-benten-phase3.md`.

## Global Constraints

- Background is uniform `#000`.
- Gold accent ≈ `#d4aa50`, light `#f0d38a`, deep `#8a6420`. Lacquer red ≈ `#b8281b` / `#8e1e14`. Ivory text `#f3efe8`.
- Magenta `#e73c82` is removed everywhere.
- Gold for interactive and state elements. Cover colour only for ambience: header gradient, now-playing halo, disc reflection, water lines.
- Effects are short (≤ 600 ms), never block input, and at most **2** video effects play at once.
- Assets are bundled and offline. `src/renderer/assets/fx/` plus textures total ≤ **20 Mo**.
- Motion levels:
  - **Complet**: everything.
  - **Sobre**: video FX at reduced opacity, no gold flakes, string vibration ×0.5, disc rotates, no Ken Burns or water lines.
  - **Réduit**: no video FX, no vibration or rotation, instant state changes.
- Audio invariants are SACRED: the `analyser` is read-only, the graph is never modified for visuals, plus one AudioContext, one tick loop and sample-accurate gapless playback.
- Accessibility: gold and ivory on black ≥ 4.5:1, a visible gold focus ring, keyboard-operable controls.
- Magnific spend has a total cap of ≈ 15 000 credits. The controller announces each batch's cost and stops if the cap would be exceeded.
- No new runtime dependencies.
- Data safety: dev runs only with an isolated `--user-data-dir` seeded with copies. Never touch `%APPDATA%\Benten`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **Missing or corrupt asset file** (slot unresolved, 404, or decode error): the component renders its code fallback, with no crash and no console error spam. Owned by DA2 and DA4.
2. **Track changes mid-drag on the progress string** (gapless promotion or `next` while the pointer is down): the drag is cancelled, no seek is applied to the new track, and the string snaps to the new position. Owned by DA2.
3. **Rapid play/pause spam or many adds to playlists**: never more than 2 FX videos alive, and older ones are dropped, not queued. Owned by DA2.
4. **Réduit motion or OS reduced-motion**: zero `<video>` FX elements mounted, no rAF-driven vibration or rotation, and information is still shown. Owned by DA2 and DA3.
5. **HiDPI or window resize while dragging the string**: pointer-to-fraction stays exact (uses `getBoundingClientRect` on each move), with no off-by-DPR jump. Owned by DA2.

---

### Task DA1: Gold tokens, magenta removed

**Files:**
- Modify: `src/renderer/theme/ds/tokens.css` (accent block, `--grad-btn`, add `--gold*`, `--lacquer-red*`, `--ivory`), `src/renderer/theme/tokens.css` (legacy accent vars → gold), `src/renderer/lib/palette.ts` (`FALLBACK_RGB`), every file in `src/renderer` that hard-codes magenta (grep `e73c82|231, ?60, ?130|#ee5592|#c22e6b|#d93578`)
- Test: `tests/brand-tokens.test.ts`

**Interfaces:**
- Produces CSS vars:
  - gold scale: `--gold: #d4aa50`, `--gold-light: #f0d38a`, `--gold-deep: #8a6420`;
  - lacquer red: `--lacquer-red: #b8281b`, `--lacquer-red-deep: #8e1e14`;
  - ivory: `--ivory: #f3efe8`;
  - `--accent` = `var(--gold)`, `--accent-press: #b8913f`, `--accent-soft: rgba(212,170,80,.14)`, `--accent-ring: rgba(212,170,80,.45)`;
  - `--grad-btn: linear-gradient(180deg,#f0d38a 0%,#d4aa50 55%,#b8862f 100%)`;
  - `--on-accent: #1a1206` (text/icons on gold).
- Produces TS: `FALLBACK_RGB = [212,170,80]`.

- [ ] **Step 1: Test** — `brand-tokens`:
  - (a) walking `src/renderer/**/*.{ts,tsx,css}` finds no match of `/e73c82|231,\s*60,\s*130|ee5592|c22e6b|d93578/i`;
  - (b) parsing `ds/tokens.css` gives `--gold` contrast against `#000` ≥ 4.5 and `--on-accent` against `--gold` ≥ 4.5 (WCAG formula in the test);
  - (c) `FALLBACK_RGB` equals `[212,170,80]`.
- [ ] **Step 2: Run** `npx vitest run tests/brand-tokens.test.ts`. Expected: FAIL, because magenta is found.
- [ ] **Step 3: Implement** the token changes. Replace hard-coded magenta with the vars.
  - Text or icons drawn on top of a gold fill use `var(--on-accent)`, never white.
  - Update existing tests that assert the old fallback magenta to gold, and note each one in the report.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Real check** (isolated profile). Screenshots `design/screens/da1-albums.png` and `da1-artist.png`. LOOK at them: gold active nav, gold play pill with dark glyph, no pink anywhere.
- [ ] **Step 6: Commit** — `feat(da): gold & lacquer tokens, remove magenta`.

### Task DA2: Signature components (code-drawn, with asset slots)

**Files:**
- Create:
  - `src/renderer/assets/manifest.ts`
  - `src/renderer/lib/motionLevel.ts`
  - `src/renderer/lib/stringPhysics.ts`
  - `src/renderer/lib/fxScheduler.ts`
  - `src/renderer/ui/GoldMedallion.tsx`
  - `src/renderer/ui/BiwaString.tsx`
  - `src/renderer/ui/LacquerDisc.tsx`
  - `src/renderer/ui/FxOverlay.tsx`
  - `src/renderer/ui/signature.css`
- Test: `tests/string-physics.test.ts`, `tests/fx-scheduler.test.ts`, `tests/motion-level.test.ts`, `tests/asset-manifest.test.ts`

**Interfaces:**
- Consumes: DA1 tokens, `useMotion()` / settings `motionIntensity` (`"full" | "subtle" | "reduced"`), the engine `analyser` (read-only, via the existing runtime), and `fractionFromPointer` if present. Otherwise DA2 defines it in `stringPhysics.ts`.
- Produces:
  - `type AssetId = "tex.goldLeaf" | "tex.lacquer" | "tex.seigaihaDisc" | "tex.washi" | "fx.pluck" | "fx.inkVeil" | "fx.goldFlakes" | "fx.ripple" | "ill.emptyLibrary" | "ill.emptyPlaylist" | "ill.noResults" | "ill.onboarding" | "logo.animated" | "intro.gold"`. `assetUrl(id: AssetId): string | null` returns `null` while unproduced; the real map is filled in DA4.
  - `motionLevel(intensity, osReduced: boolean): { fx: "full" | "dim" | "none"; flakes: boolean; vibration: number /*1|0.5|0*/; rotate: boolean; ambient: boolean }`.
  - `stringPhysics.ts`:
    - `deflect(pointerX: number, pointerY: number, rect, restY): StringShape`, where `StringShape = { anchorX: number; offsetY: number }` and the offset is clamped to ±14 px;
    - `stepSpring(state: {offset: number; velocity: number}, dt: number, k = 380, damping = 14): {offset; velocity}`;
    - `vibrationAmplitude(rms: number, playing: boolean, level: number): number`, in px, max 2.5, 0 when not playing;
    - `fractionFromPointer(clientX, rect)`, clamped to [0,1].
  - `fxScheduler.ts`: `createFxScheduler(max = 2): { request(kind: FxKind, at: {x: number; y: number}): FxTicket | null; release(id: number): void; active(): FxTicket[] }`. When full, the OLDEST ticket is dropped and the new one accepted. It returns `null` when level.fx is `"none"`, which the caller passes in.
  - Components:
    - `<GoldMedallion playing size onToggle label>`: gold disc with a dark play/pause glyph, morph between the two, a pluck ripple on click via FxOverlay (or a CSS ring fallback), and a light sweep on hover.
    - `<BiwaString value(0..1) buffered? onSeek(fraction) onScrubStart onScrubEnd thin? analyser? playing trackKey>`: SVG string with a gold played segment. It bends under the pointer while dragging, springs back with `stepSpring`, vibrates by `vibrationAmplitude`, and shows a time bubble. A change of `trackKey` mid-drag cancels the drag without seeking.
    - `<LacquerDisc artKey tint playing size>`: black lacquer with gold seigaiha. It uses the texture slot `tex.seigaihaDisc` when available, otherwise a code-drawn seigaiha. The specular highlight is tinted by `tint`, and it rotates at 33⅓ rpm with ease in/out when `playing` toggles.
    - `<FxOverlay />`: portal host that plays `assetUrl("fx.*")` WebM (muted, `playsInline`, removed on `ended` or after 700 ms max). When the url is null, it renders a CSS fallback (ring or veil).

- [ ] **Step 1: Tests:**
  - `string-physics`:
    - `fractionFromPointer(150,{left:100,width:200})===0.25`, and out-of-bounds values clamp;
    - `deflect` offset is clamped to ±14;
    - `stepSpring` from offset 14 reaches |offset| < 0.5 within 1.0 s at dt 1/60;
    - `vibrationAmplitude(0.5,false,1)===0`, `vibrationAmplitude(1,true,1)<=2.5`, `vibrationAmplitude(0.5,true,0.5) === vibrationAmplitude(0.5,true,1)/2`.
  - `fx-scheduler`: three requests with max 2 leave 2 active, the first is dropped; `release` frees a slot; level `"none"` returns `null`.
  - `motion-level`: `full` → `{fx:"full",flakes:true,vibration:1,rotate:true,ambient:true}`; `subtle` → `{fx:"dim",flakes:false,vibration:0.5,rotate:true,ambient:false}`; `reduced` or osReduced → `{fx:"none",flakes:false,vibration:0,rotate:false,ambient:false}`.
  - `asset-manifest`: every `AssetId` resolves to `string|null`, and unknown ids are rejected at type level.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Vibration and rotation are driven by one rAF in each component, writing to a ref transform with no React state per frame. The analyser is read through the existing runtime accessor (read-only `getByteTimeDomainData` into a reused buffer).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Real check** (isolated). Add a dev-only route or story to the dev bridge (`__benten.signature`) that mounts the 4 components. Screenshots `design/screens/da2-signature.png` and a mid-drag `da2-string-drag.png`. `PerformanceObserver` longtask count is 0 over 10 s with all running.
- [ ] **Step 6: Commit** — `feat(da): signature components (medallion, biwa string, lacquer disc, fx overlay)`.

### Task DA3: Reskin shipped screens (Tasks 3–9)

**Files:** Modify `src/renderer/shell/*`, `src/renderer/ui/{AlbumTile,TrackRowItem,Equalizer,FlyLayer,Button,IconButton}.tsx`, `src/renderer/views/*` (hero tint rule), the CSS files. Test: `tests/brand-tokens.test.ts` (still green), plus additions to the existing view tests where behaviour changes.

**Interfaces:**
- Consumes: DA1 and DA2.
- Changes:
  - Tile and row hover-play becomes `<GoldMedallion size="sm">`.
  - Primary buttons get gold `--grad-btn` with `--on-accent` glyphs.
  - The sidebar active indicator becomes a thin gold brush stroke.
  - The equalizer is gold.
  - Favorite active is lacquer red.
  - The FlyLayer visual becomes gold-leaf flakes through `FxOverlay` (`fx.goldFlakes`, falling back to code-drawn flakes, and none when `flakes:false`).
  - Hero tint follows the rule: cover colour for the gradient, gold for controls.
  - The page transition adds the ink-veil fallback, only at level full.

- [ ] **Step 1: Test** — extend the existing tests. FlyLayer requests `fx.goldFlakes` through the scheduler only when `motionLevel().flakes`. Equalizer and hover-play components render with `var(--accent)`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Change no structure, routes or behaviour.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Real check** (isolated). Screenshots da3-{home,albums,album,tracks,artist,playlists,playlist,search}.png. LOOK at all of them. Repeat at motion `reduced` and confirm zero `<video>` elements and no rAF loops.
- [ ] **Step 6: Commit** — `feat(da): reskin shell and views in Biwa & Or`.

### Task A (controller, not dispatched): Asset production in Magnific and After Effects

Done by the controller in parallel with DA2/DA3/T10. For each batch, estimate the cost with `simulate_cost` and announce it.
- **Textures** (Magnific → `design/textures/`): gold leaf, black urushi lacquer, seigaiha maki-e disc (1024², tileable or circular), washi, ink wash.
- **Illustrations** (Magnific → `design/illustrations/`): empty library, empty playlist, no results, onboarding. Ink and gold, Benzaiten / biwa / waves / torii by the water.
- **After Effects** (`design/motion/benten-fx.aep`): `fx.pluck` (gold ripple, 500 ms), `fx.inkVeil` (600 ms), `fx.goldFlakes` (550 ms), `fx.ripple` (500 ms), `logo.animated`, `intro.gold` (the intro re-coloured gold and lacquer). Render with alpha, then convert with `ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32` to `.webm`.
- **User validation:** show the stills and clips on black in the companion tab, and iterate until approved. Only approved files are copied to `src/renderer/assets/`.

### Task DA4: Integrate validated assets

**Files:** Modify `src/renderer/assets/manifest.ts` (real map), add files under `src/renderer/assets/{fx,tex,ill}/`. Test: `tests/asset-budget.test.ts`.

- [ ] **Step 1: Test** — `asset-budget`:
  - the total bytes of `src/renderer/assets/**` are ≤ 20 × 1024 × 1024;
  - every `assetUrl` value points to an existing file;
  - each `fx.*` is `.webm` with an alpha-capable header (VP9 `yuva420p` is checked at build time through a `scripts/check-fx.mjs` that runs ffprobe if available, and otherwise skips with a warning).
- [ ] **Step 2: Run.** Expected: FAIL until the assets are added.
- [ ] **Step 3: Implement** the map. Preload `fx.*` once at boot (one hidden `<video>` per kind, reused).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Real check** (isolated):
  - click play 10 times quickly and confirm ≤ 2 FX videos are alive;
  - rename one asset file to simulate a missing file and confirm the fallback renders with no crash, then restore it;
  - zero longtasks over 10 s of playback;
  - screenshots `da4-*.png`.
- [ ] **Step 6: Commit** — `feat(da): integrate Biwa & Or assets`.

### Updates to existing Phase 3 tasks (briefs amended, same task numbers)

- **T10 (player):**
  - PlayerBar uses `<GoldMedallion>` for play, `<BiwaString>` for progress and a thin `<BiwaString>` for volume. The mute button is a bachi icon.
  - The NowPlaying disc is `<LacquerDisc>`, which replaces the vinyl. The mini-disc behind the bar cover is a small `<LacquerDisc>`.
  - Kept: Ken Burns and breathing.
  - Replaced: colour blobs become slow water lines tinted by the cover, and the heart pop becomes gold flakes.
  - All of it is gated by `motionLevel`.
- **T13 (logo/icon):** gold sun behind the curved-kasagi torii. The app icon is readable at 16 px, with no magenta. `BentenMark` uses the same mark.
- **T14 (intro):** uses `assetUrl("intro.gold")` from Task A. No sound.
- **T15 (downloads):** the progress ring is gold, the completion uses gold flakes, and errors use lacquer red.
- **T17B (EQ):** the sliders are koto bridges on strings, and the response curve is a gold thread.

### Execution order

T9 completes (it edits the same shell/view files) → DA1 → DA2 → DA3 → T10 → T11 → T12, with Task A running in parallel from DA2 onward → DA4 → T13 → T14 → T15 → T16 → T17 → T17B → T18 → whole-branch review.
