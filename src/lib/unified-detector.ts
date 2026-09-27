// Unified Detector Interface
// Provides a model-agnostic interface for both Pose and Hand tracking modes

import type { DetectionResult, TrackingMode, TipPosition } from '../types/fencing';
import { 
  initPoseDetector, 
  detectPose, 
  isDetectorReady, 
  resetDetector,
  LANDMARKS as POSE_LANDMARKS,
  POSE_CONNECTIONS 
} from './detector';
import {
  initHandDetector,
  detectHands, 
  isHandDetectorReady, 
  resetHandDetector,
  HAND_LANDMARKS,
  HAND_CONNECTIONS
} from './hand-detector';
import { estimateTip } from './tip-estimator';
import { FencerTracker, type TipCandidate } from './app/fencer-tracker';
import { captureVideoFramePixels, refineTipFromFrame } from './fencers/tip-refiner';

// Current tracking mode
export type InferenceTrackingMode = Exclude<TrackingMode, 'recorded'>;
let currentMode: InferenceTrackingMode = 'pose';
const fencerTracker = new FencerTracker();

function poseBodyAnchorX(landmarks: { x: number }[]): number {
  const xs: number[] = [];
  const nose = landmarks[POSE_LANDMARKS.NOSE]?.x;
  const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER]?.x;
  const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER]?.x;
  const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP]?.x;
  const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP]?.x;

  if (Number.isFinite(leftShoulder)) xs.push(leftShoulder);
  if (Number.isFinite(rightShoulder)) xs.push(rightShoulder);
  if (Number.isFinite(leftHip)) xs.push(leftHip);
  if (Number.isFinite(rightHip)) xs.push(rightHip);
  if (Number.isFinite(nose)) xs.push(nose);

  if (xs.length === 0) return 0.5;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

// Track initialization state
let isInitializing = false;

/**
 * Initialize the detector based on tracking mode
 */
export async function initDetector(
  mode: InferenceTrackingMode,
  options: {
    numTargets?: number;
    minDetectionConfidence?: number;
    minPresenceConfidence?: number;
    minTrackingConfidence?: number;
  } = {}
): Promise<void> {
  if (isInitializing) {
    while (isInitializing) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return;
  }

  isInitializing = true;

  try {
    // Reset previous detector if mode changed
    if (currentMode !== mode) {
      await resetCurrentDetector();
    }

    currentMode = mode;

    const {
      numTargets = 2,
      minDetectionConfidence = 0.5,
      minPresenceConfidence = 0.5,
      minTrackingConfidence = 0.5,
    } = options;

    if (mode === 'pose' || mode === 'fencers') {
      await initPoseDetector(
        numTargets,
        minDetectionConfidence,
        minPresenceConfidence,
        minTrackingConfidence
      );
    } else {
      await initHandDetector(
        numTargets,
        minDetectionConfidence,
        minPresenceConfidence,
        minTrackingConfidence
      );
    }

    console.log(`Detector initialized in ${mode} mode with ${numTargets} targets`);
  } finally {
    isInitializing = false;
  }
}

/**
 * Detect targets (poses or hands) and return unified results
 */
export async function detect(
  video: HTMLVideoElement,
  timestamp: number = performance.now()
): Promise<DetectionResult[]> {
  if (currentMode === 'pose' || currentMode === 'fencers') {
    return detectPoseMode(video, timestamp);
  } else {
    return detectHandMode(video, timestamp);
  }
}

/**
 * Pose mode detection - convert to unified format
 */
async function detectPoseMode(
  video: HTMLVideoElement,
  timestamp: number
): Promise<DetectionResult[]> {
  const poses = await detectPose(video, timestamp);
  const refinementFrame = currentMode === 'fencers' ? captureVideoFramePixels(video) : null;

  const candidates: TipCandidate[] = [];
  for (const pose of poses.slice(0, 2)) {
    const noseX = pose.landmarks[POSE_LANDMARKS.NOSE]?.x ?? 0.5;
    const side = noseX < 0.5 ? 'left' : 'right';
    const baseTip = estimateTip(pose, timestamp, side);
    if (!baseTip) continue;

    let tip = baseTip;
    let refinement: TipCandidate['refinement'] | undefined;
    if (currentMode === 'fencers') {
      const wrist = pose.landmarks[POSE_LANDMARKS.RIGHT_WRIST];
      const elbow = pose.landmarks[POSE_LANDMARKS.RIGHT_ELBOW];
      if (wrist && elbow && refinementFrame) {
        refinement = refineTipFromFrame(
          refinementFrame,
          { x: baseTip.x, y: baseTip.y },
          wrist,
          elbow
        );
        tip = {
          ...baseTip,
          x: refinement.refined.x,
          y: refinement.refined.y,
          confidence: Math.max(0.05, Math.min(baseTip.confidence, 0.35 + refinement.confidence * 0.65)),
        };
      }
    }

    candidates.push({
      tip,
      landmarks: pose.landmarks,
      bodyX: poseBodyAnchorX(pose.landmarks),
      refinement,
    });
  }

  return fencerTracker.assign(candidates);
}

/**
 * Hand mode detection - already in unified format
 */
async function detectHandMode(
  video: HTMLVideoElement,
  timestamp: number
): Promise<DetectionResult[]> {
  return detectHands(video, timestamp);
}

/**
 * Get current tracking mode
 */
export function getTrackingMode(): TrackingMode {
  return currentMode;
}

/**
 * Set tracking mode (will require reinitialization)
 */
export async function setTrackingMode(mode: TrackingMode): Promise<void> {
  if (mode === 'recorded') return;
  if (mode !== currentMode) {
    await resetCurrentDetector();
    currentMode = mode;
  }
}

/**
 * Check if detector is initialized
 */
export function isDetectorInitialized(): boolean {
  if (currentMode === 'pose' || currentMode === 'fencers') {
    return isDetectorReady();
  } else {
    return isHandDetectorReady();
  }
}

/**
 * Reset the current detector
 */
export async function resetCurrentDetector(): Promise<void> {
  resetDetector();
  resetHandDetector();
  fencerTracker.reset();
  // Small delay to ensure cleanup
  await new Promise(resolve => setTimeout(resolve, 100));
}

/**
 * Get landmark indices for current mode
 */
export function getLandmarkInfo() {
  if (currentMode === 'pose' || currentMode === 'fencers') {
    return {
      type: 'pose' as const,
      landmarks: POSE_LANDMARKS,
      tipLandmark: POSE_LANDMARKS.RIGHT_WRIST, // Not used directly
    };
  } else {
    return {
      type: 'hand' as const,
      landmarks: HAND_LANDMARKS,
      connections: HAND_CONNECTIONS,
      tipLandmark: HAND_LANDMARKS.INDEX_FINGER_TIP,
    };
  }
}

/**
 * Extract tips from detection results for trail manager
 */
export function extractTips(results: DetectionResult[]): Map<string, TipPosition> {
  const tips = new Map<string, TipPosition>();
  results.forEach(result => {
    tips.set(result.id, result.tip);
  });
  return tips;
}

// Re-export types and constants for convenience
export { POSE_LANDMARKS, POSE_CONNECTIONS, HAND_LANDMARKS, HAND_CONNECTIONS };
export type { InferenceTrackingMode as TrackingMode };
