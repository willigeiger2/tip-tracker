// Tip Track - TypeScript Type Definitions

export interface Landmark {
  x: number;        // 0-1 normalized
  y: number;
  z: number;
  visibility: number;  // confidence 0-1
}

export interface Pose {
  landmarks: Landmark[];  // 33 MediaPipe landmarks
  worldLandmarks: Landmark[];
  score: number;  // overall pose confidence
}

export interface TipPosition {
  x: number;        // 0-1 normalized
  y: number;
  z: number;        // relative depth (negative = closer to camera)
  confidence: number;
  timestamp: number;
  side: 'left' | 'right';  // assigned based on frame position
  prevX?: number;   // for interpolation
  prevY?: number;   // for interpolation
}

export interface TrailPoint {
  x: number;
  y: number;
  z: number;         // relative depth for 3D effects
  timestamp: number;
  velocity: number;  // for heatmap mode
  opacity: number;   // for smooth fade out (0-1)
}

export interface Fencer {
  id: string;           // 'A' or 'B'
  side: 'left' | 'right';
  color: string;        // '#00ff00' (green) or '#ff0000' (red)
  tip: TipPosition | null;
  trail: TrailPoint[];  // ring buffer
}

export interface TrailConfig {
  maxLength: number;    // number of points (default: 60)
  fadeMode: 'linear' | 'exponential' | 'none';
  glowIntensity: number;
  lineWidth: number;
}

export interface AppConfig {
  inferenceFps: number;     // 5-30
  trailConfig: TrailConfig;
  debugMode: DebugMode;
  effectMode: EffectMode;
}

export type DebugMode = 
  | 'none'           // Production: video + trails
  | 'landmarks'      // All pose landmarks as dots
  | 'skeleton'       // Body connections
  | 'vectors'        // Elbow→wrist→tip lines
  | 'tips-only'      // Just the tip markers
  | 'trails-only'    // Black background + trails
  | 'lightsaber'     // Triangle tip glow
  | 'heatmap'        // Trail color = speed
  | 'all';           // Everything combined

export type EffectMode =
  | 'none'           // No shader effect
  | 'lightsaber-glow'  // Add glow to current tip positions
  | 'matrix'         // Green digital rain trail effect
  | 'motion-blur';   // Directional blur based on velocity

// Tracking mode: hand/pose inference or recorded keyframes.
export type TrackingMode = 'pose' | 'hand' | 'recorded';

// Unified detection result - works for both pose and hand modes
export interface DetectionResult {
  id: string;           // 'A' or 'B'
  side: 'left' | 'right';
  tip: TipPosition;
  landmarks: Landmark[];  // All landmarks for this detection
  handedness?: 'Left' | 'Right';  // actual hand side (hand mode only)
}

// Tip estimator function type - modular and swappable
export type TipEstimator = (
  wrist: Landmark,
  elbow: Landmark,
  shoulder?: Landmark  // optional for more context
) => { x: number; y: number; confidence: number };
