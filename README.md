# Tip Track

Browser-based proof of concept for tracking fencing sword tips and drawing neon trails behind
them. Runs MediaPipe (hand or pose landmarks) in the browser on a webcam feed; a video-playback
mode with manually keyframed "recorded" tracks is in progress (see `VIDEO_MODE_PLAN.md`).

Built with Astro and deployed to Cloudflare Workers.

## Running

```sh
npm install        # also copies the MediaPipe WASM runtime into public/mediapipe/wasm
npm run dev        # http://localhost:4321
```

The page asks for camera access and starts in **Hand Tracking** mode: the index fingertip is the
sword tip. Open the hamburger menu (top right) for controls.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with the Cloudflare runtime (workerd) |
| `npm run check` | Type-check `.astro` and `.ts` files (`astro check`) |
| `npm test` | Unit tests (vitest) for the pure modules under `src/lib` |
| `npm run build` | Production build to `dist/` |
| `npm run deploy` | Build and `wrangler deploy` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

## Modes

**Source** - where pixels come from:

- `camera` - webcam via getUserMedia (mirrored, fills the viewport)
- `video` - Cloudflare Stream HLS / MP4 URL (planned, step 2 of the plan)

**Tracking mode** - where tip positions come from:

- `hand` - MediaPipe Hand Landmarker, index fingertip = tip (default; most stable for demos)
- `pose` - MediaPipe Pose Landmarker, tip estimated by extending the forearm vector
- `recorded` - manually placed keyframes with cubic interpolation (planned, step 4; video only)

Debug modes (landmarks, skeleton, vectors + calibration grid, lightsaber, heatmap, ...) are
selectable from the menu and double as visual tests.

## Code layout

```
src/
├── pages/index.astro           # page shell + wiring only (DOM lookups, module construction, events)
├── components/ControlPanel.astro
├── lib/
│   ├── app/                    # application layer
│   │   ├── state.ts            # typed store for user-facing configuration
│   │   ├── main-loop.ts        # rAF loop: throttled detection, trails, clash flash, render
│   │   ├── render-modes.ts     # per-debug-mode overlay drawing
│   │   ├── coordinate-mapper.ts# normalized video coords -> overlay pixels (cover fit)
│   │   ├── overlay-sizing.ts   # keep the overlay canvas in sync with the viewport (iOS quirks)
│   │   ├── detector-controller.ts # load / switch MediaPipe models
│   │   └── sources/            # VideoSource interface + CameraSource
│   ├── detector.ts             # MediaPipe pose
│   ├── hand-detector.ts        # MediaPipe hands
│   ├── unified-detector.ts     # mode-agnostic detect()
│   ├── tip-estimator.ts        # forearm-vector tip estimate (pose mode)
│   ├── trail-manager.ts        # per-fencer trail ring buffers, identity tracking
│   ├── renderer.ts             # neon trail + debug rendering
│   └── effects.ts              # flash / explosion effects
└── types/fencing.ts
```

Pure modules (`coordinate-mapper`, `state`, `main-loop`, `detector-controller`) have vitest
coverage; DOM-bound modules are verified via the manual checklists in `VIDEO_MODE_PLAN.md`.

## MediaPipe runtime

The JS library (`@mediapipe/tasks-vision`) and its WASM runtime must be the same version. The
WASM files are copied from `node_modules` into `public/mediapipe/wasm/` (gitignored) by
`scripts/copy-mediapipe-wasm.mjs` on `postinstall`, `predev` and `prebuild`, and loaded from
`/mediapipe/wasm`. Model `.task` files are still fetched from Google's model storage.

## Docs

- `VIDEO_MODE_PLAN.md` - current step-by-step plan (video source, transport, recorded tracking,
  keyframe editor, persistence) with decisions, checklists and status log
- `TIP_TRACK_PLAN.md` - original architecture notes
- `TIP_TRACK_RESUME.md` - session-resumption notes
