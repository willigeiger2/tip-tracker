// Sword Tip Estimator Module
// Estimates sword tip position from wrist and elbow landmarks

import type { Landmark, TipPosition, TipEstimator, Pose } from '../types/fencing';
import { LANDMARKS } from './detector';

export type ArmSide = 'left' | 'right';
export type TrackId = 'A' | 'B';

export interface FencerDirectionTuning {
  wristWeight: number;
  angleOffsetDeg: number;
  extensionMultiplier: number;
}

// Default extension multiplier tuned for current fencing footage.
const DEFAULT_EXTENSION = 3.6;
let poseTipExtension = DEFAULT_EXTENSION;

// Minimum confidence threshold for landmarks
const MIN_CONFIDENCE = 0.5;
const WRIST_HINT_MIN_CONFIDENCE = 0.2;
const DEFAULT_WRIST_WEIGHT = 0.35;
const DEFAULT_ANGLE_OFFSET_DEG = 0;
const MIN_ANGLE_OFFSET_DEG = -30;
const MAX_ANGLE_OFFSET_DEG = 30;
const MIN_EXTENSION = 1;
const MAX_EXTENSION = 8;

const directionTuningByTrack: Record<TrackId, FencerDirectionTuning> = {
  A: {
    wristWeight: DEFAULT_WRIST_WEIGHT,
    angleOffsetDeg: DEFAULT_ANGLE_OFFSET_DEG,
    extensionMultiplier: DEFAULT_EXTENSION,
  },
  B: {
    wristWeight: DEFAULT_WRIST_WEIGHT,
    angleOffsetDeg: DEFAULT_ANGLE_OFFSET_DEG,
    extensionMultiplier: DEFAULT_EXTENSION,
  },
};

type Direction2D = { x: number; y: number };

function normalizeDirection(dx: number, dy: number): Direction2D | null {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: dx / len, y: dy / len };
}

function rotateDirection(dir: Direction2D, angleDeg: number): Direction2D {
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 1e-4) return dir;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: dir.x * cos - dir.y * sin,
    y: dir.x * sin + dir.y * cos,
  };
}

function clampWristWeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WRIST_WEIGHT;
  return Math.max(0, Math.min(1, value));
}

function clampAngleOffsetDeg(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ANGLE_OFFSET_DEG;
  return Math.max(MIN_ANGLE_OFFSET_DEG, Math.min(MAX_ANGLE_OFFSET_DEG, value));
}

function clampExtensionMultiplier(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXTENSION;
  return Math.max(MIN_EXTENSION, Math.min(MAX_EXTENSION, value));
}

export function getFencerDirectionTuning(track: TrackId): FencerDirectionTuning {
  const tuning = directionTuningByTrack[track];
  return {
    wristWeight: tuning.wristWeight,
    angleOffsetDeg: tuning.angleOffsetDeg,
    extensionMultiplier: tuning.extensionMultiplier,
  };
}

export function setFencerDirectionTuning(track: TrackId, patch: Partial<FencerDirectionTuning>): void {
  const current = directionTuningByTrack[track];
  directionTuningByTrack[track] = {
    wristWeight: patch.wristWeight === undefined ? current.wristWeight : clampWristWeight(patch.wristWeight),
    angleOffsetDeg:
      patch.angleOffsetDeg === undefined ? current.angleOffsetDeg : clampAngleOffsetDeg(patch.angleOffsetDeg),
    extensionMultiplier:
      patch.extensionMultiplier === undefined
        ? current.extensionMultiplier
        : clampExtensionMultiplier(patch.extensionMultiplier),
  };
}

function blendedBladeDirection(
  wrist: Landmark,
  elbow: Landmark,
  tuning: FencerDirectionTuning,
  handHints?: {
    index?: Landmark;
    thumb?: Landmark;
    pinky?: Landmark;
  }
): { dir: Direction2D; forearmLength: number } | null {
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  const forearmLength = Math.sqrt(dx * dx + dy * dy);
  if (forearmLength < 0.001) return null;

  const forearmDir = { x: dx / forearmLength, y: dy / forearmLength };
  const wristWeight = clampWristWeight(tuning.wristWeight);
  const forearmWeight = 1 - wristWeight;

  if (!handHints) {
    return { dir: rotateDirection(forearmDir, tuning.angleOffsetDeg), forearmLength };
  }

  let hintDx = 0;
  let hintDy = 0;
  let hintWeight = 0;
  const addHint = (lm: Landmark | undefined, weight: number) => {
    if (!lm) return;
    if (lm.visibility < WRIST_HINT_MIN_CONFIDENCE) return;
    hintDx += (lm.x - wrist.x) * weight;
    hintDy += (lm.y - wrist.y) * weight;
    hintWeight += weight;
  };

  addHint(handHints.index, 0.65);
  addHint(handHints.thumb, 0.25);
  addHint(handHints.pinky, 0.1);

  if (hintWeight <= 0) {
    return { dir: rotateDirection(forearmDir, tuning.angleOffsetDeg), forearmLength };
  }

  const wristDir = normalizeDirection(hintDx / hintWeight, hintDy / hintWeight);
  if (!wristDir) {
    return { dir: rotateDirection(forearmDir, tuning.angleOffsetDeg), forearmLength };
  }

  const blend = normalizeDirection(
    forearmDir.x * forearmWeight + wristDir.x * wristWeight,
    forearmDir.y * forearmWeight + wristDir.y * wristWeight
  );

  return {
    dir: rotateDirection(blend ?? forearmDir, tuning.angleOffsetDeg),
    forearmLength,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Default tip estimator: extends forearm vector by multiplier
 * Simple but effective heuristic - modular and easy to swap
 */
export const defaultEstimator: TipEstimator = (
  wrist: Landmark,
  elbow: Landmark,
  _shoulder?: Landmark,
  options?: {
    handHints?: { index?: Landmark; thumb?: Landmark; pinky?: Landmark };
    wristWeight?: number;
    angleOffsetDeg?: number;
    extensionMultiplier?: number;
  }
): { x: number; y: number; confidence: number } => {
  const tuning: FencerDirectionTuning = {
    wristWeight: clampWristWeight(options?.wristWeight ?? DEFAULT_WRIST_WEIGHT),
    angleOffsetDeg: clampAngleOffsetDeg(options?.angleOffsetDeg ?? DEFAULT_ANGLE_OFFSET_DEG),
    extensionMultiplier: clampExtensionMultiplier(options?.extensionMultiplier ?? poseTipExtension),
  };
  const direction = blendedBladeDirection(wrist, elbow, tuning, options?.handHints);

  if (!direction) {
    // Wrist and elbow are too close, can't determine direction
    return {
      x: wrist.x,
      y: wrist.y,
      confidence: Math.min(wrist.visibility, elbow.visibility),
    };
  }

  const { dir, forearmLength } = direction;
  
  // Extend from wrist by forearm length * multiplier
  const extension = forearmLength * tuning.extensionMultiplier;
  
  return {
    x: clamp01(wrist.x + dir.x * extension),
    y: clamp01(wrist.y + dir.y * extension),
    confidence: Math.min(wrist.visibility, elbow.visibility),
  };
};

/**
 * Perspective-aware tip estimator (future enhancement)
 * Uses shoulder distance to estimate scale and compensate for depth
 */
export const perspectiveEstimator: TipEstimator = (
  wrist: Landmark,
  elbow: Landmark,
  shoulder?: Landmark,
  options?: {
    handHints?: { index?: Landmark; thumb?: Landmark; pinky?: Landmark };
    wristWeight?: number;
    angleOffsetDeg?: number;
    extensionMultiplier?: number;
  }
): { x: number; y: number; confidence: number } => {
  // Base calculation
  const base = defaultEstimator(wrist, elbow, shoulder, options);
  
  if (!shoulder) {
    return base;
  }
  
  // Use shoulder-wrist distance to estimate body scale
  const shoulderWristDx = wrist.x - shoulder.x;
  const shoulderWristDy = wrist.y - shoulder.y;
  const armLength = Math.sqrt(shoulderWristDx * shoulderWristDx + shoulderWristDy * shoulderWristDy);
  
  // Adjust extension based on arm length (proxy for distance from camera)
  const scaleFactor = armLength / 0.3; // normalize to expected arm length
  const baseExtension = clampExtensionMultiplier(options?.extensionMultiplier ?? poseTipExtension);
  const adjustedExtension = baseExtension * scaleFactor;
  
  const tuning: FencerDirectionTuning = {
    wristWeight: clampWristWeight(options?.wristWeight ?? DEFAULT_WRIST_WEIGHT),
    angleOffsetDeg: clampAngleOffsetDeg(options?.angleOffsetDeg ?? DEFAULT_ANGLE_OFFSET_DEG),
    extensionMultiplier: baseExtension,
  };
  const direction = blendedBladeDirection(wrist, elbow, tuning, options?.handHints);
  if (!direction) {
    return base;
  }

  const { dir, forearmLength } = direction;
  const extension = forearmLength * adjustedExtension;
  
  return {
    x: clamp01(wrist.x + dir.x * extension),
    y: clamp01(wrist.y + dir.y * extension),
    confidence: Math.min(wrist.visibility, elbow.visibility, shoulder.visibility),
  };
};

// Current active estimator - can be swapped at runtime
let activeEstimator: TipEstimator = defaultEstimator;

export function getPoseTipExtension(): number {
  return poseTipExtension;
}

export function setPoseTipExtension(multiplier: number): void {
  if (!Number.isFinite(multiplier)) return;
  poseTipExtension = clampExtensionMultiplier(multiplier);
}

/**
 * Set the active tip estimator function
 */
export function setTipEstimator(estimator: TipEstimator): void {
  activeEstimator = estimator;
}

/**
 * Get the current tip estimator
 */
export function getTipEstimator(): TipEstimator {
  return activeEstimator;
}

/**
 * Estimate tip position for a single pose
 * Uses right wrist/elbow by default (assumes right-handed fencer)
 * Returns null if confidence is too low
 */
export function estimateTip(
  pose: Pose,
  timestamp: number,
  side: 'left' | 'right'
): TipPosition | null {
  return estimateTipForArm(pose, timestamp, side, 'right');
}

/**
 * Estimate tip position for a specific arm side.
 * Used by fencers mode to choose between left/right arm hypotheses.
 */
export function estimateTipForArm(
  pose: Pose,
  timestamp: number,
  side: 'left' | 'right',
  arm: ArmSide,
  trackId?: TrackId
): TipPosition | null {
  const landmarks = pose.landmarks;

  const wrist = arm === 'right' ? landmarks[LANDMARKS.RIGHT_WRIST] : landmarks[LANDMARKS.LEFT_WRIST];
  const elbow = arm === 'right' ? landmarks[LANDMARKS.RIGHT_ELBOW] : landmarks[LANDMARKS.LEFT_ELBOW];
  const shoulder = arm === 'right' ? landmarks[LANDMARKS.RIGHT_SHOULDER] : landmarks[LANDMARKS.LEFT_SHOULDER];
  const handHints =
    arm === 'right'
      ? {
          index: landmarks[LANDMARKS.RIGHT_INDEX],
          thumb: landmarks[LANDMARKS.RIGHT_THUMB],
          pinky: landmarks[LANDMARKS.RIGHT_PINKY],
        }
      : {
          index: landmarks[LANDMARKS.LEFT_INDEX],
          thumb: landmarks[LANDMARKS.LEFT_THUMB],
          pinky: landmarks[LANDMARKS.LEFT_PINKY],
        };
  
  if (!wrist || !elbow) {
    return null;
  }
  
  // Check confidence thresholds
  if (wrist.visibility < MIN_CONFIDENCE || elbow.visibility < MIN_CONFIDENCE) {
    return null;
  }

  const tuning = trackId
    ? getFencerDirectionTuning(trackId)
    : {
        wristWeight: DEFAULT_WRIST_WEIGHT,
        angleOffsetDeg: DEFAULT_ANGLE_OFFSET_DEG,
        extensionMultiplier: poseTipExtension,
      };
  
  const result = activeEstimator(wrist, elbow, shoulder, {
    handHints,
    wristWeight: tuning.wristWeight,
    angleOffsetDeg: tuning.angleOffsetDeg,
    extensionMultiplier: tuning.extensionMultiplier,
  });
  
  if (result.confidence < MIN_CONFIDENCE) {
    return null;
  }
  
  return {
    x: result.x,
    y: result.y,
    // Pose-derived depth is noisy for fencing; keep pose/fencers rendering stable.
    z: 0,
    confidence: result.confidence,
    timestamp,
    side,
  };
}

/**
 * Assign fencers to left/right sides based on their position in frame
 * Handles 1 or 2 fencers gracefully
 */
export function assignFencers(poses: Pose[]): Map<string, Pose> {
  const assignments = new Map<string, Pose>();
  
  if (poses.length === 0) {
    return assignments;
  }
  
  if (poses.length === 1) {
    // Single fencer: assign to side based on position
    const pose = poses[0];
    const nose = pose.landmarks[LANDMARKS.NOSE];
    const centerX = nose?.x ?? 0.5;
    const side = centerX < 0.5 ? 'left' : 'right';
    const id = side === 'left' ? 'A' : 'B';
    assignments.set(id, pose);
  } else {
    // Two fencers: sort by x position, assign left=A, right=B
    const sorted = [...poses].sort((a, b) => {
      const aX = a.landmarks[LANDMARKS.NOSE]?.x ?? 0.5;
      const bX = b.landmarks[LANDMARKS.NOSE]?.x ?? 0.5;
      return aX - bX;
    });
    assignments.set('A', sorted[0]); // left
    assignments.set('B', sorted[1]); // right
  }
  
  return assignments;
}

/**
 * Estimate tips for all detected fencers
 * Returns Map of fencer ID to tip position
 */
export function estimateTipsForFencers(
  poses: Pose[],
  timestamp: number
): Map<string, TipPosition> {
  const assignments = assignFencers(poses);
  const tips = new Map<string, TipPosition>();
  
  assignments.forEach((pose, id) => {
    const side = id === 'A' ? 'left' : 'right';
    const tip = estimateTip(pose, timestamp, side);
    if (tip) {
      tips.set(id, tip);
    }
  });
  
  return tips;
}
