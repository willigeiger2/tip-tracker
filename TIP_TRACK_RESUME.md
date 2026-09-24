# Tip Track - Session Resumption Document

**Created**: April 24, 2026  
**Updated**: September 24, 2026 (video mode plan, step 1 foundation)  
**Status**: Phase 1 + Hand Tracking + UI Polish + iOS Fix + Perspective ✅  
**GitHub**: https://github.com/willi/tip-track  
**Next Step**: Execute `VIDEO_MODE_PLAN.md` - the current step-by-step plan for video playback,
frame jogging, recorded (keyframed) tracking and persistence. Read that first; the architecture
described below predates the step 1 refactor (logic now lives in `src/lib/app/`, and
`index.astro` is wiring only - see `README.md` for the current layout).

---

## Quick Start (For Resuming)

```bash
cd /Users/willi/src/personal/tip-track
npm run dev
# Open http://localhost:4321
```

**Default mode is Hand Tracking** - just click "Start Camera" and point your index finger!

---

## What's Working

- ✅ Camera access and video display
- ✅ **Hand tracking mode** (default) - index fingertip = sword tip
- ✅ **Pose tracking mode** - forearm vector estimation
- ✅ Runtime switching between modes
- ✅ 1-2 target detection (left=green, right=red)
- ✅ Neon trail rendering with glow
- ✅ **Perspective trails** - width varies with z-depth (closer = thicker)
- ✅ All 9 debug modes
- ✅ 60fps rendering with interpolation
- ✅ Adjustable trail length, inference rate
- ✅ **Fullscreen camera layout** (like magic-mirror)
- ✅ **Collapsible hamburger menu** for controls
- ✅ **Exo font styling** (from photo-explorer)
- ✅ Build succeeds, dev server runs
- ✅ **iOS coordinate alignment fixed** - works on iPhone portrait & landscape

---

## Recent Fix: iOS Coordinate Alignment (April 26, 2026)

**Problem**: Vertical misalignment on iPhone - landmarks matched at top of screen but drifted as you moved down.

**Root Cause**: iOS Safari has different viewport handling and video metadata timing than desktop Chrome. Using `window.innerWidth/Height` for canvas sizing didn't account for the dynamic viewport (address bar, toolbars).

**Solution**:
1. Use `window.visualViewport` API for accurate container dimensions on mobile
2. Fill full viewport with canvas (CSS `100dvh`, `position: fixed`)
3. Proper `object-fit: cover` coordinate mapping accounting for cropped regions
4. Multiple resize triggers for iOS's delayed video dimension reporting (`loadedmetadata`, `playing`, `resize` events + timeouts)

**Key Changes**:
- `resizeOverlayCanvas()` - Uses `visualViewport` when available
- `getVideoMapping()` - Calculates scale and crop offsets for proper coordinate transformation
- `mapToCanvas()` - Maps normalized video coords to screen coords accounting for cropping
- Renderers now use a pluggable coordinate mapper function

---

## Project Goal

Build a browser-based proof-of-concept for real-time fencing bout tracking with **dual tracking modes**:

### Mode 1: Pose Tracking (Original)
- Detects 1-2 fencers using MediaPipe Pose
- Estimates sword tip positions via forearm vector extension
- For future advanced features (body mechanics, reach analysis)

### Mode 2: Hand Tracking (Quick Demo Mode)
- Detects 1-2 hands using MediaPipe Hands
- **Tip of sword = tip of index finger (landmark 8)**
- Same trail rendering, same left/right assignment
- Much more stable for demos!

Both modes:
- Render glowing neon trails with fade effects
- Support multiple debug visualization modes
- Run at 60fps graphics with flexible inference rate (5-30fps)

---

## Key Decisions Summary

| Decision | Choice |
|----------|--------|
| **Detection methods** | MediaPipe Pose OR MediaPipe Hands (switchable) |
| **Hand mode tip** | Index finger tip (landmark 8) - direct mapping |
| **Pose mode tip** | Wrist + 1.5x forearm vector extension |
| **Model switching** | Runtime toggle with reinitialization |
| **Fencer count** | 1-2 fencers/hands (auto-detect, handle gracefully) |
| **Fencer colors** | Left side = Green (#00ff00), Right side = Red (#ff0000) |
| **Trail style** | Fixed length (60 points default), neon glow, fade |
| **Inference rate** | 5-30fps configurable, interpolate to 60fps render |
| **Model hosting** | Remote (MediaPipe CDN) |

---

## Architecture (Updated)

```
┌─────────────────────────────────────────────────────────────────┐
│ UI Layer (ControlPanel.astro)                                   │
│ - Tracking mode selector [POSE | HAND]                          │
│ - Debug mode selector                                           │
│ - Trail length slider                                           │
│ - Inference rate slider                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Detection Layer (5-30fps) - SWITCHABLE                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ Pose Mode    │  │ Hand Mode    │                             │
│  │ ├ PoseLandmarker              │                             │
│  │ ├ 33 landmarks/person         │                             │
│  │ └ TipEstimator (heuristic)    │                             │
│  │              │  │ ├ HandLandmarker              │             │
│  │              │  │ ├ 21 landmarks/hand           │             │
│  │              │  │ └ Tip = index finger (lm 8)   │             │
│  └──────────────┘  └──────────────┘                             │
│            │              │                                     │
│            └──────┬───────┘                                     │
│                   ▼                                             │
│         ┌──────────────────┐                                    │
│         │ Unified Output   │  TipPosition[]                    │
│         │ (model-agnostic) │                                    │
│         └──────────────────┘                                    │
│                   │                                             │
│                   ▼                                             │
│         ┌──────────────────┐                                    │
│         │ TrailManager     │  (unchanged)                      │
│         └──────────────────┘                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Rendering Layer (60fps) - UNCHANGED                             │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Overlay Canvas                                           │  │
│  │  ├─ TrailRenderer (neon trails)                         │  │
│  │  ├─ DebugRenderer (landmarks, skeleton/vectors)         │  │
│  │  └─ Lightsaber effect                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## File Structure (Updated)

```
tip-track/
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── wrangler.jsonc
├── README.md
├── src/
│   ├── pages/
│   │   └── index.astro           # Main app (model switching + coordinate mapping)
│   ├── layouts/
│   │   └── Layout.astro
│   ├── components/
│   │   └── (Astro components)
│   ├── lib/
│   │   ├── detector.ts           # Pose detection
│   │   ├── hand-detector.ts      # Hand detection
│   │   ├── unified-detector.ts   # Model-agnostic interface
│   │   ├── tip-estimator.ts      # Pose mode tip estimation
│   │   ├── trail-manager.ts      # Trail buffer management
│   │   ├── renderer.ts           # Trail & debug rendering (with coordinate mapping)
│   │   └── effects.ts            # Visual effects (flash, explosion)
│   └── types/
│       └── fencing.ts            # TypeScript interfaces
└── public/
```

---

## Hand Tracking Mode Details

### MediaPipe Hand Landmarker

- **21 landmarks per hand** (vs 33 for pose)
- **Index finger tip**: Landmark index 8
- **Handedness detection**: Built-in (returns 'Left' or 'Right')
- **Confidence scores**: Per-landmark visibility

### Landmark Indices (Key Points)

```
0: WRIST
4: THUMB_TIP
8: INDEX_FINGER_TIP    <-- SWORD TIP
12: MIDDLE_FINGER_TIP
16: RING_FINGER_TIP
20: PINKY_TIP
```

### Hand → Fencer Mapping

```typescript
// Hand landmarks give us handedness directly!
const handResults = handLandmarker.detectForVideo(video, timestamp);

for (const hand of handResults.handedness) {
  // hand[0].categoryName = 'Left' or 'Right' (the actual hand)
  // But we map to screen position for consistent colors:
  // Left side of screen = Green (Fencer A)
  // Right side of screen = Red (Fencer B)
}
```

---

## Debug Modes (Per Mode)

### Pose Mode
- `landmarks`: All 33 pose landmarks
- `skeleton`: Body connections
- `vectors`: Elbow→wrist→tip lines

### Hand Mode
- `landmarks`: All 21 hand landmarks
- `skeleton`: Finger connections
- `vectors`: Wrist→index_finger_mcp→tip

### Universal (Both Modes)
- `none`: Production (trails only)
- `tips-only`: Tip markers
- `trails-only`: Black background + trails
- `lightsaber`: Triangle blade effect
- `heatmap`: Color by velocity
- `all`: Everything

---

## Implementation Tasks

### 1. Create hand-detector.ts
- Initialize HandLandmarker
- Detect hands (1-2 max)
- Extract index finger tip
- Return unified format

### 2. Create unified-detector.ts
- Define TrackingMode: 'pose' | 'hand'
- Unified initialization interface
- Unified detection interface
- Model switching logic

### 3. Update ControlPanel.astro
- Add model selector dropdown
- "Tracking Mode: [Pose | Hand]"

### 4. Update index.astro
- Initialize based on selected mode
- Handle model switching (reinit)
- Pass appropriate landmarks to debug renderer

### 5. Update Debug Renderer
- Add hand skeleton rendering
- Add hand landmark rendering

---

## Why Hand Mode is Better for Demos

| Aspect | Pose Mode | Hand Mode |
|--------|-----------|-----------|
| **Tip accuracy** | Estimated (1.5x forearm) | Direct (index finger) |
| **Stability** | Body sway affects tip | Hand is stable relative to sword |
| **Setup** | Need full body in frame | Just hands visible |
| **Latency** | Lower confidence = drops | Higher confidence overall |
| **Use case** | Full bout analysis | Quick trail demos |

---

## Success Criteria (Updated)

- [x] Phase 1: Foundation complete
- [x] Hand tracking mode implemented
- [x] Model switching works at runtime
- [x] Hand mode: detects 1-2 hands
- [x] Hand mode: correct left/right assignment
- [x] Hand mode: index finger tip as sword tip
- [x] All debug modes work for both models
- [x] Trails render correctly in both modes
- [x] Can switch models without page reload

---

## Next Steps / Phase 2 Ideas

When you're ready to continue, here are some options:

### Option A: Polish & Bug Fixes
- Fix "trails get stuck" issue you mentioned
- Tune trail fade behavior
- Add trail persistence when detection drops
- Mobile browser testing

### Option B: Visual Enhancements
- Implement heatmap mode (color trails by velocity)
- Add trail persistence/ghosting options
- Custom color picker for trails
- Export trail data/screenshots

### Option C: Advanced Features
- Left/right hand detection (hand mode)
- Two-handed tracking (one person with two swords)
- On-screen calibration for tip estimation
- Distance/clash detection between fencers

### Option D: Deployment
- Deploy to Cloudflare Workers
- Add loading screen
- Error handling improvements
- Performance metrics display

---

**Ready to resume**: Just run `npm run dev` and open http://localhost:4321
