# Tip Track

Browser-based tool for tracking fencing sword tips and drawing neon trails behind them. MediaPipe
(hand or pose landmarks) runs in the browser on a webcam feed or a Cloudflare Stream video. For
video, detections can be turned into an editable keyframed "recorded" track, hand-corrected
frame by frame, and saved to Workers KV. The current goal is producing accurate source-of-truth
tracks; see `STATUS.md`.

Built with Astro and deployed to Cloudflare Workers.

## Running

```sh
npm install        # also copies the MediaPipe WASM runtime into public/mediapipe/wasm
npm run dev        # http://localhost:4321
```

The page starts in camera mode with **Hand Tracking** (index fingertip = sword tip). Open the
hamburger menu (top right) for controls.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with the Cloudflare runtime (workerd, local KV simulation) |
| `npm run check` | Type-check `.astro` and `.ts` files (`astro check`) |
| `npm test` | Unit tests (vitest) for the pure modules under `src/lib` |
| `npm run build` | Production build to `dist/` |
| `npm run deploy` | Build and `wrangler deploy` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

## Modes

**Source** - where pixels come from:

- `camera` - webcam via getUserMedia (mirrored, fills the viewport)
- `video` - Cloudflare Stream HLS manifest URL (`https://<host>/<uid>/manifest/video.m3u8`) or
  MP4, with a transport bar for play/pause, frame stepping and seeking

**Tracking mode** - where tip positions come from:

- `hand` - MediaPipe Hand Landmarker, index fingertip = tip (most stable for demos)
- `pose` - MediaPipe Pose Landmarker, tip estimated by extending the forearm vector
- `fencers` - two-person pose tracking with stable A/B identities (A = right side/green,
  B = left side/red). The weapon arm is the wrist furthest toward the opponent by default
  (per-fencer override: Auto / Right / Left). Blade length is a per-fencer forearm multiplier
  (default 4.4).
- `recorded` - video only: keyframed tracks with interpolation, editable in the keyframe editor

Debug modes (landmarks, skeleton, vectors, lightsaber, heatmap, ...) are selectable from the menu.

## Making a source-of-truth track

1. Choose **Video** source, paste a Stream manifest URL, Load.
2. Pick **Fencers** (or Hand/Pose) and play the clip to capture live tip samples.
3. **Generate Recorded Draft** converts the samples to keyframes (low-confidence samples dropped)
   and switches to **Recorded** mode.
4. Enable editing, step through frames, click to place or replace keyframes for the active track.
   Edits autosave to KV with a localStorage mirror.
5. Export JSON from the recorded panel to keep a file copy.

## Evaluating tracking against truth

In fencers mode, **Export Trace** downloads the per-inference-frame tips (plus upper-body pose
landmarks) for the current run. Score it against a hand-edited recorded export:

```sh
python3 scripts/evaluate_fencers_trace.py \
  --truth-json path/to/truth.json \
  --trace-json path/to/tiptrack-fencers-trace-<videoId>.json
```

Errors are reported in source-video pixels (mean/median/p90, and hit rates within 8/12/20 px).

## Code layout

```
src/
├── pages/
│   ├── index.astro               # the app page: markup shell + client wiring
│   └── api/tracks/               # KV-backed track library API (GET list, GET/PUT by videoId)
├── components/                   # ControlPanel.astro, Transport.astro
├── layouts/Layout.astro
├── lib/
│   ├── app/                      # state store, main loop, render modes, coordinate mapping,
│   │                             # overlay sizing, detector controller, fencer A/B tracker,
│   │                             # frame-rate detection, video sources (camera, URL)
│   ├── fencers/arm-selector.ts   # weapon-arm choice for fencers mode
│   ├── recorded/                 # track schema, interpolation, playback, keyframe editing,
│   │                             # auto-seed, localStorage store, KV client/repository
│   ├── detector.ts, hand-detector.ts, unified-detector.ts   # MediaPipe wrappers
│   ├── tip-estimator.ts          # forearm-extension tip estimate
│   ├── trail-manager.ts, renderer.ts, effects.ts
│   └── mediapipe-config.ts
└── types/fencing.ts
```

Pure modules under `src/lib` have vitest coverage; DOM-bound behaviour is checked manually.

## MediaPipe runtime

The JS library (`@mediapipe/tasks-vision`) and its WASM runtime must be the same version. The
WASM files are copied from `node_modules` into `public/mediapipe/wasm/` (gitignored) by
`scripts/copy-mediapipe-wasm.mjs` on `postinstall`, `predev` and `prebuild`, and loaded from
`/mediapipe/wasm`. Model `.task` files are fetched from Google's model storage.

## Recorded track library (KV)

- Track sets sync to Workers KV (`TRACKS` binding) through `/api/tracks`.
- A localStorage mirror keeps edits safe offline; sync retries later.
- Writes are public (no auth). Cloudflare Access is the intended hardening step.

## Docs

- `STATUS.md` - where things stand, findings so far, next steps
- `docs/history/` - earlier plans (original architecture, video-mode step plan, tracking upgrade
  plan), kept for reference
- Tag `archive/tip-refinement-experiments` - tip-refinement experiments (template matching,
  adaptive tuning, offline blade-line/ridge scripts, results log, Playwright trace runner)
