// Sword Tip Estimator Module
// Estimates sword tip position from wrist and elbow landmarks

import type { Landmark, TipPosition, TipEstimator, Pose } from '../types/fencing';
import { LANDMARKS } from './detector';

// Default extension multiplier tuned for current fencing footage.
const DEFAULT_EXTENSION = 4.2;
let poseTipExtension = DEFAULT_EXTENSION;

// Minimum confidence threshold for landmarks
const MIN_CONFIDENCE = 0.5;

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
  _shoulder?: Landmark
): { x: number; y: number; confidence: number } => {
  // Vector from elbow to wrist (forearm direction)
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  
  // Forearm length in normalized coordinates
  const forearmLength = Math.sqrt(dx * dx + dy * dy);
  
  if (forearmLength < 0.001) {
    // Wrist and elbow are too close, can't determine direction
    return {
      x: wrist.x,
      y: wrist.y,
      confidence: Math.min(wrist.visibility, elbow.visibility),
    };
  }
  
  // Normalize direction vector
  const dirX = dx / forearmLength;
  const dirY = dy / forearmLength;
  
  // Extend from wrist by forearm length * multiplier
  const extension = forearmLength * poseTipExtension;
  
  return {
    x: clamp01(wrist.x + dirX * extension),
    y: clamp01(wrist.y + dirY * extension),
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
  shoulder?: Landmark
): { x: number; y: number; confidence: number } => {
  // Base calculation
  const base = defaultEstimator(wrist, elbow, shoulder);
  
  if (!shoulder) {
    return base;
  }
  
  // Use shoulder-wrist distance to estimate body scale
  const shoulderWristDx = wrist.x - shoulder.x;
  const shoulderWristDy = wrist.y - shoulder.y;
  const armLength = Math.sqrt(shoulderWristDx * shoulderWristDx + shoulderWristDy * shoulderWristDy);
  
  // Adjust extension based on arm length (proxy for distance from camera)
  const scaleFactor = armLength / 0.3; // normalize to expected arm length
  const adjustedExtension = poseTipExtension * scaleFactor;
  
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  const forearmLength = Math.sqrt(dx * dx + dy * dy);
  
  const dirX = dx / forearmLength;
  const dirY = dy / forearmLength;
  const extension = forearmLength * adjustedExtension;
  
  return {
    x: clamp01(wrist.x + dirX * extension),
    y: clamp01(wrist.y + dirY * extension),
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
  poseTipExtension = Math.max(1.0, Math.min(8.0, multiplier));
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
  const landmarks = pose.landmarks;
  
  // Use right wrist/elbow by default (can be made configurable for left-handed)
  const wrist = landmarks[LANDMARKS.RIGHT_WRIST];
  const elbow = landmarks[LANDMARKS.RIGHT_ELBOW];
  const shoulder = landmarks[LANDMARKS.RIGHT_SHOULDER];
  
  if (!wrist || !elbow) {
    return null;
  }
  
  // Check confidence thresholds
  if (wrist.visibility < MIN_CONFIDENCE || elbow.visibility < MIN_CONFIDENCE) {
    return null;
  }
  
  const result = activeEstimator(wrist, elbow, shoulder);
  
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
