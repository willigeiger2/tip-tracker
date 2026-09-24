# Tip Track - Video Mode & Recorded Tracking Plan

**Created**: 2026-09-24
**Status**: Planning complete, no steps started
**Baseline commit**: `1842306` (main)
**Related docs**: `TIP_TRACK_PLAN.md` (original architecture), `TIP_TRACK_RESUME.md` (session notes)

---

## 1. Purpose

Extend Tip Track so it can run on recorded video (Cloudflare Stream HLS) instead of only the
webcam, and add a third tracking mode where sword-tip positions come from manually placed,
cubically interpolated keyframes rather than live inference.

Why: the real goal (a trained model that finds sword tips) is a long way off. Recorded keyframes
let us demo what the finished system should look like now, and the labelled keyframes double as
training data later.

## 2. Vocabulary

| Term | Values | Meaning |
|---|---|---|
| **Source** | `camera` \| `video` | Where pixels come from. `camera` = getUserMedia (today's behavior). `video` = an HLS/MP4 URL played in the `<video>` element. |
| **Tracking mode** | `hand` \| `pose` \| `recorded` | Where tip positions come from. `hand`/`pose` = MediaPipe inference (today). `recorded` = interpolated keyframes. |
| **Keyframe** | `{ time, x, y }` | A manually placed tip position at a video time. Coordinates normalized 0-1 in source-video space. |
| **Track** | A \| B | One tracked tip. Reuses the existing fencer identities and colors (A = green, B = red). |
| **Track set** | | All tracks + metadata for one video, keyed by `videoId`. |

Validity matrix:

| | `hand` | `pose` | `recorded` |
|---|---|---|---|
| `camera` | yes (default) | yes | **no** (option disabled) |
| `video` | yes | yes | yes |

## 3. Decisions (locked)

These were agreed before planning. Change them here first if they need to change.

1. **Dependencies**: ~~minor bumps only~~ **Revised 2026-09-24**: Astro 7.3.x + @astrojs/cloudflare
   14.3.x + vite 8 (the `vite: ^7` override had to go). Rationale: `npm audit` reported 4
   advisories fixable only in Astro 7 and Astro 6 no longer receives security fixes; the upgrade
   proved clean (check/build/dev pass, 0 vulnerabilities). MediaPipe stays on 0.10.35; MediaPipe
   1.0 remains out of scope.
2. **Refactor**: step 1 includes a dedicated restructuring pass of `index.astro` into modules
   *before* feature work, with unit tests pinning behavior where practical.
3. **HLS playback**: native `<video>` HLS with feature detection. Chrome 142+ and Safari play HLS
   natively (verified against caniuse data 2026-09). Firefox/Edge do not; they get a clear
   "unsupported" message. No hls.js unless a decision gate in step 2 forces it.
4. **Paused/scrubbing behavior (live modes)**: inference stops when the video is not playing;
   existing trails fade out exactly as they do today when the camera stops. Seeking clears trails.
5. **Gaps in recorded tracks**: interpolate between consecutive keyframes only when they are
   within `maxGapSeconds` (default 1.0, adjustable). Otherwise the track is absent - nothing is
   rendered, same as when no hand is visible.
6. **Editing affordances (step 5)**: click-to-add at current frame, drag marker to move, delete at
   current frame, auto-advance N frames after placing, onion-skin neighbors. No undo/redo.
7. **Persistence**: localStorage first (step 4), Workers KV in step 7. One JSON document per
   video plus an index key.
8. **Write protection**: none for now; public writes are accepted during the demo phase.
   Cloudflare Access is the intended future answer.
9. **Test footage**: Willi provides a Cloudflare Stream HLS URL of fencing footage before step 2.
10. **Git workflow**: one branch + PR per step; Willi tests manually in the browser; merge after
    the checklist passes. Next step does not start until the previous one is merged.

Assumed defaults (not formally decided, change if wrong):

- Video mode is **not mirrored** and uses **contain** (letterbox) fit; camera stays mirrored + cover.
- Video is **muted**.
- URL entry: text field + `?video=<url>` query param for shareable demo links.
- `videoId` = Cloudflare Stream UID (32 hex chars) parsed from the URL; hash of the URL otherwise.
- Frame rate for stepping: HLS manifest `FRAME-RATE` -> `requestVideoFrameCallback` measurement
  -> 30 fps default; manual override always available.
- Transport shortcuts: Space play/pause, `←`/`→` = ±1 frame, `Shift+←/→` = ±1 s.
- Recorded-mode trails are synthesized from the interpolated curve over a trailing window (not
  from a ring buffer), so scrubbing is deterministic. Rendered with the existing `TrailRenderer`
  so they look identical to live modes.

## 4. Working agreements (how each step is executed)

For every step:

1. `git checkout main && git pull`, then `git checkout -b video-mode/step-N-<slug>`.
2. Implement only the tasks listed for that step. Discover something out of scope? Add it to
   section 9 (Backlog) instead of doing it.
3. Before opening the PR: `npm run check` (typecheck), `npm test`, `npm run build` all pass.
4. Open a PR on GitHub with the step's manual test checklist copied into the description.
5. Willi runs the manual checklist (desktop Chrome + Safari; iPhone where noted).
6. Address feedback, merge, then update the **Status log** (section 10) in this doc on `main`.

Constraints that apply to every step:

- Camera mode must keep working exactly as today. Any step that touches shared code re-runs the
  camera regression checklist (step 1, section 5).
- Pure logic (coordinate mapping, interpolation, id derivation, manifest parsing) lives in
  `src/lib/**` with no DOM dependency and gets vitest coverage.
- Never commit signed Stream tokens or account identifiers. Test URLs go in `.dev.vars` /
  local notes, not in the repo.
- The AI cannot drive a browser. Anything visual is verified by Willi via the checklist; the AI
  verifies typecheck, tests, build, and API behavior via `curl` against `astro dev`.
- **Willi starts and stops the dev server.** The AI never launches `astro dev` (or any long-running
  server) itself; when it needs a live server for `curl` checks it asks, states the port it
  expects, and says when it is finished.

## 5. Target architecture (after step 1)

```
src/
├── pages/
│   ├── index.astro              # markup shell + thin bootstrap (DOM lookup + wiring only)
│   └── api/tracks/...           # step 7
├── components/
│   ├── ControlPanel.astro       # the collapsible menu markup (moved out of index.astro)
│   └── Transport.astro          # step 3
├── lib/
│   ├── app/
│   │   ├── state.ts             # AppState: source, trackingMode, debugMode, config; change events
│   │   ├── main-loop.ts         # rAF loop lifecycle; schedules detection; dispatches render
│   │   ├── coordinate-mapper.ts # video<->screen mapping; fit: cover|contain; mirror flag (pure)
│   │   ├── render-modes.ts      # the debugMode switch, extracted from index.astro
│   │   └── sources/
│   │       ├── source.ts        # VideoSource interface (attach/detach/kind/mirrored/fit/isPlaying)
│   │       ├── camera-source.ts # getUserMedia (today's startCamera/stopCamera)
│   │       └── url-source.ts    # step 2: HLS/MP4 URL source
│   ├── recorded/                # step 4+
│   │   ├── types.ts             # Keyframe, RecordedTrack, RecordedTrackSet
│   │   ├── interpolator.ts      # cubic Hermite / Catmull-Rom in time; gap rule (pure)
│   │   ├── track-store.ts       # localStorage (step 4) + KV client (step 7)
│   │   └── video-id.ts          # deriveVideoId (pure)
│   ├── detector.ts              # unchanged
│   ├── hand-detector.ts         # unchanged (except WASM path)
│   ├── unified-detector.ts      # unchanged
│   ├── tip-estimator.ts         # unchanged
│   ├── trail-manager.ts         # unchanged
│   ├── renderer.ts              # unchanged
│   └── effects.ts               # unchanged
└── types/fencing.ts             # TrackingMode gains 'recorded' in step 4
```

The bootstrap in `index.astro` should end up ~150 lines: get DOM elements, construct state +
sources + loop, bind UI events to state changes. All behavior lives in `src/lib`.

---

## 6. Steps

### Step 1 - Foundation: dependencies, tooling, refactor

**Branch**: `video-mode/step-1-foundation`
**Goal**: A codebase that type-checks, has a test runner, has no known latent breakage, and is
structured so that adding a source and a tracking mode touches small, obvious places. **No
behavior change.**

Tasks:

- [x] Dependencies: `astro@^7.3`, `@astrojs/cloudflare@^14.3` (vite 8; `overrides.vite` removed),
      `@mediapipe/tasks-vision@0.10.35`, `wrangler@^4.138`. Regenerate `worker-configuration.d.ts`
      (`npm run cf-typegen`). `npm audit`: 0 vulnerabilities.
- [ ] Typecheck: add `@astrojs/check` + `typescript`; script `"check": "astro check"`. Fix every
      reported error. Known: `src/env.d.ts` uses `Runtime<Env>` but adapter 13's `Runtime` is not
      generic (it is `{ cfContext }`); `locals.runtime.env` no longer exists in Astro 6 - bindings
      come from `import { env } from 'cloudflare:workers'`.
- [ ] Tests: add `vitest`; script `"test": "vitest run"`. Write tests for `coordinate-mapper`
      **before** moving the code (pin cover-fit math: wider-than-container, taller-than-container,
      equal aspect; corners map to expected screen points).
- [ ] MediaPipe WASM parity: JS is `0.10.34/35` but WASM is loaded from jsdelivr pinned at
      `0.10.0`. Self-host: copy `node_modules/@mediapipe/tasks-vision/wasm/*` to
      `public/mediapipe/wasm/` (postinstall or prebuild script, directory gitignored) and point
      `FilesetResolver.forVisionTasks()` at it in both detectors. Model `.task` files stay remote
      for now (large); note as backlog.
- [ ] Refactor `index.astro` into the layout in section 5. Extract in this order, running the
      camera checklist mentally between each: (a) `coordinate-mapper.ts`, (b) `state.ts`,
      (c) `sources/source.ts` + `camera-source.ts`, (d) `render-modes.ts`, (e) `main-loop.ts`,
      (f) `ControlPanel.astro`. Keep names of DOM ids stable.
- [ ] Introduce the `VideoSource` interface now, with only `CameraSource` implementing it:
      `attach(video): Promise<void>`, `detach(): void`, `kind`, `mirrored: boolean`,
      `fit: 'cover' | 'contain'`, `isPlaying(): boolean`. The main loop asks the source whether
      to run inference this frame.
- [ ] Replace the `hasActiveTrails` loop-start heuristic with an explicit `isLoopRunning` flag.
- [ ] README: replace the Astro starter template with a real README (what it is, modes, how to
      run, how to deploy, link to this plan). Update `TIP_TRACK_RESUME.md` to point here.

Out of scope: any new UI, any behavior change, Astro/MediaPipe majors.

Definition of done:

- `npm run check`, `npm test`, `npm run build` pass.
- `index.astro` script is wiring only; no rendering or detection logic remains in it.
- Manual camera regression checklist below passes on desktop Chrome, desktop Safari, iPhone Safari.

Manual test checklist (camera regression - reused by later steps):

- [ ] Page loads, camera starts automatically, hand mode trails follow index fingertip.
- [ ] Two hands: left = green, right = red; identities stick when hands cross.
- [ ] Switch to Pose mode: model reloads, trails follow estimated tip; switch back to Hand.
- [ ] Each of the 9 debug modes renders without console errors. Vectors mode grid corners sit
      exactly on the video corners (this is the iOS alignment fix).
- [ ] Trail length slider and inference rate slider take effect live.
- [ ] Clear Trails clears; Stop Camera fades trails out; Start Camera resumes.
- [ ] Bring two fingertips together: flash effect fires (once per second max).
- [ ] iPhone portrait and landscape: landmarks align with the mirrored video top to bottom.
- [ ] Menu opens/closes; clicking outside closes it.

Risks / notes:

- Refactor regressions are the main risk; the checklist above is the safety net. Keep each
  extraction its own commit so a regression can be bisected.
- `astro check` may surface many `any`-typed landmark params in `renderer.ts`; fixing types is in
  scope only where cheap - otherwise annotate and move on.

---

### Step 2 - Video source (HLS URL) with live inference

**Branch**: `video-mode/step-2-video-source`
**Goal**: Choose "Video" as the source, paste a Cloudflare Stream HLS URL, and run the existing
hand/pose inference on the footage exactly as with the camera.

Tasks:

- [ ] `url-source.ts` implementing `VideoSource`: sets `video.crossOrigin = 'anonymous'`,
      `video.src = url`, `muted`, `playsinline`; `mirrored = false`; `fit = 'contain'`.
      Feature-detect `video.canPlayType('application/vnd.apple.mpegurl')` for `.m3u8` URLs; if
      unsupported (Firefox/Edge), surface a clear status message and do not attempt playback.
- [ ] `coordinate-mapper.ts`: support `fit: 'contain'` (letterbox offsets). Unit tests for
      contain math; inverse mapping (`screen -> normalized`) added now with tests - step 5 needs it.
- [ ] Mirroring becomes a class toggled per source (`.mirrored`) on both `<video>` and overlay
      canvas, instead of hard-coded CSS.
- [ ] `video-id.ts`: `deriveVideoId(url)` - Stream UID (`/[0-9a-f]{32}/` in path) else hash.
      Unit tests for Stream manifest URL, `watch.videodelivery.net` URL, arbitrary MP4 URL.
- [ ] UI: "Source" select (Camera | Video URL) at the top of the control panel. Video-only group:
      URL input + Load button. Camera-only controls hidden in video mode. `?video=` query param
      pre-fills and auto-loads.
- [ ] Temporary playback control: set the native `controls` attribute on `<video>` in video mode
      (overlay canvas has `pointer-events: none`, so native controls are clickable). Removed in
      step 3.
- [ ] Inference gating: run detection only when `source.isPlaying()` is true
      (`!paused && !ended && !seeking && readyState >= 2`). When not playing, detections stop and
      trails fade via existing `fadeAllTrails()`. On `seeking` event: `trailManager.clear()`.
- [ ] Status line shows video dimensions and playback state.
- [ ] Switching Video -> Camera detaches the URL source (pause, remove src, `load()`), restores
      mirrored cover fit, restarts camera.

**Decision gate (do first, before the rest of the step)**: confirm MediaPipe can consume frames
from a natively-played cross-origin HLS video in both Chrome and Safari. Cross-origin video
without proper CORS taints WebGL uploads and inference throws. Stream sends `Access-Control-Allow-
Origin: *`, and `crossorigin="anonymous"` should be enough, but Safari has historically been
stricter with native HLS. Outcomes:

- Works in both -> proceed as planned.
- Fails in one -> options in order: (1) Stream MP4 download URL for that browser, (2) add hls.js
  (MSE-fed video is never tainted), (3) document the browser as unsupported. Record the outcome
  in the status log.

Out of scope: custom transport, frame stepping, recorded mode.

Definition of done:

- `check`/`test`/`build` pass. Camera regression checklist still passes.
- Manual checklist below passes in Chrome and Safari on the provided Stream footage.

Manual test checklist:

- [ ] Select Video, paste the Stream HLS URL, Load: video appears letterboxed, not mirrored.
- [ ] Press play (native controls): hand-mode trails appear on the fencers' hands in the footage.
- [ ] Switch to Pose mode while playing: pose trails appear; switch back.
- [ ] Pause: inference stops (fps counter still ticks, trails fade out). Play: trails resume.
- [ ] Scrub with the native slider: trails clear immediately, then rebuild after play.
- [ ] Switch back to Camera: mirrored camera view, trails follow your hand again.
- [ ] Load via `?video=<url>`: auto-loads without touching the menu.
- [ ] Firefox: selecting Video and loading an `.m3u8` shows the unsupported message, no errors.
- [ ] Vectors debug mode in video mode: grid corners sit on the letterboxed video's corners.

---

### Step 3 - Transport bar with frame-accurate jog

**Branch**: `video-mode/step-3-transport`
**Goal**: Replace native controls with a transport bar that can pause, seek, and step exactly one
frame forward/backward, so keyframes can later be placed on the right frame.

Tasks:

- [ ] `Transport.astro` floating bar (bottom center, video mode only): play/pause, step -1,
      step +1, seek slider, readout `m:ss.s / m:ss.s  f<frame>`, fps badge (click to override).
- [ ] `frame-rate.ts` (pure + one fetch): (1) fetch the HLS master manifest as text and parse
      `FRAME-RATE=` from `#EXT-X-STREAM-INF` (Stream includes it for most encodes - verify on the
      test footage); (2) fallback: measure with `requestVideoFrameCallback` during playback
      (median of `mediaTime` deltas over >=12 frames, ignoring gaps > 250 ms); (3) fallback 30.
      Manual override stored per `videoId` in localStorage. Unit tests for the manifest parser.
- [ ] Frame math helpers (pure, tested): `frameIndex(t, fps) = round(t * fps)`;
      `seekToFrame(f, fps)` targets `(f + 0.5) / fps` so the browser reliably presents frame `f`
      rather than a boundary. Clamp to `[0, duration]`.
- [ ] `stepFrames(n)`: pause, then seek to `frameIndex(currentTime) + n`.
- [ ] Keyboard (ignored when focus is in an input/select): Space play/pause, `←`/`→` ±1 frame,
      `Shift+←/→` ±1 s, `Home`/`End`.
- [ ] Remove the native `controls` attribute from step 2.
- [ ] Seek slider: while dragging, do not fight `timeupdate`; commit on release.
- [ ] Inference/trails: unchanged from step 2 gating (inference only while playing; pause fades;
      seek/step clears).

Out of scope: recorded mode, editing.

Definition of done:

- `check`/`test`/`build` pass. Camera regression passes (transport hidden in camera mode).
- Manual checklist passes; stepping is frame-exact on the test footage.

Manual test checklist:

- [ ] fps badge shows a plausible rate for the Stream footage (e.g. 25, 30, 50, 60). Override to a
      wrong value and back; stepping distance changes accordingly.
- [ ] Pause. Step +1 ten times: the image changes on every step (no repeated frames). Step -1 ten
      times: back to the identical starting frame (readout shows the same `f<frame>`).
- [ ] `→` / `←` keys behave like the buttons; `Shift+→` jumps ~1 s; Space toggles play.
- [ ] Dragging the seek slider scrubs; releasing lands where the thumb is; trails are cleared.
- [ ] Playing then pausing: trails fade out; stepping while faded shows no stale trails.
- [ ] Transport bar never overlaps the menu; not visible in camera mode.

Risks / notes:

- If the manifest lacks `FRAME-RATE`, rVFC measurement needs ~0.5 s of playback before the badge
  updates; show `~30` with a tilde until measured.
- Variable-frame-rate sources break the `round(t * fps)` assumption. Stream re-encodes to CFR,
  so this is acceptable; note in the UI if measured deltas are noisy.

---

### Step 4 - Recorded tracking mode (data model, interpolation, playback)

**Branch**: `video-mode/step-4-recorded-mode`
**Goal**: A third tracking mode that renders tips and trails from stored keyframes instead of
inference. No editing UI yet; data is seeded via JSON import and stored in localStorage.

Tasks:

- [ ] `TrackingMode = 'hand' | 'pose' | 'recorded'`. Tracking Mode select gains "Recorded Points
      (video only)"; the option is disabled when source is camera. Switching source to camera
      while in recorded mode auto-switches to hand.
- [ ] `recorded/types.ts` - see section 7 for the schema (versioned, `version: 1`).
- [ ] `recorded/interpolator.ts` (pure, well tested): `sample(track, t): {x, y} | null` using
      cubic Hermite with Catmull-Rom (finite-difference) tangents in the time domain; keyframes
      farther apart than `maxGapSeconds` split the track into independent runs (tangents never
      cross a gap); `t` outside all runs -> `null`; exactly on a keyframe -> that keyframe's
      position. `sampleTrail(track, t, windowSeconds, n): TrailPoint[]` samples within the same run
      only. Tests: passes through keyframes; C1 continuity check at joints (numerical derivative);
      gap rule; single keyframe; out of range; two keyframes reduce to a straight line.
- [ ] `recorded/track-store.ts`: localStorage backend keyed `tiptrack:v1:tracks:<videoId>`;
      `load(videoId)`, `save(set)`, schema validation on load (reject/repair bad data).
- [ ] Main loop in recorded mode: skip MediaPipe entirely. Each render frame: `t =
      video.currentTime`; per track compute tip and synthesized trail; build the `Fencer` map;
      render via existing `TrailRenderer` (`renderTrails`, `renderTipDots`). Clash flash works
      when A and B tips are within `CLASH_DISTANCE`. Trail length slider controls sample count;
      trail window default 1.0 s.
- [ ] Initial state with no keyframes: nothing rendered (parity with "no hand visible").
- [ ] Debug modes in recorded mode: `none`, `tips-only`, `trails-only`, `heatmap` work;
      `landmarks`/`skeleton`/`vectors`/`lightsaber`/`all` degrade to trails+tips (there are no
      landmarks). Document in the hint text.
- [ ] Recorded panel (video mode only): Import JSON (paste/file) and Export JSON (download).
      These stay as permanent features (training-data round trip) and are how step 4 is tested.
- [ ] Deterministic under scrubbing: seeking/stepping re-synthesizes the trail from the curve;
      no ring-buffer state to clear.

Out of scope: click-to-add editing, remote storage.

Definition of done:

- `check`/`test`/`build` pass. Camera regression passes. Recorded option disabled for camera.
- Import a hand-authored JSON (a dozen keyframes per track on the test footage) and the trails
  play back smoothly and survive reload.

Manual test checklist:

- [ ] With source = camera, "Recorded Points" is disabled in the mode select.
- [ ] Source = video, mode = recorded, no data: nothing rendered, no errors.
- [ ] Import JSON: on play, green and red trails sweep smoothly through the keyframe positions;
      the tip dot sits exactly on a keyframe at that keyframe's frame.
- [ ] Step frame-by-frame across a keyframe: tip lands on it; neighbors are smoothly between.
- [ ] Two keyframes > `maxGapSeconds` apart: nothing rendered in between; trail restarts cleanly.
- [ ] Before the first keyframe and after the last: nothing rendered.
- [ ] Scrub backwards: trail shows the last 1 s *before* the new time, not stale points.
- [ ] Reload the page with the same `?video=`: recorded data restored from localStorage.
- [ ] Export JSON downloads a file that re-imports identically.

---

### Step 5 - Keyframe editor

**Branch**: `video-mode/step-5-keyframe-editor`
**Goal**: Place, move, and delete keyframes by pointing at the paused video frame, fast enough to
label a clip in minutes.

Tasks:

- [ ] "Edit keyframes" toggle (video + recorded mode only). When on: overlay canvas gets
      `pointer-events: auto` and a crosshair cursor; clicking the video no longer collapses the
      menu.
- [ ] Active track selector: A (green) / B (red).
- [ ] Click on the video: if playing, pause first; then add a keyframe for the active track at
      the current frame at the clicked position (inverse-mapped to normalized coords, clamped
      0-1). If a keyframe already exists at that frame index for the track, replace it.
- [ ] Drag: pointer-down within ~18 px of an existing marker (any track) grabs it, seeks to its
      frame, makes its track active, and drags it; release commits.
- [ ] Delete: `Delete`/`Backspace` key or a button removes the active track's keyframe at the
      current frame.
- [ ] Auto-advance: after placing a keyframe, step forward N frames (N in {0 (off), 1, 2, 5, 10},
      default 2). Persist choice.
- [ ] Onion-skin: draw the previous and next keyframes of the active track as faint diamonds with
      a dashed connector; current-frame keyframe drawn bright with a white ring; other tracks'
      markers dimmer. Markers only while edit mode is on.
- [ ] Keyframe list (per active track) in the panel: time + frame, click to jump, small delete
      per row. `[` / `]` jump to previous/next keyframe.
- [ ] Every change autosaves to localStorage (debounced ~500 ms); save status line.
- [ ] "Clear track" with confirm.

Out of scope: remote storage, undo/redo, zoom.

Definition of done:

- `check`/`test`/`build` pass. Camera regression passes.
- Labelling 10 s of the test footage for both tracks at auto-advance 2 takes < 5 minutes.

Manual test checklist:

- [ ] Edit toggle off: clicks on the video do nothing (menu collapses as before).
- [ ] Edit on, click the tip on a paused frame: marker appears exactly under the pointer; video
      advances N frames; list gains a row.
- [ ] Click again on the same frame (auto-advance 0): the marker moves instead of duplicating.
- [ ] Drag a marker: it follows the pointer; the video jumps to that marker's frame when grabbed.
- [ ] Delete removes only the current-frame keyframe of the active track.
- [ ] Onion-skin shows previous/next markers; the connector updates as you edit.
- [ ] Switch active track: markers of the other track dim; new clicks go to the new track.
- [ ] Turn edit off, play: trails render through the new points (step 4 behavior).
- [ ] Reload: everything persisted.
- [ ] iPhone: not required for the editor; must not break camera mode.

---

### Step 6 - Rendering fidelity and labelling pass

**Branch**: `video-mode/step-6-fidelity`
**Goal**: Prove the end-to-end demo on real footage and fix whatever the first full labelling pass
reveals. This is a hardening step; expect small changes across the recorded modules.

Tasks:

- [ ] Label a complete exchange (10-20 s) on the test footage, both tracks, at the chosen
      auto-advance. Record how long it took and what was annoying in the status log.
- [ ] Compare recorded-mode trails side by side with hand-mode trails on the same clip: width,
      glow, fade, tip dot size should be indistinguishable. Tune the synthesized trail's sample
      spacing / window if not.
- [ ] Check spline behavior on fast lunges (overshoot between sparse keyframes). If overshoot is
      visible, add a `tension` parameter (default 1.0 = Catmull-Rom) to the interpolator and
      expose it in the panel.
- [ ] Edge cases: seek during play; switching hand -> recorded -> hand mid-play; changing trail
      length live; `maxGapSeconds` change re-renders immediately.
- [ ] Performance: recorded mode holds 60 fps with two tracks and a 60-sample trail.
- [ ] Export JSON reviewed as a plausible training-label format (includes `fps`, frame indices
      derivable, normalized coords, video id/url).
- [ ] Update `TIP_TRACK_RESUME.md` with a "how to demo" section.

Definition of done:

- Willi can load the footage via `?video=`, switch to recorded mode, press play, and the demo
  looks like the finished product. Anything short of that is a bug fixed in this step.

Manual test checklist: the demo script itself, run in Chrome and Safari:

- [ ] Open `?video=<url>`, select Recorded, play: two smooth neon trails follow the sword tips for
      the whole labelled exchange; flash fires on the blade contact.
- [ ] Pause anywhere, step back and forth: tip dot stays on the blade.
- [ ] Switch to Hand mode on the same clip: live inference trails for comparison.

---

### Step 7 - Persistent storage (Workers KV)

**Branch**: `video-mode/step-7-kv-storage`
**Goal**: Track sets survive across devices and browsers, keyed by `videoId`, with a list of saved
videos in the UI.

Tasks:

- [ ] `wrangler.jsonc`: `kv_namespaces: [{ binding: "TRACKS", id: "<created id>" }]`. Create with
      `wrangler kv namespace create TRACKS`. `astro dev` (via `@cloudflare/vite-plugin`) simulates
      KV locally with no extra config. Regenerate types.
- [ ] API routes (`export const prerender = false`), bindings via
      `import { env } from 'cloudflare:workers'`:
      - `GET /api/tracks` -> `RecordedTrackSetSummary[]` from `tracks:index`
      - `GET /api/tracks/:videoId` -> `RecordedTrackSet` or 404
      - `PUT /api/tracks/:videoId` -> validate schema (`version`, `videoId` matches path, tracks
        array, keyframes sorted/finite), preserve `createdAt`, set `updatedAt`, write
        `tracks:<videoId>`, upsert `tracks:index`. Last write wins.
      - Payload cap (e.g. 1 MB) and JSON error responses.
- [ ] `track-store.ts` gains a KV client. Load order on video load: KV -> localStorage -> empty.
      Save: debounced `PUT` + localStorage mirror (offline safety). Status line: "Saved
      HH:MM:SS" / "Saved locally (offline)" / "Save failed".
- [ ] Saved videos panel: list from `GET /api/tracks` (title = last URL path segment or UID,
      keyframe count, updated date) with Load.
- [ ] Verify locally with `curl` against `astro dev`: PUT, GET, list, 404, invalid payload -> 400.
- [ ] Deploy (`npm run deploy`) and repeat the checks against the workers.dev URL.
- [ ] Document in README: public writes, no auth, Access is the intended fix (Backlog).

Definition of done:

- `check`/`test`/`build` pass; curl checks pass locally and deployed.
- Label on one browser, open the same `?video=` on another device: tracks are there.

Manual test checklist:

- [ ] Save from desktop Chrome; open in Safari (or the phone): same trails.
- [ ] Kill the network, edit: status shows "Saved locally"; restore network, edit again: status
      shows "Saved"; reload from another browser shows the latest edit.
- [ ] Saved videos list shows the footage; Load switches URL and restores tracks.
- [ ] A bogus `PUT` (curl) is rejected with 400 and does not corrupt the index.

---

## 7. Data model (recorded tracks)

```ts
interface Keyframe {
  time: number;   // seconds, media time of the video
  x: number;      // 0-1, normalized to the source video frame width
  y: number;      // 0-1, normalized to the source video frame height
}

interface RecordedTrack {
  id: 'A' | 'B';
  label: string;        // "Track A"
  color: string;        // '#00ff00' | '#ff0000' - matches fencer colors
  keyframes: Keyframe[]; // sorted by time; at most one per frame index
}

interface RecordedTrackSet {
  version: 1;
  videoId: string;       // Stream UID or url hash
  videoUrl: string;
  fps: number;           // frame rate used while labelling; frame = round(time * fps)
  maxGapSeconds: number; // interpolation gap rule, default 1.0
  createdAt: number;     // epoch ms
  updatedAt: number;     // epoch ms
  tracks: RecordedTrack[];
}

interface RecordedTrackSetSummary {
  videoId: string; videoUrl: string; updatedAt: number; keyframeCount: number;
}
```

Invariants: keyframes sorted ascending by `time`; adding at an occupied frame index replaces;
coordinates clamped to `[0, 1]`; `fps` stored so frame indices can be reconstructed for training
export even if detection changes later.

Storage keys:

- localStorage: `tiptrack:v1:tracks:<videoId>`, `tiptrack:v1:fps:<videoId>` (override)
- KV: `tracks:<videoId>`, `tracks:index`

## 8. Interpolation spec

- Split each track's keyframes into **runs**: consecutive keyframes with
  `time[i+1] - time[i] <= maxGapSeconds`.
- Within a run of >= 2 keyframes, position at `t` is a cubic Hermite spline per segment with
  Catmull-Rom tangents `m_i = ((p_{i+1} - p_i)/dt_next + (p_i - p_{i-1})/dt_prev) / 2`, one-sided
  at run ends. This is C1-continuous and handles uneven keyframe spacing.
- A run of exactly 1 keyframe renders the tip only at that frame (±half a frame), nothing else.
- `t` outside every run -> `null` (nothing rendered).
- Trail at `t`: sample `n` points over `[t - window, t]`, dropping samples that fall outside the
  current run, oldest -> newest, opacity ramp handled by the existing renderer.

## 9. Backlog (explicitly not scheduled)

- Compare mode: run live inference **and** recorded ground truth on the same clip, show per-frame
  error. The first real evaluation harness for a future model.
- Training export: frames + labels (ffmpeg frame extraction at the stored `fps`), COCO-style JSON.
- Cloudflare Access in front of the deployment (write protection).
- hls.js fallback for Firefox/Edge, or Stream MP4 download URLs.
- "Not visible" keyframe type for explicit gaps.
- More than two tracks / custom labels and colors.
- Self-host MediaPipe `.task` model files.
- MediaPipe 1.0 upgrade (Astro 7 / adapter 14 done in step 1).
- Verify `npm run deploy` against the adapter's emitted `dist/client/wrangler.json` (the build is
  fully static today and deploy has likely never been run) - folded into step 7.
- Undo/redo in the editor; zoom for precision placement.

## 10. Status log

| Date | Step | Event / outcome |
|---|---|---|
| 2026-09-24 | - | Plan agreed. Baseline `1842306`. HLS: native (Chrome 142+, Safari) confirmed via caniuse; Firefox/Edge unsupported. |
| 2026-09-24 | - | Willi confirmed: step 2 MediaPipe-on-HLS decision gate is a genuine unknown (test first); seek/step clears trails while pause fades them; step 1 is strictly behavior-preserving. |
| 2026-09-24 | 1 | Branch `video-mode/step-1-foundation`. Deps bumped, `astro check` + vitest added, MediaPipe WASM self-hosted (was 0.10.0 WASM under 0.10.34 JS). `npm audit fix --force` moved to Astro 7 / adapter 14; kept after verifying clean (decision 1 revised). Audit: 4 -> 0 vulnerabilities. Build output is fully static (page prerendered). |

## 11. Reference facts (verified during planning)

- `@astrojs/cloudflare@13`: `Astro.locals.runtime.env` **throws** ("removed in Astro v6"); use
  `import { env } from 'cloudflare:workers'`. Execution context is `Astro.locals.cfContext`.
  Dev server runs inside workerd via `@cloudflare/vite-plugin`, so bindings work in `astro dev`.
- `worker-configuration.d.ts` declares `cloudflare:workers` with `export const env: Cloudflare.Env`;
  a KV binding added to `wrangler.jsonc` + `wrangler types` yields `env.TRACKS: KVNamespace`.
- MediaPipe: npm `@mediapipe/tasks-vision@0.10.34` installed; both detectors load WASM from
  `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm` (version mismatch).
- Outdated (2026-09-24): astro 6.1.9 (wanted 6.4.8, latest 7.3.5); @astrojs/cloudflare 13.2.1
  (13.7.0 / 14.3.3); @mediapipe/tasks-vision 0.10.34 (0.10.35 / 1.0.1); wrangler 4.85.0 (4.138.0).
- No `@astrojs/check`, `typescript`, or test runner installed at baseline.
