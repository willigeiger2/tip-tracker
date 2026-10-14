# Tip Track - Implementation Plan

> Historical: original architecture notes from the first prototype. See `../../STATUS.md` for current status.

## Project Overview

A browser-based proof-of-concept for real-time fencing bout tracking with neon trail visualization. Uses MediaPipe Pose for body landmark detection and estimates sword tip positions via forearm vector extension.

**Goal**: Track two fencers, visualize their sword tips with glowing neon trails, support multiple debug/vis modes.

**Future**: Migrate to Cloudflare Workers for edge inference and multi-user sessions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              UI Layer                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │
│  │ Debug Mode   │ │ Trail Length │ │ Effect       │ │ Inference Rate     │  │
│  │ Selector     │ │ Slider       │ │ Toggle       │ │ Slider (5-30fps)   │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Rendering Layer (60fps)                            │
│                                                                              │
│   ┌─────────────────────┐     ┌──────────────────────────────────────────┐ │
│   │ Video Canvas        │────▶│ WebGL Effect Shader (optional)           │ │
│   │ (hidden video elem) │     │ - Pass-through (default)                 │ │
│   └─────────────────────┘     │ - Effects: lightsaber, matrix, etc.      │ │
│                               └──────────────────────────────────────────┘ │
│                                        │                                     │
│   ┌──────────────────────────────────────────────────────────────────┐    │
│   │ Overlay Canvas (pointer-events: none)                            │    │
│   │                                                                  │    │
│   │  ┌─────────────┐  ┌─────────────┐                               │    │
│   │  │ Fencer A    │  │ Fencer B    │                               │    │
│   │  │ (Left/Green)│  │ (Right/Red) │                               │    │
│   │  │             │  │             │                               │    │
│   │  │    ═══════  │  │  ═══════    │  ← Neon trails                │    │
│   │  │         ●   │  │   ●         │  ← Triangle tip (lightsaber)  │    │
│   │  └─────────────┘  └─────────────┘                               │    │
│   └──────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Detection Layer (5-30fps)                             │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────┐      │
│   │ MediaPipe Pose                                                  │      │
│   │ - Model: pose_landmarker_lite (remote CDN)                      │      │
│   │ - 2 poses max (numPoses: 2)                                     │      │
│   │ - Returns 33 landmarks per pose                                 │      │
│   └─────────────────────────────────────────────────────────────────┘      │
│                                       │                                      │
│   ┌─────────────────────────────────────────────────────────────────┐      │
│   │ Tip Estimator (Heuristic)                                       │      │
│   │                                                                 │      │
│   │  Input: wrist (landmark 15/16), elbow (landmark 13/14)          │      │
│   │         Pose: x,y,z coordinates                                 │      │
│   │                                                                 │      │
│   │  Vector: elbow → wrist (forearm direction)                      │      │
│   │                                                                 │      │
│   │  Extension: wrist + (vector × multiplier)                       │      │
│   │             where multiplier = forearm_length × 1.5             │      │
│   │             (object space - relative to detected joint distance)│      │
│   │                                                                 │      │
│   │  Output: tip_x, tip_y, confidence, side (left/right of frame)   │      │
│   └─────────────────────────────────────────────────────────────────┘      │
│                                       │                                      │
│   ┌─────────────────────────────────────────────────────────────────┐      │
│   │ Trail Manager (per fencer)                                      │      │
│   │                                                                 │      │
│   │  - Ring buffer: last 60 positions (configurable)                │      │
│   │  - Interpolation targets for smooth 60fps rendering             │      │
│   │  - Side assignment: left/right based on x-position in frame     │      │
│   └─────────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
tip-track/
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── wrangler.jsonc
├── README.md
├── src/
│   ├── pages/
│   │   └── index.astro          # Main app entry
│   ├── layouts/
│   │   └── Layout.astro         # HTML wrapper
│   ├── components/
│   │   ├── ControlPanel.astro   # UI controls
│   │   └── CanvasOverlay.astro  # Video + overlay canvases
│   ├── lib/
│   │   ├── detector.ts          # MediaPipe Pose initialization
│   │   ├── tip-estimator.ts     # Sword tip position calculation
│   │   ├── trail-manager.ts     # Trail buffer management
│   │   ├── renderer.ts          # Canvas2D trail rendering
│   │   └── debug-renderer.ts    # Debug visualization modes
│   ├── shaders/
│   │   ├── vertex.glsl          # Pass-through vertex shader
│   │   └── fragment.glsl        # Effects (lightsaber, etc.)
│   └── types/
│       └── fencing.ts           # TypeScript interfaces
├── public/
│   └── (static assets)
└── dist/                        # Build output
```

---

## Data Types

```typescript
// src/types/fencing.ts

interface Landmark {
  x: number;        // 0-1 normalized
  y: number;
  z: number;
  visibility: number;  // confidence 0-1
}

interface Pose {
  landmarks: Landmark[];  // 33 MediaPipe landmarks
  worldLandmarks: Landmark[];
  score: number;  // overall pose confidence
}

interface TipPosition {
  x: number;        // 0-1 normalized
  y: number;
  confidence: number;
  timestamp: number;
  side: 'left' | 'right';  // assigned based on frame position
}

interface TrailPoint {
  x: number;
  y: number;
  timestamp: number;
  velocity: number;  // for heatmap mode
}

interface Fencer {
  id: string;           // 'A' or 'B'
  side: 'left' | 'right';
  color: string;        // '#00ff00' (green) or '#ff0000' (red)
  tip: TipPosition | null;
  trail: TrailPoint[];  // ring buffer
}

interface TrailConfig {
  maxLength: number;    // number of points (default: 60)
  fadeMode: 'linear' | 'exponential' | 'none';
  glowIntensity: number;
  lineWidth: number;
}

interface AppConfig {
  inferenceFps: number;     // 5-30
  trailConfig: TrailConfig;
  debugMode: DebugMode;
  effectMode: EffectMode;
}

type DebugMode = 
  | 'none'           // Production: video + trails
  | 'landmarks'      // All pose landmarks as dots
  | 'skeleton'       // Body connections
  | 'vectors'        // Elbow→wrist→tip lines
  | 'tips-only'      // Just the tip markers
  | 'trails-only'    // Black background + trails
  | 'lightsaber'     // Triangle tip glow
  | 'heatmap'        // Trail color = speed
  | 'all';           // Everything combined

type EffectMode =
  | 'none'           // No shader effect
  | 'lightsaber-glow'  // Add glow to current tip positions
  | 'matrix'         // Green digital rain trail effect
  | 'motion-blur';   // Directional blur based on velocity
```

---

## Implementation Phases

### Phase 1: Foundation (Day 1)

**Files to create/modify:**

1. **Setup & Dependencies**
   ```bash
   npm install @mediapipe/tasks-vision
   ```

2. **Create `src/types/fencing.ts`**
   - Define all TypeScript interfaces above

3. **Create `src/lib/detector.ts`**
   ```typescript
   export async function initPoseDetector(): Promise<PoseLandmarker>
   export async function detectPose(video: HTMLVideoElement): Promise<Pose[]>
   ```

4. **Modify `src/pages/index.astro`**
   - Replace current shader-only structure
   - Add hidden video element
   - Add overlay canvas
   - Basic control panel (debug mode selector, trail length slider)

### Phase 2: Tip Estimation (Day 2)

**Create `src/lib/tip-estimator.ts`**

```typescript
// Simplified heuristic - easy to modify later
function estimateTipPosition(
  wrist: Landmark,
  elbow: Landmark
): TipPosition {
  // Vector from elbow to wrist (forearm direction)
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  
  // Forearm length in normalized coordinates
  const forearmLength = Math.sqrt(dx*dx + dy*dy);
  
  // Extension factor: 1.5x forearm length from wrist
  // This puts tip roughly at hand position + weapon length
  const extension = 1.5;
  
  return {
    x: wrist.x + dx * extension,
    y: wrist.y + dy * extension,
    confidence: Math.min(wrist.visibility, elbow.visibility),
    timestamp: performance.now(),
    side: wrist.x < 0.5 ? 'left' : 'right'  // simple frame-based assignment
  };
}

// Alternative: Use 3D coordinates for perspective-aware estimation
function estimateTipPosition3D(wrist: Landmark, elbow: Landmark): TipPosition {
  // Consider z-depth for more accurate extension
  // Useful if fencers are at different depths in frame
}
```

**Features:**
- Object space calculation (relative to detected joint distances)
- Easy to swap heuristic function
- Confidence thresholding (ignore low-confidence detections)

### Phase 3: Trail Management (Day 2-3)

**Create `src/lib/trail-manager.ts`**

```typescript
export class TrailManager {
  private fencers: Map<string, Fencer>;
  private config: TrailConfig;
  
  constructor(config: TrailConfig) {
    this.fencers = new Map([
      ['A', { id: 'A', side: 'left', color: '#00ff00', tip: null, trail: [] }],
      ['B', { id: 'B', side: 'right', color: '#ff0000', tip: null, trail: [] }]
    ]);
    this.config = config;
  }
  
  updateTips(poses: Pose[]): void {
    // Match detected poses to fencers based on x-position
    // Update tip positions
    // Add to trail buffers
    // Remove old points beyond maxLength
  }
  
  getInterpolatedTips(now: number): TipPosition[] {
    // Linear interpolation between last detection and current render time
    // Smooths 30fps detection → 60fps rendering
  }
  
  getTrails(): Map<string, TrailPoint[]> {
    return new Map([...this.fencers].map(([k, v]) => [k, v.trail]));
  }
  
  clear(): void {
    this.fencers.forEach(f => f.trail = []);
  }
}
```

### Phase 4: Rendering (Day 3-4)

**Create `src/lib/renderer.ts`**

```typescript
export class TrailRenderer {
  private ctx: CanvasRenderingContext2D;
  private config: TrailConfig;
  
  constructor(canvas: HTMLCanvasElement, config: TrailConfig) {
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
  }
  
  render(trails: Map<string, TrailPoint[]>, fencerColors: Map<string, string>): void {
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    trails.forEach((trail, fencerId) => {
      const color = fencerColors.get(fencerId)!;
      this.renderNeonTrail(trail, color);
    });
  }
  
  private renderNeonTrail(trail: TrailPoint[], color: string): void {
    if (trail.length < 2) return;
    
    // Draw with glow effect
    this.ctx.save();
    this.ctx.shadowBlur = 20;
    this.ctx.shadowColor = color;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = this.config.lineWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    
    this.ctx.beginPath();
    this.ctx.moveTo(trail[0].x, trail[0].y);
    
    for (let i = 1; i < trail.length; i++) {
      // Fade opacity based on age
      const age = i / trail.length;
      this.ctx.globalAlpha = age;  // newer = more opaque
      this.ctx.lineTo(trail[i].x, trail[i].y);
    }
    
    this.ctx.stroke();
    this.ctx.restore();
  }
}
```

**Create `src/lib/debug-renderer.ts`**

```typescript
export class DebugRenderer {
  renderLandmarks(poses: Pose[]): void { /* draw dots for each landmark */ }
  renderSkeleton(poses: Pose[]): void { /* draw connecting lines */ }
  renderVectors(poses: Pose[], tips: TipPosition[]): void { /* elbow→wrist→tip */ }
  renderTipMarkers(tips: TipPosition[]): void { /* pulsing circles */ }
  renderLightsaber(tips: TipPosition[], poses: Pose[]): void { /* triangle glow */ }
  renderHeatmap(trails: Map<string, TrailPoint[]>): void { /* color by velocity */ }
}
```

### Phase 5: Lightsaber Effect (Day 4)

**Modify `src/shaders/fragment.glsl`**

Add new effect mode that draws triangle shape at tip:

```glsl
// Inputs: tip position (normalized), color, intensity
// Triangle: handle (wrist) → guard → tip
// Add glow and trail accumulation in shader

uniform vec2 u_tipA;      // Fencer A tip position
uniform vec2 u_tipB;      // Fencer B tip position
uniform vec3 u_colorA;    // Fencer A color (green)
uniform vec3 u_colorB;    // Fencer B color (red)
uniform float u_glow;     // Glow intensity

// Distance from point to line segment (for triangle blade)
float distToSegment(vec2 p, vec2 a, vec2 b) { ... }

// Main effect: add lightsaber glow at tip positions
vec3 lightsaberEffect(vec2 uv) {
  float distA = distance(uv, u_tipA);
  float distB = distance(uv, u_tipB);
  
  float glowA = smoothstep(0.1, 0.0, distA) * u_glow;
  float glowB = smoothstep(0.1, 0.0, distB) * u_glow;
  
  return baseVideoColor + u_colorA * glowA + u_colorB * glowB;
}
```

**Alternative**: Implement lightsaber as Canvas2D overlay for easier iteration:

```typescript
// In renderer.ts
private renderLightsaberBlade(
  wrist: Landmark,
  tip: TipPosition,
  color: string
): void {
  // Draw triangle: wrist (handle) → perpendicular at tip → back
  // Add radial gradient for glow
  // Draw "core" white line for plasma effect
}
```

### Phase 6: Integration & Polish (Day 5)

**Final integration in `index.astro`:**

```typescript
// Main loop structure
let lastDetectionTime = 0;
const detectionInterval = 1000 / 30;  // 30fps detection

async function loop(now: number) {
  // Detection (throttled)
  if (now - lastDetectionTime > detectionInterval) {
    const poses = await detector.detectPose(video);
    tipEstimator.update(poses);
    trailManager.updateTips(poses);
    lastDetectionTime = now;
  }
  
  // Rendering (60fps)
  const interpolatedTips = trailManager.getInterpolatedTips(now);
  const trails = trailManager.getTrails();
  
  // Clear overlay
  overlayCtx.clearRect(0, 0, width, height);
  
  // Render based on debug mode
  switch (config.debugMode) {
    case 'landmarks':
      debugRenderer.renderLandmarks(poses);
      break;
    case 'trails-only':
      trailRenderer.render(trails, colors);
      break;
    case 'lightsaber':
      renderer.renderLightsaber(interpolatedTips, poses);
      break;
    // ... etc
  }
  
  requestAnimationFrame(loop);
}
```

---

## UI Components

### Control Panel (replace existing effects UI)

```astro
<div class="control-panel">
  <label>
    Debug Mode
    <select id="debugMode">
      <option value="none">Production (Trails)</option>
      <option value="landmarks">Landmarks</option>
      <option value="skeleton">Skeleton</option>
      <option value="vectors">Vectors</option>
      <option value="tips-only">Tip Points</option>
      <option value="trails-only">Trails Only</option>
      <option value="lightsaber">Lightsaber</option>
      <option value="heatmap">Heatmap</option>
      <option value="all">All Debug</option>
    </select>
  </label>
  
  <label>
    Trail Length
    <input type="range" id="trailLength" min="10" max="120" value="60" />
  </label>
  
  <label>
    Inference Rate
    <input type="range" id="inferenceRate" min="5" max="30" value="15" />
    <span id="fpsDisplay">15 fps</span>
  </label>
  
  <details class="advanced-controls">
    <summary>Advanced / Effects</summary>
    <!-- Future effect controls hidden by default -->
  </details>
</div>
```

---

## Key Algorithms

### 1. Tip Estimation (Simple/Modular)

```typescript
// Easy to swap - just implement this interface
type TipEstimator = (
  wrist: Landmark,
  elbow: Landmark,
  shoulder?: Landmark  // optional for more context
) => { x: number; y: number; confidence: number };

// V1: Simple vector extension
const simpleEstimator: TipEstimator = (wrist, elbow) => {
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  const len = Math.sqrt(dx*dx + dy*dy);
  return {
    x: wrist.x + (dx / len) * len * 1.5,
    y: wrist.y + (dy / len) * len * 1.5,
    confidence: (wrist.visibility + elbow.visibility) / 2
  };
};

// V2: Perspective-aware (future)
const perspectiveEstimator: TipEstimator = (wrist, elbow, shoulder) => {
  // Use shoulder-wrist distance to estimate scale
  // Compensate for z-depth
};

// V3: Learned model (future)
const mlEstimator: TipEstimator = (wrist, elbow) => {
  // Use trained regression on wrist/elbow angles
  // Output: tip position based on fencing pose
};
```

### 2. Fencer Assignment (Left/Right)

```typescript
function assignFencer(pose: Pose, frameWidth: number): 'A' | 'B' {
  // Use nose or center of hips to determine side
  const centerX = pose.landmarks[0].x;  // nose landmark
  return centerX < 0.5 ? 'A' : 'B';  // left side = A (green), right = B (red)
}
```

### 3. Interpolation (30fps → 60fps)

```typescript
function interpolateTips(
  lastTips: TipPosition[],
  targetTime: number,
  detectionInterval: number
): TipPosition[] {
  // Linear interpolation between last detection and now
  // Smooths visual motion even with lower detection rate
  const t = Math.min(1, (targetTime - lastDetectionTime) / detectionInterval);
  
  return lastTips.map(tip => ({
    ...tip,
    x: lerp(tip.prevX, tip.x, t),
    y: lerp(tip.prevY, tip.y, t)
  }));
}
```

### 4. Neon Glow Effect

```typescript
// Canvas2D approach (easier to iterate)
function drawNeonLine(
  ctx: CanvasRenderingContext2D,
  points: TrailPoint[],
  color: string,
  width: number
): void {
  // Multiple passes for glow
  // 1. Wide, low-opacity blur (outer glow)
  ctx.save();
  ctx.shadowBlur = 30;
  ctx.shadowColor = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = width * 3;
  ctx.globalAlpha = 0.3;
  drawPath(ctx, points);
  ctx.stroke();
  
  // 2. Medium glow
  ctx.shadowBlur = 15;
  ctx.lineWidth = width * 1.5;
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  
  // 3. Core line (sharp)
  ctx.shadowBlur = 0;
  ctx.lineWidth = width;
  ctx.globalAlpha = 1.0;
  ctx.strokeStyle = '#ffffff';  // white core
  ctx.stroke();
  ctx.restore();
}
```

---

## Future: Cloudflare Workers Migration

### What Changes for Workers

1. **MediaPipe in Workers**
   - MediaPipe WASM can run in Cloudflare Workers (V8 isolate)
   - Bundle WASM files with `wrangler deploy`
   - Use `WebAssembly.instantiate()` with bundled binary
   - Alternative: Use Workers AI for pose detection if available

2. **Architecture Shift**

```
Current (Browser):
Camera → Browser → MediaPipe (local) → Render (local)

Workers (Future):
Camera → Browser → WebRTC/DataChannel → Worker → MediaPipe (edge)
                           ↓
                    Durable Object (session state)
                           ↓
              ←── Trail data ──→ Browser (render)
```

3. **Implementation Notes**

```typescript
// Durable Object for session state
export class FencingSession {
  private trails: Map<string, TrailPoint[]>;
  
  async fetch(request: Request): Promise<Response> {
    // WebSocket endpoint for real-time updates
    // Store trail history
    // Broadcast to connected clients
  }
}

// Worker inference endpoint
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Receive video frame (WebRTC or encoded)
    // Run MediaPipe Pose
    // Calculate tips
    // Update Durable Object
    // Return tip positions
  }
};
```

4. **Challenges**
   - MediaPipe WASM size (~8MB) - consider lazy loading
   - Video frame transfer overhead - use compression
   - Latency budget - edge inference should be <50ms
   - Cost - Workers AI may be cheaper than WASM inference

5. **Migration Path**
   - Phase 1: Browser-only (current plan)
   - Phase 2: Add optional Worker backend for multi-user
   - Phase 3: Full edge inference for lower latency

---

## Testing Strategy

### Debug Modes as Tests

Each debug mode serves as a visual test:

1. **`landmarks`** - Verify MediaPipe detects both fencers
2. **`skeleton`** - Check landmark connectivity
3. **`vectors`** - Validate forearm vector direction
4. **`tips-only`** - Confirm tip estimation looks correct
5. **`trails-only`** - Test trail rendering without distraction
6. **`lightsaber`** - Verify triangle/blade positioning

### Manual Calibration

Add calibration mode for tip estimation:

```typescript
// Calibrate extension multiplier by having fencer hold sword
// Compare estimated tip to actual sword tip position
function calibrateExtension(
  detectedWrist: Landmark,
  detectedElbow: Landmark,
  actualTipPosition: { x: number; y: number }
): number {
  const dx = detectedWrist.x - detectedElbow.x;
  const dy = detectedWrist.y - detectedElbow.y;
  const forearmLen = Math.sqrt(dx*dx + dy*dy);
  
  const tipDx = actualTipPosition.x - detectedWrist.x;
  const tipDy = actualTipPosition.y - detectedWrist.y;
  const tipDist = Math.sqrt(tipDx*tipDx + tipDy*tipDy);
  
  return tipDist / forearmLen;  // e.g., 1.8 for epee
}
```

---

## Dependencies

```json
{
  "dependencies": {
    "@astrojs/cloudflare": "^12.6.12",
    "astro": "^5.16.11",
    "@mediapipe/tasks-vision": "^0.10.0"
  },
  "devDependencies": {
    "wrangler": "^4.59.2",
    "@types/node": "^25.0.9"
  }
}
```

---

## Quick Start Commands

```bash
# 1. Create new repo
git init tip-track
cd tip-track

# 2. Setup Astro with Cloudflare
npm create astro@latest . -- --template minimal
npx astro add cloudflare

# 3. Install MediaPipe
npm install @mediapipe/tasks-vision

# 4. Copy structure from this plan
# Create files: types/, lib/, components/, shaders/

# 5. Dev server
npm run dev

# 6. Deploy (when ready)
npm run deploy
```

---

## Success Criteria

- [ ] Two fencers detected consistently
- [ ] Left fencer = green trail, right fencer = red trail
- [ ] Trails persist for ~1 second (60 frames at 60fps)
- [ ] Smooth 60fps rendering even with 15-30fps detection
- [ ] All debug modes functional
- [ ] Lightsaber mode shows triangle blade at tip
- [ ] Works in Chrome, Firefox, Safari
- [ ] Mobile camera support (optional but nice)

---

## Open Questions (Not Blockers)

1. What happens when fencers cross (left/right swap)?
   - Current: Side assignment based on frame position
   - Future: Track identity across frames

2. How to handle occluded limbs?
   - Current: Drop detection if confidence < 0.5
   - Future: Predict from last known position

3. Fencer handedness (lefty vs righty)?
   - Current: Always use right wrist/elbow
   - Future: Detect dominant hand or use both

---

## Notes

- Keep tip estimator modular - easy to swap heuristics
- Trail rendering separate from detection allows flexible effects
- Debug modes are development tools AND user features
- Design for 60fps from the start (interpolation, efficient rendering)
- Workers migration is Phase 2 - don't over-engineer now
