# Apple Music (iOS 26 / 27) — reference for Benten

Research compiled 2026-11-05 for the Benten native iOS player (SwiftUI, iOS 17+ deployment, Xcode 26 / iOS 26 SDK, target device iPhone 17 Pro Max).
Goal: match or beat Apple Music in feel, fluidity, design and AutoMix.

**How to read the labels**

| Label | Meaning |
|---|---|
| **[CONFIRMED]** | Stated in Apple documentation, a WWDC session, an Apple Support article, or the published source code cited. |
| **[REPORTED]** | Reported by reputable press (9to5Mac, MacRumors, BGR, How-To Geek, TechRadar, heise) or in repeated user reports. It has not been verified against Apple. |
| **[OBSERVED]** | Longstanding Apple Music behaviour known to the author but without a citable written source. Check it on a device (screen-record Apple Music at 120 Hz and step through frames) before copying it exactly. |
| **[INFERENCE]** | The author's engineering deduction. It is a recommendation, not a fact about Apple. |

Apple has never published Apple Music's internal numbers: AutoMix transition lengths, the Now Playing layout in points, or its spring constants. Wherever a number below is not labelled CONFIRMED, treat it as a starting value to tune on the device.

---

## 1. How Apple Music is built, and why it feels instant

### 1.1 Stack
- **[CONFIRMED – nothing published]** Apple has not said whether Music.app is UIKit or SwiftUI. Timac's binary census of iOS 18 found 592 binaries using SwiftUI out of 6,800 and does not single out Music. The SwiftUI-lifecycle app it lists, `MusicRecognition.app`, is Shazam, not Music. Source: https://blog.timac.org/2024/1208-state-of-swift-and-swiftui-ios18/
- **[CONFIRMED]** The iOS 26 Music mini player is the reference implementation of the tab-bar **bottom accessory**. WWDC25 sessions 284 (UIKit) and 323 (SwiftUI) use Music as the example. UIKit exposes it as an accessory on `UITabBarController`; SwiftUI exposes `.tabViewBottomAccessory`. Sources: https://developer.apple.com/videos/play/wwdc2025/284/ and https://developer.apple.com/videos/play/wwdc2025/323/
- **[CONFIRMED]** Apple's Now Playing swipe-to-dismiss is the flagship example in "Designing Fluid Interfaces" (WWDC18 803). Source: https://developer.apple.com/videos/play/wwdc2018/803/
- **[INFERENCE]** The app is a UIKit shell with SwiftUI islands, using a custom interactive presentation for Now Playing. For Benten this does not matter: the user feels the timing behaviours listed below, not the framework.

### 1.2 Why it feels instant (transferable mechanisms)
| Mechanism | Detail | Label / source |
|---|---|---|
| Interruptible springs that keep velocity | A spring can start with the gesture's release velocity, and retargeting a spring mid-flight keeps its current velocity. Ease-in-out curves cannot do either, so motion "jerks to a halt". | [CONFIRMED] WWDC23 "Animate with springs" https://developer.apple.com/videos/play/wwdc2023/10158/ |
| 1:1 tracking + momentum projection | Content stays glued to the finger. On release, project the endpoint from velocity and deceleration rate, snap to the nearest target, and use the **touch history**, not just the last sample. | [CONFIRMED] WWDC18 803 |
| Low swipe hysteresis | iOS starts a swipe after **10 pt** of travel. | [CONFIRMED] WWDC18 803 |
| Tap highlight on touch-down | Highlight on touch-down, act on touch-up, add extra hit margin, cancel if the finger drags off. | [CONFIRMED] WWDC18 803 |
| No tap delay | A plain tap waits ~0.5 s if the same view also has a double-tap recognizer. Avoid double-tap on primary controls. | [CONFIRMED] WWDC18 803 |
| Prefetch + off-main decode | Images decode on the main thread at commit unless prepared earlier. Use `prepareForDisplay` / `prepareThumbnail(of:)`. Prefetching gives each cell **~2×** the preparation time. | [CONFIRMED] WWDC21 10252 https://developer.apple.com/videos/play/wwdc2021/10252/ |
| 120 Hz | At 120 Hz the budget is **8.3 ms per frame**, versus 16.7 ms at 60 Hz. Work that fits at 60 Hz can hitch at 120 Hz. | [CONFIRMED] arithmetic from WWDC21 10252 / WWDC25 306 |
| Faster Now Playing in iOS 27 | Apple's iOS 27 notes say "the Now Playing view loads faster" and playback starts sooner from a cold launch. Apple itself treats time-to-Now-Playing as a headline metric. | [REPORTED] MacRumors https://www.macrumors.com/2026/06/09/apple-music-gains-automix-upgrades-and-more-in-ios-27/ |
| Haptic on track change | The iOS 26.1 mini-player swipe plays "a tap of haptic feedback when the track is changed". | [REPORTED] 9to5Mac https://9to5mac.com/2025/11/04/ios-26-1-gave-apple-music-convenient-new-trick/ |

### 1.3 Spring numbers to use
**[CONFIRMED] SwiftUI presets.** Apple's documentation states these defaults:

| Preset | Duration (s) | Bounce |
|---|---|---|
| `.smooth` | 0.5 | 0 |
| `.snappy` | 0.5 | **0.15** (base) |
| `.bouncy` | 0.5 | **0.30** (base) |

- `.smooth`: critically damped, as described in WWDC23 10158.
- `.snappy`: "base bounce of 0.15". Source: https://developer.apple.com/documentation/swiftui/animation/snappy(duration:extrabounce:)
- `.bouncy`: "base bounce of 0.3". Source: https://developer.apple.com/documentation/swiftui/animation/bouncy(duration:extrabounce:)

**[CONFIRMED]** `interactiveSpring()` defaults to response 0.15, dampingFraction 0.86, blendDuration 0.25. Legacy `.spring()` defaults to response 0.55, dampingFraction 0.825. Source: https://developer.apple.com/documentation/swiftui/animation/interactivespring(response:dampingfraction:blendduration:)

**[CONFIRMED] WWDC23 10158 guidance**
- Start with bounce 0.
- 0.15 "doesn't feel very bouncy yet"; 0.3 is "noticeable".
- Values above ~0.4 are "too exaggerated for a UI element".
- Choose the duration first, then the bounce.
- Conversion: `stiffness = (2π/duration)²` and `damping = 1 − 4π·bounce/duration` (mass = 1), for bounce ≥ 0.

**[CONFIRMED] WWDC18 803**
- Default to **100 % damping**, meaning no overshoot.
- Apple's Music **Now Playing swipe-to-dismiss uses ≈80 % damping**, because the gesture carries momentum. Bounce is justified only after a momentum gesture.

**[CONFIRMED] Momentum projection** (WWDC18 803 sample code):
```swift
func project(_ v: CGFloat, rate: CGFloat = UIScrollView.DecelerationRate.normal.rawValue) -> CGFloat {
    (v / 1000) * rate / (1 - rate)   // .normal = 0.998, .fast = 0.99
}
```

**[INFERENCE] Mapping for Benten**

| Interaction | Spring |
|---|---|
| Finger-tracking | `interactiveSpring` / `.spring(duration: 0.25, bounce: 0)` |
| Player open | `.spring(duration: 0.45, bounce: 0)` |
| Player dismiss after a flick | `dampingFraction 0.8` (≈ bounce 0.2), started with the gesture's velocity |
| Button press scale | `.snappy(duration: 0.25)` |
| Artwork play/pause scale | `.spring(duration: 0.5, bounce: 0.2)` |

Never use a bounce above 0.3.

---

## 2. Apple Music iOS 26 / 27 design reference

### 2.1 Tab bar + mini player (Liquid Glass bottom accessory)
- **[CONFIRMED]** The bottom accessory API is `TabView { … }.tabBarMinimizeBehavior(.onScrollDown).tabViewBottomAccessory { MiniPlayer() }`.
  - The tab bar floats over the content, minimizes when the user scrolls down, and re-expands when the user scrolls back up.
  - `@Environment(\.tabViewBottomAccessoryPlacement)` reports `.expanded` (a bar above the tab bar) or `.inline` (sharing a row with the minimized tab bar).
  - Music shows fewer controls when inline, per WWDC25 284.
  - Sources: https://developer.apple.com/documentation/swiftui/tabviewbottomaccessoryplacement and WWDC25 323.
- **[CONFIRMED]** `GlassEffectContainer` is required when several glass shapes sit near each other, because "glass cannot sample other glass". `glassEffectID` morphs glass shapes between states. `.glassEffect(.regular.interactive())` gives the iOS scale, bounce and shimmer on press. Source: WWDC25 323.
- **[CONFIRMED]** Don't add your own darkening or background behind bars, because it fights the automatic scroll-edge effect. Partial-height sheets are inset glass by default and become opaque at full height. Remove `presentationBackground` so the system material shows. Source: WWDC25 323.
- **[REPORTED, iOS 26.1]** Mini-player gestures:
  - Swipe left goes to the next track; swipe right goes to the previous one.
  - The swipe works on both the expanded and the inline mini player.
  - It also works on the **song title in full-screen Now Playing**.
  - Liquid Glass effects plus a haptic accompany the change.
  - Source: https://9to5mac.com/2025/11/04/ios-26-1-gave-apple-music-convenient-new-trick/
- **[INFERENCE]** Tap to open full Now Playing: Apple has not documented a public API for the mini-player → player morph (open forum question: https://developer.apple.com/forums/thread/792835). The nearest public API is `.matchedTransitionSource(id:in:)` on the mini player plus `.navigationTransition(.zoom(sourceID:in:))` on the presented player (iOS 18+). A custom overlay with `matchedGeometryEffect` on the artwork gives more control and can be driven interactively. Benten already uses a custom overlay; keep it if dragging is interactive and velocity-preserving.

### 2.2 Full-screen Now Playing (layout and behaviour)
- **[CONFIRMED]** Since iOS 17, album art "appears full-screen in the music player, including motion where available". Source: Apple Music for Artists https://artists.apple.com/support/5333-ios-17-whats-new
- **[CONFIRMED]** iOS 26 Lock Screen: tapping the artwork expands it full-screen, motion artwork plays, and controls sit on a Liquid Glass platter. Third-party apps get the same behaviour through `MPMediaItemAnimatedArtwork` (see §4.5). Sources: https://www.macrumors.com/2025/06/11/ios-26-animated-lock-screen-album-art/ and https://developer.apple.com/documentation/mediaplayer/providing-animated-artwork-for-media-items
- **[REPORTED]** While AutoMix is mixing, the Lossless/Atmos badge becomes an **animated, glowing "Mixing" label**, and the **artwork morphs smoothly into the next cover** instead of cutting. Sources: https://www.howtogeek.com/i-disabled-apple-music-automix/ and https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/
- **[REPORTED, iOS 27]** Landscape layouts: artwork beside the controls, and lyrics beside the artwork. Source: https://9to5mac.com/2026/09/18/apple-music-in-ios-27-five-new-features-iphone/
- **[OBSERVED] Static layout on a 6.9" iPhone** (iPhone 17 Pro Max: 440 × 956 pt; verify by screenshot):
  - A grabber sits at the top. Dismissal is a swipe down from anywhere.
  - The square artwork is roughly 24–28 pt from each side, so ~385–390 pt wide on 440 pt, with a corner radius of ~10–12 pt and a soft drop shadow.
  - Title and artist are left-aligned (title semibold ~20–22 pt, artist regular, secondary vibrancy). The ⭐/••• buttons are on the right of the same row.
  - The scrubber has no knob and is drag-anywhere (iOS 16+; confirmed by Six Colors https://sixcolors.com/?p=23784). The track **thickens while touched** [OBSERVED]. Elapsed and remaining times sit below it, with the quality badge centred.
  - Transport: three large SF Symbols (`backward.fill`, `play.fill`/`pause.fill`, `forward.fill`), the centre one ~44–48 pt glyph. They give a press-state shrink without a button background.
  - Below that: the volume slider, which also thickens when touched [OBSERVED], then a bottom row of Lyrics, AirPlay and Queue buttons.
- **[OBSERVED] Pause behaviour.** When paused, the artwork **shrinks** (≈ 0.8× scale) and its shadow tightens. On play it springs back to 1.0× with slight overshoot. This is one of the most "Apple Music" micro-interactions. Apply it to the cover only, never to the controls.
- **[OBSERVED] Lyrics and queue.** Switching to Lyrics or Queue morphs the big artwork into a small thumbnail (~56–64 pt) top-left beside the title (a shared-element transition). The background stays the same animated colour field.
- **[OBSERVED] Background.** Since iOS 14 the Now Playing / lyrics background has been a slow-moving, blurred colour field taken from the artwork (iMore, iOS 14: https://imore.com/now-playing-apple-music-app-gets-complete-redesign-ios-14). Motion artwork, when present, is drawn full-bleed at the top and fades into the control area.

### 2.3 Lyrics (reference values from a faithful open-source re-implementation)
Apple publishes nothing on its lyrics view. **AMLL** ("Apple Music-like Lyrics", https://github.com/amll-dev/applemusic-like-lyrics) is the most carefully tuned public clone. The values below are read from its source (`packages/core/src/lyric-player/base/index.ts`). **[CONFIRMED for AMLL / INFERENCE for Apple]**

| Parameter | Value |
|---|---|
| Line vertical spring | mass 0.9, damping 15, stiffness 90 (underdamped; adjusted dynamically by the gap between lines; steadier while seeking or during interludes) |
| Line scale spring | mass 2, damping 25, stiffness 100 |
| Background scale spring | mass 1, damping 20, stiffness 50 |
| Stagger | each following line starts **50 ms** later, and each step after the active line shrinks the step by ÷1.05 ("ripple") |
| Blur level | `1 + distance` lines from the focus (×0.8 on narrow screens); **no blur while the user is scrolling** and none on the active line |
| Opacity | active line 0.85 when highlighted, others 1.0 in the dynamic layout (dimming comes from blur and colour) |
| Interlude | animated dots between lines when the gap is long |

**[INFERENCE] SwiftUI mapping.**
- A spring of mass 0.9 / stiffness 90 / damping 15 is roughly `.spring(response: 0.63, dampingFraction: 0.83)`.
- Stagger with `.delay(Double(i) * 0.05)`.
- Blur with `.blur(radius: CGFloat(level) * 1.5)`.
- Pause blur during a drag.

### 2.4 Lists, library, album pages
- **[REPORTED, iOS 26.4]** Album and playlist pages become "fullscreen": the track list sits on a **background colour chosen to complement the artwork, not an exact sample of it**. iOS 27 extends this to artist pages, along with a prominent shuffle button. Sources: https://9to5mac.com/2026/02/16/apple-music-in-ios-26-4-has-new-design-for-albums-playlists-and-more/ and https://9to5mac.com/2026/09/18/apple-music-in-ios-27-five-new-features-iphone/
- **[CONFIRMED]** In `.searchable`, use `Tab(role: .search)` so search becomes its own glass tab that morphs into the field. Source: WWDC25 256/323.
- **[OBSERVED]** Song rows are ~56–60 pt tall with ~44–48 pt artwork thumbnails (corner radius ~4–6 pt), a ~17 pt title, a ~13–15 pt secondary line, a hairline separator inset to the text, and a trailing ••• button.
  - Swipe actions: leading = Play Next / Play Last; trailing = Delete / Download.
  - Long-press opens a context menu with a preview.
  - Tapping a row highlights immediately and starts playback with **no navigation**. The mini player updates within the same frame.

### 2.5 iOS 26 / 27 changes worth mirroring
- **[CONFIRMED – Apple Support]** AutoMix is the default transition mode. The AutoMix / Crossfade toggles live **in the Up Next (queue) screen**, and the Crossfade length is set in Settings. Source: https://support.apple.com/en-gb/105067
- **[REPORTED]** iOS 26 added lyrics translation and pronunciation; iOS 27 added more language pairs. Other iOS 27 changes: faster Now Playing load, the Now Playing Lock Screen widget can be swiped away, and landscape layouts. Source: MacRumors (above).

---

## 3. AutoMix, Crossfade, Sound Check

### 3.1 What Apple documents [CONFIRMED – Apple Support]
- AutoMix "transitions between songs like a DJ". Per Apple's iPhone guide (https://support.apple.com/guide/iphone/aside/iphcba31c44b/ios), it **chooses the transition according to the music**:
  - removing silence at the start and end of a track,
  - or a **simple crossfade**,
  - or a more complex beat-matched blend.
- **"Albums and some genres play without transitions."** (same guide)
- AutoMix may not transition dynamically when (https://support.apple.com/en-gb/105067):
  - the album plays in sequential order,
  - genres or tempos are incompatible,
  - the content was uploaded from the user's library,
  - or the content was purchased from the iTunes Store.
- **AutoMix and Crossfade do not run with Hi-Res Lossless.** AutoMix requires an Apple Music subscription. Crossfade is adjustable from **1 to 12 s**. Source: https://support.apple.com/en-gb/105067
- **Not available over AirPlay.** AutoMix is disabled while AirPlay is in use. Source: https://www.apfelpatient.com/tips-tricks/apple-music-transitions-setup-automix-or-crossfade
- Apple's marketing describes it as "time stretching and beat matching". HomePod 27 release notes repeat the same wording. Source: https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/
- Apple told BGR it **added safeguards so AutoMix won't fade between albums or genres like classical**. Source: https://bgr.com/2059450/how-to-turn-off-automix-apple-music-worst-feature

### 3.2 iOS 27 upgrade [REPORTED]
- Apple says the algorithms are reworked to create new transition types.
- **AutoMix "will remix the outro and intro of songs to align the tempo" and "repeat parts of the outros and intros to bridge the transition"**, i.e. beat-aligned **looping** of intro/outro sections.
- The **"underwater" sound effect** that iOS 26 defaulted to has **"largely been replaced by more natural transitions"**. That effect was most likely a low-pass or band filter sweep [INFERENCE].
- AutoMix now also runs on tvOS and HomePod.
- Sources: https://9to5mac.com/2026/07/16/ios-27-makes-one-of-my-favorite-apple-music-features-even-better/ and https://www.macrumors.com/2026/06/09/apple-music-gains-automix-upgrades-and-more-in-ios-27/

### 3.3 Known complaints (requirements for Benten to beat) [REPORTED]
| Complaint | Detail | Source |
|---|---|---|
| Cuts song endings | Mixing starts too early; "roughly the last 30 seconds" lost. A song can end before its final chords, with the next track playing over the fade-out. | TechRadar / BGR |
| Skips intros / first verse | Up to "**a full minute**"; one reviewer heard ~1 min of a 3-min song. | How-To Geek https://www.howtogeek.com/i-disabled-apple-music-automix/ |
| Volume blast | Next song "suddenly blasts over the current one, then corrects itself a second or two later"; occasional stutter or screech. | How-To Geek |
| Unreliable trigger | Often fails to trigger even between compatible tracks. | How-To Geek |
| Play counts | A track cut by AutoMix is not counted as a full play, which breaks play-count smart playlists. | Apple Community https://discussions.apple.com/thread/256177427 |
| Vocals to the end | Songs whose vocals run to the very end produce awkward transitions. | iPhone Life https://iphonelife.com/content/how-toggle-apple-music-song-transitions-or |
| Genre bias | Good for electronic, pop and hip-hop; bad for rock, jazz, classical (false endings, odd metres). | BGR; heise https://heise.de/-11139247 |
| No controls | AutoMix is on/off only: no length or style control, no per-playlist setting, and the setting doesn't sync across devices. | heise, How-To Geek |
| Repeat-one | No published behaviour. | — |

**[INFERENCE]** On repeat-one, Benten should never AutoMix a track into itself. Use a gapless loop instead, or at most a ≤ 1-bar seamless loop when the track has a clean beat grid.

### 3.4 Implications for Benten's mixer [INFERENCE, with supporting sources]
1. **Use a strict fallback ladder, like Apple:**
   1. sequential album or same-album → **gapless, no transition**;
   2. classical / live / spoken-word, or low beat-grid confidence → **silence trim + short equal-power fade (2–4 s)**;
   3. both grids confident and |Δtempo| ≤ ~8 % → **beat-matched blend**;
   4. otherwise → **phrase-aligned crossfade without time-stretch**.
   Mixxx's *Skip Silence* mode trims at **−60 dBFS**: https://manual.mixxx.org/2.5/en/chapters/djing_with_mixxx
2. **Never trade content for alignment.** This is Apple's #1 complaint. Hard limits:
   - The outgoing track plays at least until its detected *outro start*. Never cut more than ~8 bars or ~15 s, whichever is smaller, of musical content (signal > −60 dBFS).
   - The incoming track never starts later than its first downbeat after the intro start + 8 bars.
   - Never cut vocals: if a vocal or energy detector shows activity in the last N bars, fall back to an end-aligned fade.
   - Mixxx's default *Full Intro + Outro* mode aligns the **ends** of the outro and the intro, and "picks the time of the shorter section as the crossfade time" (same Mixxx link). That is a safe template.
3. **Count a play as complete** when the track is mixed out after its outro start. This fixes Apple's play-count bug.
4. **Bridge with loops, not filters (iOS 27 direction).** When the outro is shorter than the intro, loop the last clean 4 or 8 bars of the outro, phrase-aligned, rather than starting the mix earlier. Prefer bass-swap EQ blending to "underwater" low-pass sweeps; Apple moved away from the latter.
   - Bass-swap practice: cut the incoming lows fully (kill ≈ −26 dB) before it enters, and swap lows on a phrase boundary over 8–16 bars. Sources: https://app.studyraid.com/en/read/110800/5048870/eq-mixing-swapping-basslines and https://violetrecording.com/how-to-eq-mix-as-a-dj/
5. **Limit the stretch range.** Keylock quality "drops off outside roughly ±10 %" (Mixxx developers, https://bugs.launchpad.net/mixxx/+bug/749396).
   - Keep each deck within **±6 %**, splitting the difference between the decks as Benten already does with its tempo crossing.
   - Above ~8 % total, don't beat-match: use a short phrase-aligned fade instead.
   - `AVAudioUnitTimePitch.overlap` defaults to 8 (range 3–32), and "a higher value results in fewer artifacts". Use **16–32** for music, accepting the extra CPU. Source: https://developer.apple.com/documentation/avfaudio/avaudiounittimepitch/overlap
6. **Never blast.** Apply the loudness-matching gain to the incoming deck **before** its first audible sample, ramp gains with equal-power curves, and keep the summed level within −1 dBTP. Apple's "blast then correct after 1–2 s" bug looks like gain applied late [INFERENCE].
7. **Show "Mixing" in the UI.** Mirror Apple: animate a "Mixing" badge and cross-dissolve or morph the artwork over the transition window.
8. **Expose the controls Apple lacks:** short/normal/long length (Benten has 8/16/32 beats), a per-playlist toggle, and an "album mode = gapless" rule. These answer documented frustrations.

### 3.5 Crossfade mode
- **[CONFIRMED]** Apple Crossfade runs 1–12 s and is available without a subscription. Source: Apple 105067.
- **[INFERENCE]** Use an equal-power law, `gIn = sin(t·π/2)` and `gOut = cos(t·π/2)`, so that `gIn² + gOut² = 1`. Trim leading and trailing silence (−60 dBFS) **before** computing the overlap so a fade never covers silence; a guide notes that songs ending in 10+ s of silence otherwise make the crossfade "mix silence".

### 3.6 Sound Check / loudness
- **[REPORTED – widely cited, not in Apple consumer docs]** Apple Music normalises to **−16 LUFS integrated** (following AES TD1008) and has done so since 2022, when it moved to LUFS. Sound Check is on by default on iOS. Mastering guides pair this target with a **−1 dBTP** true-peak ceiling. Sources: https://www.production-expert.com/production-expert-1/apple-choose-16lufs-loudness-level-for-apple-music-heres-why and https://www.roexaudio.com/blog/how-to-master-music-for-streaming-spotify-apple-music-deezer-youtube
- **[REPORTED]** Users report that iOS Sound Check works **per track, not per album**: quiet album intros get boosted. Sources disagree on whether quiet tracks are raised or only loud ones lowered. Source: https://discussions.apple.com/thread/255891149
- **[INFERENCE] Spec for Benten:**
  - Measure ITU-R BS.1770 / EBU R128 integrated loudness: K-weighting (high-shelf +4 dB @ ~1.5 kHz plus high-pass @ ~38 Hz), 400 ms blocks with 75 % overlap, −70 LUFS absolute gate, −10 LU relative gate. Also measure the true peak (4× oversampled).
  - Gain = −16 − LUFS, capped so that `peak + gain ≤ −1 dBTP`. Allow at most **+6 dB** of boost (Benten already uses ±6 dB).
  - **Album mode:** when playing an album in order, apply one album gain (power mean of the track loudnesses) to preserve the album's dynamics. This beats Apple's per-track behaviour.
  - Benten's current `loudness` is an RMS-style "perceived" value with target 0.12 (Player.swift:176). Swapping it for gated K-weighted LUFS is the upgrade.

---

## 4. Building a premium music app on iOS: best practices

### 4.1 AVAudioEngine architecture for gapless and DJ mixing
- **[CONFIRMED] Timelines.** `AVAudioPlayerNode` node sample times have an **arbitrary zero point**. The player timeline sits on top of that, and you convert with `nodeTime(forPlayerTime:)` / `playerTime(forNodeTime:)`.
  - `stop()` unschedules everything and resets player time to 0.
  - **Do not stop a player inside a completion handler** (deadlock).
  - For file segments the node resamples, but Apple prefers that the node output match the file rate and that a mixer do the conversion.
  - Source: https://developer.apple.com/documentation/avfaudio/avaudioplayernode
- **[CONFIRMED] Gapless.** Scheduling with `when: nil` plays the segment "immediately following" the previous one: that is sample-exact gapless on a single node. For overlaps, use two decks and start the second with `play(at: AVAudioTime(sampleTime:atRate:))` computed from the **same** `lastRenderTime`. Source: same page; community confirmation https://developer.apple.com/forums/thread/14138
- **[CONFIRMED] Completion callback types.** Use `.dataPlayedBack` when you need to know the audio was actually heard. The alternatives, `.dataConsumed` and `.dataRendered`, fire earlier. Source: https://developer.apple.com/documentation/avfaudio/avaudioplayernodecompletioncallbacktype
- **[CONFIRMED] Configuration changes.** `AVAudioEngineConfigurationChange` stops and uninitializes the engine when a route changes the channel count or sample rate (Bluetooth A2DP↔HFP, AirPlay).
  - The handler runs on an internal queue; **do not tear the engine down synchronously there**.
  - Scheduled buffers are purged, and their completion handlers still fire even though the audio never played.
  - Keep your own position: capture `playerTime` regularly, because `lastRenderTime` is nil after the event.
  - Sources: https://developer.apple.com/documentation/foundation/nsnotification/name-swift.struct/avaudioengineconfigurationchange, https://developer.apple.com/forums/thread/769907, https://lists.apple.com/archives/coreaudio-api/2019/Apr/msg00002.html
- **[CONFIRMED] TimePitch ranges.** `AVAudioUnitTimePitch.rate` ranges 1/32 – 32 (default 1); `overlap` ranges 3–32 (default 8). `AVAudioUnitVarispeed` changes rate with pitch (vinyl-style), which is cheaper and has no stretch artifacts. Sources: https://developer.apple.com/documentation/avfaudio/avaudiounittimepitch/rate and https://developer.apple.com/documentation/avfaudio/avaudiounittimepitch/overlap

### 4.2 Latency handling (lyrics, beat-synced visuals, mixing)
- **[CONFIRMED]** API definitions:
  - `AVAudioNode.latency` is a node's processing delay; **0 means none *or unknown***.
  - `outputPresentationLatency` is the maximum render-pipeline latency downstream of the node.
  - `AVAudioSession.outputLatency`: "an AirPlay-enabled device … can result in a **2-second delay**".
  - Sources: https://developer.apple.com/documentation/avfaudio/avaudionode/latency, https://developer.apple.com/documentation/avfaudio/avaudionode/outputpresentationlatency, https://developer.apple.com/documentation/avfaudio/avaudiosession/outputlatency
- **[REPORTED]** `AVAudioUnitTimePitch.latency` reads **≈ 0.09 s** on devices (https://developer.apple.com/forums/thread/708168). The legacy AUTimePitch measured **75.4 ms (3,325 frames @ 44.1 kHz)**, and its actual output came ~12 ms earlier than the reported value (https://lists.apple.com/archives/coreaudio-api/2005/Dec/msg00019.html).
- **[INFERENCE] Rules:**
  1. Route **both decks through identical chains** (TimePitch + EQ on each) and keep both TimePitch nodes in-graph even at rate 1. Their latencies then cancel in the *relative* beat alignment. Benten already does this with `pitchA` / `pitchB`.
  2. For UI clocks (lyrics, beat pulse, progress), compute: displayed time = player time − (`pitch.latency` + `mainMixer.outputPresentationLatency` + `session.outputLatency` + `session.ioBufferDuration`). Recompute on route change.
  3. On AirPlay, either disable beat-synced effects (Apple disables AutoMix) or accept that the whole pipeline is shifted ~2 s. Never mix decks across different routes.
  4. Measure, don't trust: at first launch, run an impulse through the offline (manual rendering) graph to measure the actual TimePitch delay at the overlap you use.

### 4.3 Background audio, Now Playing, remote commands
- **[CONFIRMED]** Use the `.playback` category and the `audio` background mode. Benten's Info.plist already has it.
- **[CONFIRMED]** Interruptions: on `.ended`, resume only if `.shouldResume` is set. On a route change with `.oldDeviceUnavailable` (headphones unplugged), pause. Source: AVAudioSession docs (https://developer.apple.com/documentation/avfaudio/avaudiosession).
- **[CONFIRMED]** `MPNowPlayingInfoPropertyElapsedPlaybackTime`: the system extrapolates elapsed time from the last value and the playback rate, so **"it isn't necessary to update this property frequently"**. Update it only on play, pause, seek, track change and rate change, and set `MPNowPlayingInfoPropertyPlaybackRate` to 0 when paused. During a DJ transition, report the **incoming** track once the crossfade passes 50 %. Source: https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfopropertyelapsedplaybacktime
- **[CONFIRMED]** `MPRemoteCommandCenter`: enable `changePlaybackPositionCommand` so the Lock Screen scrubber works. Disable any command you don't support rather than leaving it a no-op.

### 4.4 Artwork pipeline (large libraries)
- **[CONFIRMED]** Decoded bitmaps cost width × height × 4 bytes: a 3,000² cover is 36 MB, while a 144² (48 pt @3×) thumbnail is 83 KB. Downsample with ImageIO:
  - source option `kCGImageSourceShouldCache: false`;
  - thumbnail options `kCGImageSourceThumbnailMaxPixelSize = pt × scale`, `kCGImageSourceCreateThumbnailWithTransform`, `kCGImageSourceShouldCacheImmediately: true`;
  - run off the main thread.
  - Source: WWDC18 "Image and Graphics Best Practices" (session 219), https://developer.apple.com/videos/play/wwdc2018/219/
- **[CONFIRMED]** `UIImage.prepareThumbnail(of:)` / `byPreparingThumbnail(ofSize:)` / `prepareForDisplay` decode in the background. Prepared images are large, so cache them sparingly and store the originals on disk. Source: WWDC21 10252.
- **[INFERENCE] Benten** already uses an `NSCache` plus `CGImageSourceCreateThumbnailAtIndex` (AppShell.swift). Additions:
  - Set `totalCostLimit`, e.g. ~64 MB for thumbnails, with cost = bytes.
  - Keep **size-bucketed keys** (48 pt / 64 pt / full-player 400 pt / backdrop 32 px) so a small and a large rendering never evict each other.
  - **Prefetch the next 2–3 queue items' full-size art and backdrop palette**, so swiping the mini player or skipping shows the cover in the same frame.
  - Dedupe per album: one artwork ID per album, which is also Apple's recommendation for animated artwork.

### 4.5 Animated artwork for the Lock Screen (iOS 26 API)
**[CONFIRMED]** Source: https://developer.apple.com/documentation/mediaplayer/providing-animated-artwork-for-media-items
- Keys: `MPNowPlayingInfoProperty1x1AnimatedArtwork` (square) and `MPNowPlayingInfoProperty3x4AnimatedArtwork` (tall). Check `MPNowPlayingInfoCenter.supportedAnimatedArtworkKeys`, because unsupported keys are ignored.
- Each value is an `MPMediaItemAnimatedArtwork(artworkID:previewImageRequestHandler:videoAssetFileURLRequestHandler:)`.
  - The preview image should equal the first video frame and be returned **ideally synchronously**.
  - The video URL **must be a local file**; the request times out after **30 s**.
  - A wrong aspect ratio makes the system fall back to the static artwork.
- Video rules:
  - any `AVPlayerLayer`-playable asset;
  - **≤ 60 fps** (higher may not display);
  - preferably **< 30 s** and **seamlessly looping** (no jump or fade at the loop point);
  - complementary to the static art.
- The system shows the static preview instead when the device is in Low Power Mode or low-data mode, the thermal state is high, **Reduce Motion** is on, or **Auto-Play Animated Images** is off. **Mirror exactly these gates in Benten's in-app living artwork / backdrop.**
- Reuse the same `artworkID` across an album. The system doesn't cache assets across different IDs.

### 4.6 SwiftUI performance (1,000+ items)
- **[CONFIRMED – WWDC23 10160 "Demystify SwiftUI performance"]** https://developer.apple.com/videos/play/wwdc2023/10160/
  - `List` gathers **all IDs eagerly**, so make IDs cheap.
  - Keep a **constant number of views per `ForEach` element**: no `if` that yields 0 or 1 view, no `AnyView`.
  - **Never filter or sort inline in `ForEach`**; cache filtered arrays in the model.
  - Pass rows only the values they read.
  - Do no heavy work in `body` or in `@State` initialisers.
- **[CONFIRMED – WWDC25 306 "Optimize SwiftUI performance with Instruments"]** https://developer.apple.com/videos/play/wwdc2025/306/
  - Use the new SwiftUI instrument's *Long View Body Updates* lane and the *Cause & Effect* graph.
  - Create formatters once, never in `body`.
  - Give each row its **own `@Observable` view-model** instead of reading a shared collection. Favouriting one item should then update one row, not all of them.
  - **Don't put fast-changing values (timers, geometry, playback position) in the environment**: every reader is notified.
- **[CONFIRMED – WWDC25 256 "What's new in SwiftUI"]** https://developer.apple.com/videos/play/wwdc2025/256/ Building with the iOS 26 SDK gives these for free:
  - lists of 100k+ items load **6× faster** and update up to **16× faster** (figures given for macOS; all platforms improved);
  - better update scheduling for fast scrolling at high frame rates;
  - nested lazy stacks defer their contents.
- **[INFERENCE] Playback clock isolation.** The playback position should live in a dedicated `@Observable` read **only** by the progress bar, lyrics and time labels. A `TimelineView` should wrap only the scrubber, never the whole player. Benten's `PlaybackClock.swift` suggests this is already the design; verify with the Cause & Effect graph that a tick doesn't invalidate `NowPlayingView.body`.

### 4.7 120 Hz and energy
- **[CONFIRMED]** `CADisableMinimumFrameDurationOnPhone = true` is required to go above 60 Hz with `CADisplayLink` / `CAAnimation`; Benten has it. UIKit, SwiftUI and Core Animation pace their frames automatically. Source: https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays
- Apple's frame-rate guidance by animation type (same source):

  | Animation type | `CAFrameRateRange` |
  |---|---|
  | High-impact (expand to full screen, sheets) | min 80, max 120, preferred 120 |
  | Alpha/colour changes, small moves | `.default` |
  | Slow ambient motion | min 8, max 15 / min 15, max 24 / min 30, max 48 |

  Low Power Mode and heat cap the refresh rate.
- **[REPORTED]** A SwiftUI demo project measured SwiftUI dropping to 60 Hz while UIKit ran at 120 Hz on an iPhone 14 Pro (https://github.com/esnssr/frame_rate_swiftui). Verify the player open/close gesture at 120 Hz in Instruments (Hitches + Display) on the 17 Pro Max.
- **[INFERENCE] Energy budget for ambient visuals.**
  - Animated backdrops and living artwork should run at **≤ 30 fps** via `TimelineView(.animation(minimumInterval: 1/30))`. Benten already does this. Pause them when the player is hidden, the app is backgrounded, the screen is locked, `ProcessInfo.isLowPowerModeEnabled`, `thermalState ≥ .serious`, Reduce Motion is on, or `UIAccessibility.isVideoAutoplayEnabled == false` (the same gates Apple uses).
  - Reserve 120 Hz for gesture-driven motion only.
- **[CONFIRMED]** The I/O buffer: `setPreferredIOBufferDuration` is a request, and the minimum is ~0.005 s (256 frames). **[INFERENCE]** For a playback-only app, don't lower it (small buffers wake the CPU more often). Leave the default (~23 ms) or raise it. Source: https://developer.apple.com/documentation/avfaudio/avaudiosession/setpreferrediobufferduration(_:)

### 4.8 Haptics
- **[CONFIRMED]** Call `UIFeedbackGenerator.prepare()` **before** the event: calling it immediately before triggering doesn't help. The prepared state lasts "typically seconds". Source: https://developer.apple.com/documentation/uikit/uifeedbackgenerator/prepare()
- **[CONFIRMED]** SwiftUI `.sensoryFeedback(_:trigger:)` is available on iOS 17+. Source: https://developer.apple.com/documentation/swiftui/view/sensoryfeedback(_:trigger:)
- **[INFERENCE] Mapping:**
  - `.selection` when a swipe crosses the skip threshold;
  - `.impact(weight: .light)` on play/pause;
  - `.impact(.soft)` when the player snaps open or closed;
  - nothing on scrubbing, except `.selection` when crossing a lyric line or chapter.
  - Apple uses haptics sparingly; too many cheapens them.

---

## 5. Concrete tricks and pitfalls

| # | Trick / pitfall | Why | Source |
|---|---|---|---|
| 1 | Start every dismiss/open spring **with the gesture velocity** and retarget mid-flight; never animate with `easeInOut` after a drag. | Velocity continuity is what makes motion read as "physical". | WWDC23 10158, WWDC18 803 |
| 2 | Bounce only after momentum (dismiss flick ≈ 0.8 damping); 100 % damping otherwise. | Apple's own rule; matches Music Now Playing. | WWDC18 803 |
| 3 | Project the release point with `DecelerationRate.normal` (0.998) to decide open/closed, not position alone. | Quick short flicks then work. | WWDC18 803 |
| 4 | Recognise mini-player horizontal swipe and vertical drag-up **in parallel**; lock the axis after ~10 pt. | Avoids the "stuck" feel of sequential recognizers. | WWDC18 803 |
| 5 | Cross-dissolve artwork + background over the **same** window as the audio transition, with a "Mixing" badge. | Apple's AutoMix UI does this; it makes the mix legible. | How-To Geek, 9to5Mac |
| 6 | Shrink the cover on pause (~0.8×, shadow tightens), spring back on play. | Signature Apple Music feedback. | [OBSERVED] |
| 7 | Complement the artwork with a *derived* background colour, not a raw sample (saturation-clamped, darkened for white text). | iOS 26.4 album pages; avoids muddy or neon backgrounds. | 9to5Mac 26.4 |
| 8 | Fluid backdrop recipe: downsample the cover to **32×32**, then contrast ×0.4 → saturate ×3 → contrast ×1.7 → brightness ×0.75, blur, map onto a ≥ 3×3 mesh with slowly drifting control points, at ≤ 60 fps (AMLL caps at 60; 30 is enough on device). On iOS 18+ `MeshGradient(width:height:points:colors:)` with `smoothsColors: true` is the native path; keep a blurred-image fallback for iOS 17. | Gives the Apple-like "liquid colour" for very little GPU time. | AMLL `bg-render/mesh-renderer/index.ts`; https://developer.apple.com/documentation/swiftui/meshgradient |
| 9 | Optional: drive backdrop motion amplitude from the low-frequency level (AMLL `setLowFreqVolume`). Keep it subtle (≤ 5 % scale). | Feels alive with the music; Apple's is subtle. | AMLL source |
| 10 | Lyrics: 50 ms decaying stagger, distance-based blur, **no blur while the user scrolls**, auto-recentre after ~3–5 s of no touch. | Matches the Apple-like feel and keeps lyrics readable while browsing. | AMLL source (stagger, blur); recentre delay is [INFERENCE] |
| 11 | Never cut > 8 bars / 15 s of music in a mix; end-align outro/intro; count the play. | Apple's #1 AutoMix complaint, plus its play-count bug. | §3.3 |
| 12 | Disable transitions on sequential album, same album, repeat-one, classical/live/spoken. | Apple's safeguards; heise/BGR complaints. | Apple Support, BGR |
| 13 | Apply the loudness gain before the incoming deck is audible; equal-power ramps; true-peak guard −1 dBTP. | Avoids Apple's "blast then correct" bug. | How-To Geek; Production Expert |
| 14 | Keep every deck's stretch ≤ ±6 %; TimePitch `overlap` 16–32; varispeed for tiny nudges. | Artifacts grow fast past ±8–10 %. | Mixxx dev notes; Apple TimePitch docs |
| 15 | After `AVAudioEngineConfigurationChange`, rebuild asynchronously from your own saved position; ignore completion callbacks that fired during the purge. | Prevents skipped tracks and false "track finished" after a Bluetooth/AirPlay switch. | Apple forums 769907 |
| 16 | Don't stream elapsed time to `MPNowPlayingInfoCenter` every second. | The system extrapolates; constant updates waste energy and can cause Lock Screen scrubber jitter. | Apple docs |
| 17 | Remove custom darkening behind the floating tab bar and toolbars; use `GlassEffectContainer` for grouped glass controls on the player. | The scroll-edge effect and glass sampling break otherwise. | WWDC25 323 |
| 18 | `List`/`LazyVStack` rows: constant view count, cached filter/sort, per-row `@Observable`, formatters created once. | 1,000+ songs stay inside the 8.3 ms budget. | WWDC23 10160, WWDC25 306 |
| 19 | Pre-warm the Now Playing view hierarchy (keep it alive offscreen with `opacity(0)` / `allowsHitTesting(false)`) instead of building it on tap. | Apple's iOS 27 "Now Playing loads faster" shows open latency is noticed. | MacRumors iOS 27 [INFERENCE for the technique] |
| 20 | Gate all ambient animation on Low Power Mode, thermal state, Reduce Motion and Auto-Play Animated Images. | Apple applies exactly these gates to animated artwork. | Apple animated-artwork doc |

---

## 6. Quick gap check against Benten's current code (from grep, no code changed)
Observed in `ios-native/Sources` on 2026-11-05. These are indicators only; the lead should verify.

**Already in place**
- Two decks with TimePitch and per-deck EQ (`pitchA/B`, `fxA/B`), bass swap, equal-power `sin/cos` curves (scaled ×0.82 in one style) and tempo crossing (Player.swift).
- Mix lengths of 8/16/32 beats; a same-album flag in the planner (AudioMath.swift).
- `tabViewBottomAccessory` with placement handling (BentenApp.swift:120, Views.swift:605).
- `CADisableMinimumFrameDurationOnPhone` and the `audio` background mode (Info.plist).
- ImageIO thumbnailing with `NSCache` (AppShell.swift); `TimelineView` backdrops at 1/30 s with Reduce Motion checks (CoverBackdrop.swift, LivingArtwork.swift).
- Custom springs in PlaybackClock.swift: response 0.24–0.5, damping 0.62–0.9. These are in the right range; the 0.62 press springs are bouncier than Apple's.

**Gaps relative to this document**
- No `isLowPowerModeEnabled`, `thermalState` or video-autoplay gating found.
- No `MPNowPlayingInfoProperty…AnimatedArtwork`.
- No `MeshGradient` (iOS 18+ path).
- No `.latency` / `outputPresentationLatency` / `outputLatency` compensation found.
- Loudness is RMS-based rather than gated LUFS with true-peak.
- No `.sensoryFeedback` / `UIFeedbackGenerator` found.
- `TimePitch.overlap` is left at its default of 8.

---

## 7. Source index (primary first)
- Apple Support — AutoMix/Crossfade: https://support.apple.com/en-gb/105067 · iPhone guide: https://support.apple.com/guide/iphone/aside/iphcba31c44b/ios
- Apple docs — animated artwork: https://developer.apple.com/documentation/mediaplayer/providing-animated-artwork-for-media-items · MPMediaItemAnimatedArtwork: https://developer.apple.com/documentation/mediaplayer/mpmediaitemanimatedartwork
- Apple docs — AVAudioPlayerNode: https://developer.apple.com/documentation/avfaudio/avaudioplayernode · AVAudioNode.latency / outputPresentationLatency · AVAudioSession.outputLatency · AVAudioUnitTimePitch rate/overlap
- Apple docs — ProMotion: https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays
- Apple docs — SwiftUI springs (snappy/bouncy), MeshGradient, TabViewBottomAccessoryPlacement, sensoryFeedback; UIKit `UIFeedbackGenerator.prepare()`; MPNowPlayingInfoPropertyElapsedPlaybackTime
- WWDC18 803 Designing Fluid Interfaces · WWDC18 219 Image and Graphics Best Practices · WWDC21 10252 Make blazing fast lists · WWDC23 10158 Animate with springs · WWDC23 10160 Demystify SwiftUI performance · WWDC25 256 What's new in SwiftUI · WWDC25 284 / 323 Build a UIKit/SwiftUI app with the new design · WWDC25 306 Optimize SwiftUI performance with Instruments
- Press: 9to5Mac (AutoMix iOS 26, iOS 27 AutoMix, 26.1 swipe, 26.4 albums, iOS 27 features) · MacRumors (iOS 27 Music; iOS 26 Lock Screen art) · How-To Geek (AutoMix review) · BGR (AutoMix, Apple safeguards) · heise (AutoMix) · TechRadar (cut endings) · Production Expert (−16 LUFS)
- Open source: AMLL https://github.com/amll-dev/applemusic-like-lyrics (lyric springs, mesh backdrop) · Mixxx manual Auto DJ https://manual.mixxx.org/2.5/en/chapters/djing_with_mixxx · Mixxx 2.3 intro/outro https://mixxx.org/news/2020-07-09-intro-outro-sections
- Community: Apple Developer Forums 708168 (TimePitch latency), 769907 / 772380 (configuration change), 14138 (sync start), 792835 (accessory → player) · coreaudio-api list 2005-12 (AUTimePitch 75.4 ms) · Timac iOS 18 census
