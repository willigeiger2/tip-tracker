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
import {
  estimateTip,
  estimateTipForArm,
  getFencerDirectionTuning,
  setFencerDirectionTuning,
  type TrackId,
} from './tip-estimator';
import { FencerTracker, type TipCandidate } from './app/fencer-tracker';
import { captureVideoFramePixels, refineTipFromFrame, type VideoFramePixels } from './fencers/tip-refiner';

// Current tracking mode
export type InferenceTrackingMode = Exclude<TrackingMode, 'recorded'>;
let currentMode: InferenceTrackingMode = 'pose';
const fencerTracker = new FencerTracker();
let fencerTipRefinementEnabled = true;
const DEFAULT_EXTENSION_SMOOTHING_ALPHA = 0.32;

interface RefinementTrustProfile {
  minDirectionConfidence: number;
  minLengthConfidence: number;
  minFanMargin: number;
  maxDirectionDeltaDeg: number;
  maxBestFanAngleDeg: number;
  maxLengthRatioDelta: number;
  maxRefinedShift: number;
  maxRefinedShiftLowMargin: number;
  lowMarginThreshold: number;
  directionMemoryBlend: number;
  lengthMemoryBlend: number;
  useMemoryOnRejectedDirection: boolean;
  useMemoryOnRejectedLength: boolean;
  requireDirectionAndLengthTrust: boolean;
  refinedTipBlend: number;
}

const REFINEMENT_TRUST_PROFILE: Record<TrackId, RefinementTrustProfile> = {
  A: {
    minDirectionConfidence: 0.78,
    minLengthConfidence: 0.86,
    minFanMargin: 0.08,
    maxDirectionDeltaDeg: 21,
    maxBestFanAngleDeg: 24,
    maxLengthRatioDelta: 0.24,
    maxRefinedShift: 0.055,
    maxRefinedShiftLowMargin: 0.04,
    lowMarginThreshold: 0.16,
    directionMemoryBlend: 0.58,
    lengthMemoryBlend: 0.62,
    useMemoryOnRejectedDirection: false,
    useMemoryOnRejectedLength: false,
    requireDirectionAndLengthTrust: true,
    refinedTipBlend: 0.2,
  },
  B: {
    minDirectionConfidence: 0.3,
    minLengthConfidence: 0.45,
    minFanMargin: 0.02,
    maxDirectionDeltaDeg: 45,
    maxBestFanAngleDeg: 36,
    maxLengthRatioDelta: 0.85,
    maxRefinedShift: 0.14,
    maxRefinedShiftLowMargin: 0.1,
    lowMarginThreshold: 0.07,
    directionMemoryBlend: 0.45,
    lengthMemoryBlend: 0.5,
    useMemoryOnRejectedDirection: true,
    useMemoryOnRejectedLength: true,
    requireDirectionAndLengthTrust: false,
    refinedTipBlend: 0.8,
  },
};
const smoothedExtensionByTrack: Record<TrackId, number | null> = { A: null, B: null };
const extensionSmoothingAlphaByTrack: Record<TrackId, number> = {
  A: DEFAULT_EXTENSION_SMOOTHING_ALPHA,
  B: DEFAULT_EXTENSION_SMOOTHING_ALPHA,
};
const refinementMemoryByTrack: Record<TrackId, { dir: { x: number; y: number } | null; length: number | null }> = {
  A: { dir: null, length: null },
  B: { dir: null, length: null },
};

interface LumaFrame {
  width: number;
  height: number;
  luma: Float32Array;
}

interface TemplateDescriptor {
  values: Float32Array;
  centered: Float32Array;
  norm: number;
}

interface TemplateTrackState {
  dynamic: TemplateDescriptor | null;
  snapshots: TemplateDescriptor[];
}

interface TemplateRefinementResult {
  tip: { x: number; y: number };
  applied: boolean;
  score: number;
  secondScore: number;
  margin: number;
  templateIndex: number;
  shiftFromPriorNorm: number;
  searchRadiusPx: number;
}

interface TemporalTrackState {
  tip: { x: number; y: number } | null;
  vel: { x: number; y: number };
  dir: { x: number; y: number } | null;
  length: number;
  confidence: number;
}

interface AdaptiveTrackState {
  extensionMultiplier: number | null;
  wristWeight: number | null;
  anchorExtensionMultiplier: number | null;
  anchorWristWeight: number | null;
  lastAppliedExtensionMultiplier: number | null;
  lastAppliedWristWeight: number | null;
  acceptanceEma: number;
  backwardRejectEma: number;
  lengthErrorEma: number;
  fanMarginEma: number;
  directionDeltaDegEma: number;
  framesSinceUpdate: number;
}

let templateExperimentEnabled = true;
const TEMPLATE_EXPERIMENT_TRACKS = new Set<TrackId>(['A']);
const TEMPLATE_WIDTH = 27;
const TEMPLATE_HEIGHT = 11;
const TEMPLATE_ANCHOR_X = 0.5;
const TEMPLATE_ANCHOR_Y = 0.5;
const TEMPLATE_BASE_SEARCH_RADIUS_NORM = 0.03;
const TEMPLATE_MAX_SEARCH_RADIUS_NORM = 0.09;
const TEMPLATE_MATCH_MIN_SCORE = 0.58;
const TEMPLATE_MATCH_MIN_MARGIN = 0.004;
const TEMPLATE_MATCH_MAX_SHIFT_NORM = 0.03;
const TEMPLATE_MATCH_BLEND = 0.8;
const TEMPLATE_UPDATE_MIN_SCORE = 0.42;
const TEMPLATE_SNAPSHOT_MIN_SCORE = 0.75;
const TEMPLATE_MAX_SNAPSHOTS = 3;
const BACKWARD_DIRECTION_DOT_THRESHOLD = -0.08;
let temporalRefinementEnabled = true;
const TEMPORAL_REFINEMENT_TRACKS = new Set<TrackId>(['A']);
const TEMPORAL_PRIOR_WEIGHT = 0.1739;
const TEMPORAL_PRIOR_MAX_SHIFT_PX = 34.99;
const TEMPORAL_DIR_ALPHA = 0.052;
const TEMPORAL_LENGTH_ALPHA = 0.366;
const TEMPORAL_VEL_ALPHA = 0.4928;
const TEMPORAL_EXPECTED_BLEND = 0.3555;
const TEMPORAL_MAX_STEP_PX = 10.07;
let adaptiveFencerTuningEnabled = true;
const ADAPTIVE_TUNING_TRACKS = new Set<TrackId>(['A', 'B']);
const ADAPTIVE_EMA_ALPHA = 0.14;
const ADAPTIVE_UPDATE_INTERVAL_FRAMES = 8;
const ADAPTIVE_EXTERNAL_EXTENSION_OVERRIDE_DELTA = 0.12;
const ADAPTIVE_EXTERNAL_WRIST_OVERRIDE_DELTA = 0.08;

const ADAPTIVE_EXTENSION_BOUNDS: Record<TrackId, { min: number; max: number }> = {
  A: { min: 3.6, max: 4.8 },
  B: { min: 3.6, max: 4.8 },
};

const ADAPTIVE_WRIST_BOUNDS: Record<TrackId, { min: number; max: number }> = {
  A: { min: 0.2, max: 0.7 },
  B: { min: 0.35, max: 1.0 },
};

const templateWeightMask = (() => {
  const size = TEMPLATE_WIDTH * TEMPLATE_HEIGHT;
  const values = new Float32Array(size);
  const tipX = TEMPLATE_ANCHOR_X * (TEMPLATE_WIDTH - 1);
  const tipY = TEMPLATE_ANCHOR_Y * (TEMPLATE_HEIGHT - 1);
  const tipRadiusSq = 3.0 * 3.0;

  let sum = 0;
  for (let y = 0; y < TEMPLATE_HEIGHT; y++) {
    for (let x = 0; x < TEMPLATE_WIDTH; x++) {
      const dx = x - tipX;
      const dy = y - tipY;
      const tipBlob = Math.exp(-(dx * dx + dy * dy) / (2 * tipRadiusSq));
      const bladeBand = Math.exp(-(dy * dy) / (2 * 1.1 * 1.1));
      const value = 1 + tipBlob * 3 + bladeBand * 1.8;
      values[y * TEMPLATE_WIDTH + x] = value;
      sum += value;
    }
  }

  const invMean = size / Math.max(1e-6, sum);
  for (let i = 0; i < size; i++) {
    values[i] *= invMean;
  }

  return {
    values,
    sum: values.reduce((acc, v) => acc + v, 0),
  };
})();

const templateStateByTrack: Record<TrackId, TemplateTrackState> = {
  A: { dynamic: null, snapshots: [] },
  B: { dynamic: null, snapshots: [] },
};

const temporalStateByTrack: Record<TrackId, TemporalTrackState> = {
  A: {
    tip: null,
    vel: { x: 0, y: 0 },
    dir: null,
    length: 0,
    confidence: 0,
  },
  B: {
    tip: null,
    vel: { x: 0, y: 0 },
    dir: null,
    length: 0,
    confidence: 0,
  },
};

const adaptiveTuningStateByTrack: Record<TrackId, AdaptiveTrackState> = {
  A: {
    extensionMultiplier: null,
    wristWeight: null,
    anchorExtensionMultiplier: null,
    anchorWristWeight: null,
    lastAppliedExtensionMultiplier: null,
    lastAppliedWristWeight: null,
    acceptanceEma: 0.5,
    backwardRejectEma: 0,
    lengthErrorEma: 0,
    fanMarginEma: 0,
    directionDeltaDegEma: 0,
    framesSinceUpdate: 0,
  },
  B: {
    extensionMultiplier: null,
    wristWeight: null,
    anchorExtensionMultiplier: null,
    anchorWristWeight: null,
    lastAppliedExtensionMultiplier: null,
    lastAppliedWristWeight: null,
    acceptanceEma: 0.5,
    backwardRejectEma: 0,
    lengthErrorEma: 0,
    fanMarginEma: 0,
    directionDeltaDegEma: 0,
    framesSinceUpdate: 0,
  },
};

function resetTemplateRefinementMemory(): void {
  templateStateByTrack.A = { dynamic: null, snapshots: [] };
  templateStateByTrack.B = { dynamic: null, snapshots: [] };
}

function resetTemporalRefinementMemory(): void {
  temporalStateByTrack.A = {
    tip: null,
    vel: { x: 0, y: 0 },
    dir: null,
    length: 0,
    confidence: 0,
  };
  temporalStateByTrack.B = {
    tip: null,
    vel: { x: 0, y: 0 },
    dir: null,
    length: 0,
    confidence: 0,
  };
}

function resetAdaptiveTuningState(): void {
  adaptiveTuningStateByTrack.A = {
    extensionMultiplier: null,
    wristWeight: null,
    anchorExtensionMultiplier: null,
    anchorWristWeight: null,
    lastAppliedExtensionMultiplier: null,
    lastAppliedWristWeight: null,
    acceptanceEma: 0.5,
    backwardRejectEma: 0,
    lengthErrorEma: 0,
    fanMarginEma: 0,
    directionDeltaDegEma: 0,
    framesSinceUpdate: 0,
  };
  adaptiveTuningStateByTrack.B = {
    extensionMultiplier: null,
    wristWeight: null,
    anchorExtensionMultiplier: null,
    anchorWristWeight: null,
    lastAppliedExtensionMultiplier: null,
    lastAppliedWristWeight: null,
    acceptanceEma: 0.5,
    backwardRejectEma: 0,
    lengthErrorEma: 0,
    fanMarginEma: 0,
    directionDeltaDegEma: 0,
    framesSinceUpdate: 0,
  };
}

function frameToLuma(frame: VideoFramePixels): LumaFrame {
  const size = frame.width * frame.height;
  const luma = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const j = i * 4;
    luma[i] = (0.2126 * frame.rgba[j] + 0.7152 * frame.rgba[j + 1] + 0.0722 * frame.rgba[j + 2]) / 255;
  }
  return { width: frame.width, height: frame.height, luma };
}

function extractTemplatePatch(
  frame: LumaFrame,
  tipXNorm: number,
  tipYNorm: number
): Float32Array | null {
  const anchorPx = Math.round(TEMPLATE_ANCHOR_X * (TEMPLATE_WIDTH - 1));
  const anchorPy = Math.round(TEMPLATE_ANCHOR_Y * (TEMPLATE_HEIGHT - 1));
  const tipX = Math.round(tipXNorm * frame.width);
  const tipY = Math.round(tipYNorm * frame.height);
  const x0 = tipX - anchorPx;
  const y0 = tipY - anchorPy;

  if (x0 < 0 || y0 < 0 || x0 + TEMPLATE_WIDTH > frame.width || y0 + TEMPLATE_HEIGHT > frame.height) {
    return null;
  }

  const out = new Float32Array(TEMPLATE_WIDTH * TEMPLATE_HEIGHT);
  for (let y = 0; y < TEMPLATE_HEIGHT; y++) {
    const srcRow = (y0 + y) * frame.width + x0;
    const dstRow = y * TEMPLATE_WIDTH;
    for (let x = 0; x < TEMPLATE_WIDTH; x++) {
      out[dstRow + x] = frame.luma[srcRow + x];
    }
  }
  return out;
}

function buildTemplateDescriptor(values: Float32Array): TemplateDescriptor {
  const centered = new Float32Array(values.length);
  const weights = templateWeightMask.values;
  const weightSum = templateWeightMask.sum;

  let mean = 0;
  for (let i = 0; i < values.length; i++) {
    mean += values[i] * weights[i];
  }
  mean /= Math.max(weightSum, 1e-6);

  let energy = 0;
  for (let i = 0; i < values.length; i++) {
    const c = values[i] - mean;
    centered[i] = c;
    energy += weights[i] * c * c;
  }

  return {
    values,
    centered,
    norm: Math.sqrt(Math.max(energy, 1e-12)),
  };
}

function blendTemplate(
  descriptor: TemplateDescriptor,
  patch: Float32Array,
  alpha: number
): TemplateDescriptor {
  const next = new Float32Array(descriptor.values.length);
  const clampedAlpha = clampRange(alpha, 0, 1);
  for (let i = 0; i < next.length; i++) {
    next[i] = descriptor.values[i] * (1 - clampedAlpha) + patch[i] * clampedAlpha;
  }
  return buildTemplateDescriptor(next);
}

function evaluateTemplateAt(frame: LumaFrame, descriptor: TemplateDescriptor, x0: number, y0: number): number {
  const weights = templateWeightMask.values;
  const weightSum = templateWeightMask.sum;

  let mean = 0;
  for (let y = 0; y < TEMPLATE_HEIGHT; y++) {
    const srcRow = (y0 + y) * frame.width + x0;
    const tplRow = y * TEMPLATE_WIDTH;
    for (let x = 0; x < TEMPLATE_WIDTH; x++) {
      const idx = tplRow + x;
      mean += frame.luma[srcRow + x] * weights[idx];
    }
  }
  mean /= Math.max(weightSum, 1e-6);

  let dot = 0;
  let energy = 0;
  for (let y = 0; y < TEMPLATE_HEIGHT; y++) {
    const srcRow = (y0 + y) * frame.width + x0;
    const tplRow = y * TEMPLATE_WIDTH;
    for (let x = 0; x < TEMPLATE_WIDTH; x++) {
      const idx = tplRow + x;
      const centered = frame.luma[srcRow + x] - mean;
      const weight = weights[idx];
      dot += weight * centered * descriptor.centered[idx];
      energy += weight * centered * centered;
    }
  }

  const denom = Math.sqrt(Math.max(energy, 1e-12)) * Math.max(descriptor.norm, 1e-12);
  return denom > 1e-9 ? dot / denom : -1;
}

function maybeAddTemplateSnapshot(state: TemplateTrackState, descriptor: TemplateDescriptor): void {
  if (state.snapshots.length < TEMPLATE_MAX_SNAPSHOTS) {
    state.snapshots.push(descriptor);
    return;
  }
  state.snapshots.shift();
  state.snapshots.push(descriptor);
}

function applyTemplateRefinement(
  track: TrackId,
  frame: LumaFrame,
  priorTip: { x: number; y: number },
  priorConfidence: number
): TemplateRefinementResult | null {
  if (!templateExperimentEnabled || !TEMPLATE_EXPERIMENT_TRACKS.has(track)) return null;

  const state = templateStateByTrack[track];
  if (!state.dynamic) {
    const initialPatch = extractTemplatePatch(frame, priorTip.x, priorTip.y);
    if (!initialPatch) return null;
    state.dynamic = buildTemplateDescriptor(initialPatch);
  }

  const templates = [state.dynamic, ...state.snapshots].filter(Boolean) as TemplateDescriptor[];
  if (templates.length === 0) return null;

  const radiusNorm = clampRange(
    TEMPLATE_BASE_SEARCH_RADIUS_NORM + (1 - clamp01(priorConfidence)) * 0.03,
    TEMPLATE_BASE_SEARCH_RADIUS_NORM,
    TEMPLATE_MAX_SEARCH_RADIUS_NORM
  );
  const rx = Math.max(2, Math.round(radiusNorm * frame.width));
  const ry = Math.max(2, Math.round(radiusNorm * frame.height));
  const anchorPx = Math.round(TEMPLATE_ANCHOR_X * (TEMPLATE_WIDTH - 1));
  const anchorPy = Math.round(TEMPLATE_ANCHOR_Y * (TEMPLATE_HEIGHT - 1));
  const priorX = Math.round(priorTip.x * frame.width);
  const priorY = Math.round(priorTip.y * frame.height);

  let bestScore = Number.NEGATIVE_INFINITY;
  let secondScore = Number.NEGATIVE_INFINITY;
  let bestTipX = priorX;
  let bestTipY = priorY;
  let bestTemplateIndex = 0;

  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const tipX = priorX + dx;
      const tipY = priorY + dy;
      const x0 = tipX - anchorPx;
      const y0 = tipY - anchorPy;
      if (x0 < 0 || y0 < 0 || x0 + TEMPLATE_WIDTH > frame.width || y0 + TEMPLATE_HEIGHT > frame.height) continue;

      for (let i = 0; i < templates.length; i++) {
        const score = evaluateTemplateAt(frame, templates[i], x0, y0);
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          bestTipX = tipX;
          bestTipY = tipY;
          bestTemplateIndex = i;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
    }
  }

  if (!Number.isFinite(bestScore) || bestScore <= -0.99) return null;

  const bestNorm = {
    x: clamp01(bestTipX / frame.width),
    y: clamp01(bestTipY / frame.height),
  };
  const shiftNorm = Math.sqrt(
    (bestNorm.x - priorTip.x) * (bestNorm.x - priorTip.x) + (bestNorm.y - priorTip.y) * (bestNorm.y - priorTip.y)
  );
  const margin = Number.isFinite(secondScore) ? bestScore - secondScore : bestScore;
  const applied =
    bestScore >= TEMPLATE_MATCH_MIN_SCORE &&
    margin >= TEMPLATE_MATCH_MIN_MARGIN &&
    shiftNorm <= TEMPLATE_MATCH_MAX_SHIFT_NORM;

  const blended = applied
    ? {
        x: clamp01(priorTip.x + (bestNorm.x - priorTip.x) * TEMPLATE_MATCH_BLEND),
        y: clamp01(priorTip.y + (bestNorm.y - priorTip.y) * TEMPLATE_MATCH_BLEND),
      }
    : priorTip;

  if (bestScore >= TEMPLATE_UPDATE_MIN_SCORE) {
    const patch = extractTemplatePatch(frame, bestNorm.x, bestNorm.y);
    if (patch) {
      const descriptor = buildTemplateDescriptor(patch);
      state.dynamic = blendTemplate(state.dynamic, patch, 0.18);
      if (bestScore >= TEMPLATE_SNAPSHOT_MIN_SCORE) {
        maybeAddTemplateSnapshot(state, descriptor);
      }
    }
  }

  return {
    tip: blended,
    applied,
    score: bestScore,
    secondScore,
    margin,
    templateIndex: bestTemplateIndex,
    shiftFromPriorNorm: shiftNorm,
    searchRadiusPx: Math.max(rx, ry),
  };
}

function distancePxBetweenNormalized(
  a: { x: number; y: number },
  b: { x: number; y: number },
  frameWidth: number,
  frameHeight: number
): number {
  const dx = (a.x - b.x) * frameWidth;
  const dy = (a.y - b.y) * frameHeight;
  return Math.sqrt(dx * dx + dy * dy);
}

function blendPoint(
  base: { x: number; y: number },
  target: { x: number; y: number },
  alpha: number
): { x: number; y: number } {
  const w = clampRange(alpha, 0, 1);
  return {
    x: clamp01(base.x + (target.x - base.x) * w),
    y: clamp01(base.y + (target.y - base.y) * w),
  };
}

function applyTemporalTipStabilization(
  track: TrackId,
  wrist: { x: number; y: number },
  tip: { x: number; y: number },
  sourceWidth: number,
  sourceHeight: number,
  refinementApplied: boolean,
  measurementConfidence: number
): {
  tip: { x: number; y: number };
  expectedTip?: { x: number; y: number };
  priorBlend: number;
  pull: number;
  stateConfidence: number;
} {
  if (!temporalRefinementEnabled || !TEMPORAL_REFINEMENT_TRACKS.has(track)) {
    return {
      tip,
      priorBlend: 0,
      pull: 0,
      stateConfidence: 0,
    };
  }

  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const state = temporalStateByTrack[track];

  let outTip = { x: clamp01(tip.x), y: clamp01(tip.y) };
  let expectedTip: { x: number; y: number } | undefined;
  let priorBlend = 0;
  let pull = 0;

  if (state.dir && state.length > 1e-5) {
    expectedTip = {
      x: clamp01(wrist.x + state.dir.x * state.length + state.vel.x),
      y: clamp01(wrist.y + state.dir.y * state.length + state.vel.y),
    };

    const expectedShiftPx = distancePxBetweenNormalized(expectedTip, outTip, width, height);
    if (expectedShiftPx <= TEMPORAL_PRIOR_MAX_SHIFT_PX) {
      priorBlend = clampRange(TEMPORAL_PRIOR_WEIGHT * clamp01(state.confidence), 0, TEMPORAL_PRIOR_WEIGHT);
      outTip = blendPoint(outTip, expectedTip, priorBlend);
    }

    pull = clampRange(TEMPORAL_EXPECTED_BLEND * clamp01(state.confidence), 0, 0.75);
    const appliedPull = refinementApplied ? pull : pull * 0.5;
    outTip = blendPoint(outTip, expectedTip, appliedPull);
    pull = appliedPull;
  }

  const measuredDir = normalizeDirection(outTip.x - wrist.x, outTip.y - wrist.y);
  const measuredLength = Math.sqrt(
    (outTip.x - wrist.x) * (outTip.x - wrist.x) + (outTip.y - wrist.y) * (outTip.y - wrist.y)
  );

  let nextVel = state.vel;
  if (state.tip) {
    let targetVel = {
      x: outTip.x - state.tip.x,
      y: outTip.y - state.tip.y,
    };
    const stepPx = Math.sqrt((targetVel.x * width) * (targetVel.x * width) + (targetVel.y * height) * (targetVel.y * height));
    if (stepPx > TEMPORAL_MAX_STEP_PX && stepPx > 1e-6) {
      const scale = TEMPORAL_MAX_STEP_PX / stepPx;
      targetVel = {
        x: targetVel.x * scale,
        y: targetVel.y * scale,
      };
    }
    nextVel = {
      x: state.vel.x * (1 - TEMPORAL_VEL_ALPHA) + targetVel.x * TEMPORAL_VEL_ALPHA,
      y: state.vel.y * (1 - TEMPORAL_VEL_ALPHA) + targetVel.y * TEMPORAL_VEL_ALPHA,
    };
  }

  const nextDir = measuredDir
    ? normalizeDirection(
        (state.dir?.x ?? measuredDir.x) * (1 - TEMPORAL_DIR_ALPHA) + measuredDir.x * TEMPORAL_DIR_ALPHA,
        (state.dir?.y ?? measuredDir.y) * (1 - TEMPORAL_DIR_ALPHA) + measuredDir.y * TEMPORAL_DIR_ALPHA
      ) ?? measuredDir
    : state.dir;

  const nextLength =
    Number.isFinite(measuredLength) && measuredLength > 1e-6
      ? state.length > 1e-6
        ? state.length * (1 - TEMPORAL_LENGTH_ALPHA) + measuredLength * TEMPORAL_LENGTH_ALPHA
        : measuredLength
      : state.length;

  let measuredConfidence = clamp01(measurementConfidence);
  if (!refinementApplied) {
    measuredConfidence = Math.max(0.06, measuredConfidence * 0.4);
  }
  const nextConfidence = clamp01(state.confidence * 0.72 + measuredConfidence * 0.28);

  temporalStateByTrack[track] = {
    tip: outTip,
    vel: nextVel,
    dir: nextDir,
    length: nextLength,
    confidence: nextConfidence,
  };

  return {
    tip: outTip,
    expectedTip,
    priorBlend,
    pull,
    stateConfidence: nextConfidence,
  };
}

function updateEma(prev: number, next: number, alpha: number): number {
  return prev * (1 - alpha) + next * alpha;
}

function maybeAdoptManualTuningOverride(track: TrackId, currentExtension: number, currentWristWeight: number): void {
  const state = adaptiveTuningStateByTrack[track];

  if (state.extensionMultiplier === null) {
    state.extensionMultiplier = currentExtension;
    state.anchorExtensionMultiplier = currentExtension;
    state.lastAppliedExtensionMultiplier = currentExtension;
  } else if (
    state.lastAppliedExtensionMultiplier !== null &&
    Math.abs(currentExtension - state.lastAppliedExtensionMultiplier) >= ADAPTIVE_EXTERNAL_EXTENSION_OVERRIDE_DELTA
  ) {
    state.extensionMultiplier = currentExtension;
    state.anchorExtensionMultiplier = currentExtension;
    state.lastAppliedExtensionMultiplier = currentExtension;
  }

  if (state.wristWeight === null) {
    state.wristWeight = currentWristWeight;
    state.anchorWristWeight = currentWristWeight;
    state.lastAppliedWristWeight = currentWristWeight;
  } else if (
    state.lastAppliedWristWeight !== null &&
    Math.abs(currentWristWeight - state.lastAppliedWristWeight) >= ADAPTIVE_EXTERNAL_WRIST_OVERRIDE_DELTA
  ) {
    state.wristWeight = currentWristWeight;
    state.anchorWristWeight = currentWristWeight;
    state.lastAppliedWristWeight = currentWristWeight;
  }
}

function applyAdaptiveFencerTuning(
  track: TrackId,
  metrics: {
    refinementAccepted: boolean;
    rejectedBackward: boolean;
    endpointLengthRatio?: number;
    fanMargin: number;
    directionDeltaDeg?: number;
  }
): {
  extensionMultiplier: number;
  wristWeight: number;
  acceptanceEma: number;
  backwardRejectEma: number;
  lengthErrorEma: number;
  fanMarginEma: number;
} | null {
  if (!adaptiveFencerTuningEnabled || !ADAPTIVE_TUNING_TRACKS.has(track)) {
    return null;
  }

  const state = adaptiveTuningStateByTrack[track];
  const current = getFencerDirectionTuning(track);
  maybeAdoptManualTuningOverride(track, current.extensionMultiplier, current.wristWeight);

  const lengthError =
    typeof metrics.endpointLengthRatio === 'number' && Number.isFinite(metrics.endpointLengthRatio)
      ? Math.min(1.2, Math.abs(metrics.endpointLengthRatio - 1))
      : state.lengthErrorEma;
  const directionDeltaNorm =
    typeof metrics.directionDeltaDeg === 'number' && Number.isFinite(metrics.directionDeltaDeg)
      ? Math.min(90, Math.abs(metrics.directionDeltaDeg))
      : state.directionDeltaDegEma;

  state.acceptanceEma = updateEma(state.acceptanceEma, metrics.refinementAccepted ? 1 : 0, ADAPTIVE_EMA_ALPHA);
  state.backwardRejectEma = updateEma(state.backwardRejectEma, metrics.rejectedBackward ? 1 : 0, ADAPTIVE_EMA_ALPHA);
  state.lengthErrorEma = updateEma(state.lengthErrorEma, lengthError, ADAPTIVE_EMA_ALPHA);
  state.fanMarginEma = updateEma(state.fanMarginEma, clampRange(metrics.fanMargin, 0, 1), ADAPTIVE_EMA_ALPHA);
  state.directionDeltaDegEma = updateEma(state.directionDeltaDegEma, directionDeltaNorm, ADAPTIVE_EMA_ALPHA);
  state.framesSinceUpdate += 1;

  const extension = state.extensionMultiplier ?? current.extensionMultiplier;
  const wristWeight = state.wristWeight ?? current.wristWeight;

  if (state.framesSinceUpdate < ADAPTIVE_UPDATE_INTERVAL_FRAMES) {
    return {
      extensionMultiplier: extension,
      wristWeight,
      acceptanceEma: state.acceptanceEma,
      backwardRejectEma: state.backwardRejectEma,
      lengthErrorEma: state.lengthErrorEma,
      fanMarginEma: state.fanMarginEma,
    };
  }
  state.framesSinceUpdate = 0;

  const bounds = ADAPTIVE_EXTENSION_BOUNDS[track];
  let nextExtension = extension;
  let extensionDelta = 0;

  if (state.acceptanceEma < 0.34 && state.lengthErrorEma > 0.2) {
    extensionDelta += 0.07;
  }
  if (state.acceptanceEma < 0.28 && state.fanMarginEma < 0.06) {
    extensionDelta += 0.04;
  }
  if (state.backwardRejectEma > 0.12 || state.directionDeltaDegEma > 30 || state.lengthErrorEma > 0.46) {
    extensionDelta -= 0.08;
  }
  if (state.acceptanceEma > 0.62 && state.backwardRejectEma < 0.05 && state.lengthErrorEma < 0.15) {
    const anchor = state.anchorExtensionMultiplier ?? extension;
    extensionDelta += (anchor - extension) * 0.2;
  }

  if (Math.abs(extensionDelta) > 0.005) {
    nextExtension = clampRange(extension + extensionDelta, bounds.min, bounds.max);
  }

  const wristBounds = ADAPTIVE_WRIST_BOUNDS[track];
  let nextWristWeight = wristWeight;
  if (track === 'B') {
    let wristDelta = 0;
    if (state.acceptanceEma < 0.33 || state.backwardRejectEma > 0.1 || state.fanMarginEma < 0.05) {
      wristDelta += 0.05;
    }
    if (state.acceptanceEma > 0.58 && state.backwardRejectEma < 0.05 && state.directionDeltaDegEma < 20) {
      wristDelta -= 0.03;
    }
    if (state.acceptanceEma > 0.68 && state.lengthErrorEma < 0.12) {
      const anchorWrist = state.anchorWristWeight ?? wristWeight;
      wristDelta += (anchorWrist - wristWeight) * 0.25;
    }
    if (Math.abs(wristDelta) > 0.005) {
      nextWristWeight = clampRange(wristWeight + wristDelta, wristBounds.min, wristBounds.max);
    }
  }

  const patch: { extensionMultiplier?: number; wristWeight?: number } = {};
  if (Math.abs(nextExtension - current.extensionMultiplier) > 0.001) {
    patch.extensionMultiplier = nextExtension;
  }
  if (Math.abs(nextWristWeight - current.wristWeight) > 0.001) {
    patch.wristWeight = nextWristWeight;
  }
  if (patch.extensionMultiplier !== undefined || patch.wristWeight !== undefined) {
    setFencerDirectionTuning(track, patch);
  }

  state.extensionMultiplier = nextExtension;
  state.wristWeight = nextWristWeight;
  state.lastAppliedExtensionMultiplier = nextExtension;
  state.lastAppliedWristWeight = nextWristWeight;

  return {
    extensionMultiplier: nextExtension,
    wristWeight: nextWristWeight,
    acceptanceEma: state.acceptanceEma,
    backwardRejectEma: state.backwardRejectEma,
    lengthErrorEma: state.lengthErrorEma,
    fanMarginEma: state.fanMarginEma,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeDirection(dx: number, dy: number): { x: number; y: number } | null {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: dx / len, y: dy / len };
}

function directionDeltaDegrees(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null
): number | null {
  if (!a || !b) return null;
  const dot = clampRange(a.x * b.x + a.y * b.y, -1, 1);
  return (Math.acos(dot) * 180) / Math.PI;
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

export function setFencerTemplateRefinementEnabled(enabled: boolean): void {
  templateExperimentEnabled = enabled;
  if (!enabled) {
    resetTemplateRefinementMemory();
  }
}

export function isFencerTemplateRefinementEnabled(): boolean {
  return templateExperimentEnabled;
}

export function setFencerTemporalRefinementEnabled(enabled: boolean): void {
  temporalRefinementEnabled = enabled;
  if (!enabled) {
    resetTemporalRefinementMemory();
  }
}

export function isFencerTemporalRefinementEnabled(): boolean {
  return temporalRefinementEnabled;
}

export function setFencerAdaptiveTuningEnabled(enabled: boolean): void {
  adaptiveFencerTuningEnabled = enabled;
  if (!enabled) {
    resetAdaptiveTuningState();
  }
}

export function isFencerAdaptiveTuningEnabled(): boolean {
  return adaptiveFencerTuningEnabled;
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

function resetRefinementMemory(): void {
  refinementMemoryByTrack.A = { dir: null, length: null };
  refinementMemoryByTrack.B = { dir: null, length: null };
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
  const lumaFrame = refinementFrame && templateExperimentEnabled ? frameToLuma(refinementFrame) : null;
  const sourceWidth = Math.max(1, video.videoWidth || refinementFrame?.width || 1920);
  const sourceHeight = Math.max(1, video.videoHeight || refinementFrame?.height || 1080);

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
    const forearmDir = normalizeDirection(forearmDx, forearmDy);
    if (!forearmDir) continue;

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

      const memory = refinementMemoryByTrack[tuningTrack];
      const predictedDir = normalizeDirection(baseTip.x - wrist.x, baseTip.y - wrist.y);
      const measuredRayDir = refinement.bestDirection
        ? normalizeDirection(refinement.bestDirection.x, refinement.bestDirection.y)
        : null;
      const measuredEndpointDir =
        refinement.endpoint && Number.isFinite(refinement.endpoint.x) && Number.isFinite(refinement.endpoint.y)
          ? normalizeDirection(refinement.endpoint.x - wrist.x, refinement.endpoint.y - wrist.y)
          : null;
      const measuredDir = measuredEndpointDir ?? measuredRayDir;

      const angleConfidence = refinement.angleConfidence ?? refinement.confidence;
      const endpointConfidence = refinement.endpointConfidence ?? refinement.confidence;
      const fanMargin = refinement.fanMargin ?? 0;
      const bestFanAngleDeg = Math.abs(refinement.bestFanAngleDeg ?? 0);
      const trustProfile = REFINEMENT_TRUST_PROFILE[tuningTrack];

      const endpointLength =
        refinement.endpoint && Number.isFinite(refinement.endpoint.x) && Number.isFinite(refinement.endpoint.y)
          ? Math.sqrt(
              (refinement.endpoint.x - wrist.x) * (refinement.endpoint.x - wrist.x) +
                (refinement.endpoint.y - wrist.y) * (refinement.endpoint.y - wrist.y)
            )
          : Number.NaN;

      const minLength = Math.max(0.03, forearmLength * 0.45);
      const maxLength = Math.max(minLength + 0.02, Math.min(0.95, forearmLength * 6));
      const endpointLengthRatio =
        Number.isFinite(endpointLength) && smoothedExtensionLength > 1e-6
          ? endpointLength / smoothedExtensionLength
          : Number.NaN;

      const directionDeltaDeg = directionDeltaDegrees(predictedDir ?? memory.dir, measuredDir);

      let trustDirection =
        Boolean(measuredDir) &&
        angleConfidence >= trustProfile.minDirectionConfidence &&
        fanMargin >= trustProfile.minFanMargin &&
        bestFanAngleDeg <= trustProfile.maxBestFanAngleDeg;

      if (
        trustDirection &&
        typeof directionDeltaDeg === 'number' &&
        Number.isFinite(directionDeltaDeg) &&
        directionDeltaDeg > trustProfile.maxDirectionDeltaDeg
      ) {
        trustDirection = false;
      }

      let trustLength =
        Number.isFinite(endpointLength) &&
        endpointConfidence >= trustProfile.minLengthConfidence &&
        Number.isFinite(endpointLengthRatio) &&
        Math.abs(endpointLengthRatio - 1) <= trustProfile.maxLengthRatioDelta;

      let selectedDir = predictedDir ?? memory.dir;
      if (measuredDir && trustDirection) {
        if (memory.dir) {
          selectedDir =
            normalizeDirection(
              memory.dir.x * trustProfile.directionMemoryBlend + measuredDir.x * (1 - trustProfile.directionMemoryBlend),
              memory.dir.y * trustProfile.directionMemoryBlend + measuredDir.y * (1 - trustProfile.directionMemoryBlend)
            ) ?? measuredDir;
        } else {
          selectedDir = measuredDir;
        }
      } else if (memory.dir && trustProfile.useMemoryOnRejectedDirection) {
        selectedDir = memory.dir;
        refinement.reusedDirection = true;
      } else {
        refinement.reusedDirection = true;
      }

      let selectedLength = smoothedExtensionLength;
      if (Number.isFinite(endpointLength) && trustLength) {
        const measuredLength = clampRange(endpointLength, minLength, maxLength);
        if (typeof memory.length === 'number' && Number.isFinite(memory.length)) {
          selectedLength = memory.length + (measuredLength - memory.length) * (1 - trustProfile.lengthMemoryBlend);
        } else {
          selectedLength = measuredLength;
        }
      } else if (
        trustProfile.useMemoryOnRejectedLength &&
        typeof memory.length === 'number' &&
        Number.isFinite(memory.length)
      ) {
        selectedLength = memory.length;
        refinement.reusedLength = true;
      } else {
        refinement.reusedLength = true;
      }

      if (!selectedDir) {
        selectedDir = normalizeDirection(seedDx, seedDy) ?? { x: 1, y: 0 };
      }

      selectedLength = clampRange(selectedLength, minLength, maxLength);

      const refinedPoint = {
        x: clamp01(wrist.x + selectedDir.x * selectedLength),
        y: clamp01(wrist.y + selectedDir.y * selectedLength),
      };

      const shiftFromPrior = Math.sqrt(
        (refinedPoint.x - baseTip.x) * (refinedPoint.x - baseTip.x) +
          (refinedPoint.y - baseTip.y) * (refinedPoint.y - baseTip.y)
      );
      const shiftLimit =
        fanMargin < trustProfile.lowMarginThreshold
          ? trustProfile.maxRefinedShiftLowMargin
          : trustProfile.maxRefinedShift;

      if (shiftFromPrior > shiftLimit) {
        trustDirection = false;
        trustLength = false;
        refinement.reusedDirection = true;
        refinement.reusedLength = true;
        refinedPoint.x = baseTip.x;
        refinedPoint.y = baseTip.y;
      }

      let refinementAccepted = trustProfile.requireDirectionAndLengthTrust
        ? trustDirection && trustLength
        : !refinement.reusedDirection || !refinement.reusedLength;

      if (!refinementAccepted) {
        refinedPoint.x = baseTip.x;
        refinedPoint.y = baseTip.y;
        refinement.reusedDirection = true;
        refinement.reusedLength = true;
      } else if (trustProfile.refinedTipBlend < 0.999) {
        const blend = clampRange(trustProfile.refinedTipBlend, 0, 1);
        refinedPoint.x = clamp01(baseTip.x + (refinedPoint.x - baseTip.x) * blend);
        refinedPoint.y = clamp01(baseTip.y + (refinedPoint.y - baseTip.y) * blend);
      }

      if (lumaFrame && templateExperimentEnabled) {
        const templateResult = applyTemplateRefinement(
          tuningTrack,
          lumaFrame,
          { x: refinedPoint.x, y: refinedPoint.y },
          refinement.confidence
        );
        if (templateResult) {
          refinement.templateScore = templateResult.score;
          refinement.templateSecondScore = templateResult.secondScore;
          refinement.templateMargin = templateResult.margin;
          refinement.templateApplied = templateResult.applied;
          refinement.templateTemplateIndex = templateResult.templateIndex;
          refinement.templateShiftFromPrior = templateResult.shiftFromPriorNorm;
          refinement.templateSearchRadiusPx = templateResult.searchRadiusPx;
          if (templateResult.applied) {
            refinedPoint.x = templateResult.tip.x;
            refinedPoint.y = templateResult.tip.y;
            refinementAccepted = true;
          }
        }
      }

      let finalDir = normalizeDirection(refinedPoint.x - wrist.x, refinedPoint.y - wrist.y);
      let backwardDot = finalDir ? forearmDir.x * finalDir.x + forearmDir.y * finalDir.y : null;
      if (
        typeof backwardDot === 'number' &&
        Number.isFinite(backwardDot) &&
        backwardDot < BACKWARD_DIRECTION_DOT_THRESHOLD
      ) {
        refinedPoint.x = baseTip.x;
        refinedPoint.y = baseTip.y;
        refinementAccepted = false;
        refinement.reusedDirection = true;
        refinement.reusedLength = true;
        refinement.rejectedBackward = true;
      }

      const measurementConfidence = clamp01(
        Math.max(
          refinement.confidence,
          refinement.endpointConfidence ?? refinement.confidence,
          refinement.templateApplied ? 0.72 : 0
        )
      );
      const temporalResult = applyTemporalTipStabilization(
        tuningTrack,
        { x: wrist.x, y: wrist.y },
        { x: refinedPoint.x, y: refinedPoint.y },
        sourceWidth,
        sourceHeight,
        refinementAccepted,
        measurementConfidence
      );
      refinedPoint.x = temporalResult.tip.x;
      refinedPoint.y = temporalResult.tip.y;
      refinement.temporalPriorBlend = temporalResult.priorBlend;
      refinement.temporalPull = temporalResult.pull;
      refinement.temporalStateConfidence = temporalResult.stateConfidence;
      if (temporalResult.expectedTip) {
        refinement.temporalExpected = temporalResult.expectedTip;
      }

      finalDir = normalizeDirection(refinedPoint.x - wrist.x, refinedPoint.y - wrist.y);
      backwardDot = finalDir ? forearmDir.x * finalDir.x + forearmDir.y * finalDir.y : null;
      if (
        typeof backwardDot === 'number' &&
        Number.isFinite(backwardDot) &&
        backwardDot < BACKWARD_DIRECTION_DOT_THRESHOLD
      ) {
        refinedPoint.x = baseTip.x;
        refinedPoint.y = baseTip.y;
        refinementAccepted = false;
        refinement.reusedDirection = true;
        refinement.reusedLength = true;
        refinement.rejectedBackward = true;
      }

      const finalShiftFromPrior = Math.sqrt(
        (refinedPoint.x - baseTip.x) * (refinedPoint.x - baseTip.x) +
          (refinedPoint.y - baseTip.y) * (refinedPoint.y - baseTip.y)
      );

      refinement.refined = refinedPoint;
      refinement.directionDeltaDeg = typeof directionDeltaDeg === 'number' ? directionDeltaDeg : undefined;
      refinement.endpointLengthRatio = Number.isFinite(endpointLengthRatio) ? endpointLengthRatio : undefined;
      refinement.refinedShiftFromPrior = finalShiftFromPrior;
      refinement.backwardDot = typeof backwardDot === 'number' ? backwardDot : undefined;
      refinement.trustedDirection = trustDirection;
      refinement.trustedLength = trustLength;
      refinement.refinementAccepted = refinementAccepted;
      refinement.reusedPrevious = Boolean(refinement.reusedDirection || refinement.reusedLength);

      const adaptiveTuning = applyAdaptiveFencerTuning(tuningTrack, {
        refinementAccepted,
        rejectedBackward: Boolean(refinement.rejectedBackward),
        endpointLengthRatio: Number.isFinite(endpointLengthRatio) ? endpointLengthRatio : undefined,
        fanMargin,
        directionDeltaDeg: typeof directionDeltaDeg === 'number' ? directionDeltaDeg : undefined,
      });
      if (adaptiveTuning) {
        refinement.adaptiveExtensionMultiplier = adaptiveTuning.extensionMultiplier;
        refinement.adaptiveWristWeight = adaptiveTuning.wristWeight;
        refinement.adaptiveAcceptanceEma = adaptiveTuning.acceptanceEma;
        refinement.adaptiveBackwardRejectEma = adaptiveTuning.backwardRejectEma;
        refinement.adaptiveLengthErrorEma = adaptiveTuning.lengthErrorEma;
        refinement.adaptiveFanMarginEma = adaptiveTuning.fanMarginEma;
      }

      refinementMemoryByTrack[tuningTrack] = {
        dir: !refinement.reusedDirection && trustDirection ? selectedDir : memory.dir,
        length: !refinement.reusedLength && trustLength ? selectedLength : memory.length,
      };

      tip = {
        ...baseTip,
        x: refinedPoint.x,
        y: refinedPoint.y,
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
  resetRefinementMemory();
  resetTemplateRefinementMemory();
  resetTemporalRefinementMemory();
  resetAdaptiveTuningState();
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
