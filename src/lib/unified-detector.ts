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
import { estimateTip, estimateTipForArm, getFencerDirectionTuning, type TrackId } from './tip-estimator';
import { FencerTracker, type TipCandidate } from './app/fencer-tracker';
import { captureVideoFramePixels, refineTipFromFrame } from './fencers/tip-refiner';

// Current tracking mode
export type InferenceTrackingMode = Exclude<TrackingMode, 'recorded'>;
let currentMode: InferenceTrackingMode = 'pose';
const fencerTracker = new FencerTracker();
let fencerTipRefinementEnabled = true;
const DEFAULT_EXTENSION_SMOOTHING_ALPHA = 0.32;
const smoothedExtensionByTrack: Record<TrackId, number | null> = { A: null, B: null };
const extensionSmoothingAlphaByTrack: Record<TrackId, number> = {
  A: DEFAULT_EXTENSION_SMOOTHING_ALPHA,
  B: DEFAULT_EXTENSION_SMOOTHING_ALPHA,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSmoothingAlpha(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXTENSION_SMOOTHING_ALPHA;
  return Math.max(0, Math.min(1, value));
}

export function setFencerLengthSmoothingAlpha(track: TrackId, alpha: number): void {
  extensionSmoothingAlphaByTrack[track] = clampSmoothingAlpha(alpha);
}

export function getFencerLengthSmoothingAlpha(track: TrackId): number {
  return extensionSmoothingAlphaByTrack[track];
}

export function setFencerTipRefinementEnabled(enabled: boolean): void {
  fencerTipRefinementEnabled = enabled;
}

function smoothExtensionLength(track: TrackId, next: number): number {
  const prev = smoothedExtensionByTrack[track];
  const alpha = extensionSmoothingAlphaByTrack[track];
  const smoothed = prev === null ? next : prev + (next - prev) * alpha;
  smoothedExtensionByTrack[track] = smoothed;
  return smoothed;
}

function resetExtensionSmoothing(): void {
  smoothedExtensionByTrack.A = null;
  smoothedExtensionByTrack.B = null;
}

function trackForBodyX(bodyX: number): TrackId {
  return bodyX < 0.5 ? 'B' : 'A';
}

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
  const inFencersMode = currentMode === 'fencers';
  const refinementFrame =
    inFencersMode && fencerTipRefinementEnabled ? captureVideoFramePixels(video) : null;

  const candidates: TipCandidate[] = [];
  for (const pose of poses.slice(0, 2)) {
    const bodyX = poseBodyAnchorX(pose.landmarks);
    const side = bodyX < 0.5 ? 'left' : 'right';

    if (!inFencersMode) {
      const tip = estimateTip(pose, timestamp, side);
      if (!tip) continue;

      candidates.push({
        tip,
        landmarks: pose.landmarks,
        bodyX,
      });
      continue;
    }

    const forcedArm = 'right' as const;
    const tuningTrack = trackForBodyX(bodyX);
    const rawTip = estimateTipForArm(pose, timestamp, side, forcedArm, tuningTrack);
    if (!rawTip) continue;

    const wrist = pose.landmarks[POSE_LANDMARKS.RIGHT_WRIST];
    const elbow = pose.landmarks[POSE_LANDMARKS.RIGHT_ELBOW];
    if (!wrist || !elbow) continue;

    const rawDirDx = rawTip.x - wrist.x;
    const rawDirDy = rawTip.y - wrist.y;
    const rawDirLen = Math.sqrt(rawDirDx * rawDirDx + rawDirDy * rawDirDy);
    if (!Number.isFinite(rawDirLen) || rawDirLen < 1e-4) continue;

    const forearmDx = wrist.x - elbow.x;
    const forearmDy = wrist.y - elbow.y;
    const forearmLength = Math.sqrt(forearmDx * forearmDx + forearmDy * forearmDy);
    if (!Number.isFinite(forearmLength) || forearmLength < 1e-4) continue;

    const tuning = getFencerDirectionTuning(tuningTrack);
    const rawExtensionLength = forearmLength * tuning.extensionMultiplier;
    const smoothedExtensionLength = smoothExtensionLength(tuningTrack, rawExtensionLength);

    const baseTip = {
      ...rawTip,
      x: clamp01(wrist.x + (rawDirDx / rawDirLen) * smoothedExtensionLength),
      y: clamp01(wrist.y + (rawDirDy / rawDirLen) * smoothedExtensionLength),
    };

    let tip = baseTip;
    let refinement: TipCandidate['refinement'] | undefined;
    if (refinementFrame) {
      const seedDx = baseTip.x - wrist.x;
      const seedDy = baseTip.y - wrist.y;
      const seedLength = Math.sqrt(seedDx * seedDx + seedDy * seedDy);
      const seedDirection =
        Number.isFinite(seedLength) && seedLength > 1e-4
          ? {
              x: seedDx / seedLength,
              y: seedDy / seedLength,
            }
          : undefined;

      refinement = refineTipFromFrame(
        refinementFrame,
        { x: baseTip.x, y: baseTip.y },
        wrist,
        elbow,
        seedDirection
      );
      refinement.arm = forcedArm;
      refinement.rawExtensionLength = rawExtensionLength;
      refinement.smoothedExtensionLength = smoothedExtensionLength;
      refinement.lengthSmoothingAlpha = extensionSmoothingAlphaByTrack[tuningTrack];
      tip = {
        ...baseTip,
        x: refinement.refined.x,
        y: refinement.refined.y,
        confidence: Math.max(0.05, Math.min(baseTip.confidence, 0.35 + refinement.confidence * 0.65)),
      };
    }

    candidates.push({
      tip,
      landmarks: pose.landmarks,
      bodyX,
      arm: forcedArm,
      rawExtensionLength,
      smoothedExtensionLength,
      lengthSmoothingAlpha: extensionSmoothingAlphaByTrack[tuningTrack],
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
  resetExtensionSmoothing();
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
