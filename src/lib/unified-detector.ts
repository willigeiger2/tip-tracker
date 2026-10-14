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
import { estimateTip, estimateTipFromJoints, getFencerDirectionTuning, type TrackId } from './tip-estimator';
import { forwardSignFor, selectWeaponArm, type WeaponArmMode } from './fencers/arm-selector';
import { FencerTracker, type TipCandidate } from './app/fencer-tracker';

// Current tracking mode
export type InferenceTrackingMode = Exclude<TrackingMode, 'recorded'>;
let currentMode: InferenceTrackingMode = 'pose';
const fencerTracker = new FencerTracker();
const DEFAULT_EXTENSION_SMOOTHING_ALPHA = 0.32;

const smoothedExtensionByTrack: Record<TrackId, number | null> = { A: null, B: null };
const extensionSmoothingAlphaByTrack: Record<TrackId, number> = {
  A: DEFAULT_EXTENSION_SMOOTHING_ALPHA,
  B: DEFAULT_EXTENSION_SMOOTHING_ALPHA,
};
const weaponArmModeByTrack: Record<TrackId, WeaponArmMode> = { A: 'auto', B: 'auto' };
const previousWristByTrack: Record<TrackId, { x: number; y: number } | null> = { A: null, B: null };

export function setFencerWeaponArm(track: TrackId, mode: WeaponArmMode): void {
  weaponArmModeByTrack[track] = mode;
  previousWristByTrack[track] = null;
}

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

  const candidates: TipCandidate[] = [];
  const usablePoses = poses.slice(0, 2);
  const bodyXs = usablePoses.map((pose) => poseBodyAnchorX(pose.landmarks));
  for (const [poseIndex, pose] of usablePoses.entries()) {
    const bodyX = bodyXs[poseIndex];
    const opponentBodyX = bodyXs.length === 2 ? bodyXs[1 - poseIndex] : null;
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

    const tuningTrack = trackForBodyX(bodyX);
    const selection = selectWeaponArm(
      pose.landmarks,
      bodyX,
      forwardSignFor(bodyX, opponentBodyX),
      weaponArmModeByTrack[tuningTrack],
      previousWristByTrack[tuningTrack]
    );
    if (!selection) continue;
    const rawTip = estimateTipFromJoints(selection, timestamp, side, tuningTrack);
    if (!rawTip) continue;
    previousWristByTrack[tuningTrack] = { x: selection.wrist.x, y: selection.wrist.y };

    const { wrist, elbow } = selection;

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

    candidates.push({
      tip: baseTip,
      landmarks: pose.landmarks,
      bodyX,
      arm: selection.label,
      armMargin: selection.margin,
      rawExtensionLength,
      smoothedExtensionLength,
      lengthSmoothingAlpha: extensionSmoothingAlphaByTrack[tuningTrack],
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
  previousWristByTrack.A = null;
  previousWristByTrack.B = null;
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
