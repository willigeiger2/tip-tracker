// Fencers trace: per-inference-frame tips (plus upper-body pose landmarks) for offline evaluation
// against hand-edited truth (scripts/evaluate_fencers_trace.py).

import { keyframesFromLiveSamples, keyframesFromScoredSamples } from '../recorded/auto-seed';
import { DEFAULT_FRAME_RATE, frameIndex } from '../app/frame-rate';
import type { FrameData } from '../app/render-modes';
import { appState, events, isVideoSource, session, video, type TrackId } from './app';
import {
  AUTO_SEED_SCORED_MAX_INTERP_GAP_FRAMES,
  AUTO_SEED_SCORED_MIN_QUALITY,
  AUTO_SEED_SCORED_OPTIONS,
  detectionQuality,
  draftFps,
  getSamples,
  getScoredSamples,
} from './auto-seed';
import { downloadJson } from './download';
import { frameRate } from './transport';

interface FencersTraceDetection {
  id: TrackId;
  side: 'left' | 'right';
  arm: 'left' | 'right' | null;
  tipTimestamp: number;
  tip: { x: number; y: number; confidence: number };
  rawExtensionLength?: number;
  smoothedExtensionLength?: number;
  lengthSmoothingAlpha?: number;
  seedQuality?: number;
  armMargin?: number | null;
  /** Upper-body pose landmarks keyed by MediaPipe index: [x, y, visibility]. */
  pose?: Record<number, [number, number, number]>;
}

interface FencersTraceEntry {
  frame: number;
  frameAt30: number;
  frameFps: number;
  mediaTime: number;
  detections: FencersTraceDetection[];
}

const MAX_ENTRIES = 25000;
// Nose, shoulders, elbows, wrists, hand points, hips: enough to re-run arm/tip heuristics offline.
const TRACE_POSE_LANDMARKS = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];

let entries: FencersTraceEntry[] = [];
let sessionId = `${Date.now()}`;
let lastTimestampByTrack: Record<TrackId, number | null> = { A: null, B: null };
let lastMediaTime: number | null = null;

function tracePoseLandmarks(
  landmarks: FrameData['detections'][number]['landmarks']
): Record<number, [number, number, number]> | undefined {
  if (!landmarks || landmarks.length < 25) return undefined;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  const out: Record<number, [number, number, number]> = {};
  for (const index of TRACE_POSE_LANDMARKS) {
    const lm = landmarks[index];
    if (!lm) continue;
    out[index] = [round(lm.x), round(lm.y), round(lm.visibility ?? 0)];
  }
  return out;
}

function inFencersMode(): boolean {
  return appState.get().trackingMode === 'fencers';
}

/** Publish the trace status line: a one-off message, or the computed summary. */
export function publishTraceStatus(customMessage?: string): void {
  if (customMessage) {
    events.emit('trace', { text: customMessage, canExport: inFencersMode() && entries.length > 0 });
    return;
  }
  if (entries.length === 0) {
    events.emit('trace', { text: 'Trace: 0 entries.', canExport: false });
    return;
  }
  const last = entries[entries.length - 1];
  events.emit('trace', {
    text: `Trace: ${entries.length} entries (last f${last.frame} @ ${last.mediaTime.toFixed(3)}s).`,
    canExport: inFencersMode(),
  });
}

export function resetTrace(reason: string): void {
  entries = [];
  sessionId = `${Date.now()}`;
  lastTimestampByTrack = { A: null, B: null };
  lastMediaTime = null;
  publishTraceStatus(`Trace: 0 entries (${reason}).`);
}

/** After-render hook: append new fencers detections while a video is the source. */
export function captureTrace(frame: FrameData): void {
  if (!isVideoSource()) return;
  if (frame.trackingMode !== 'fencers') return;
  if (frame.detections.length === 0) return;

  const mediaTime = video.currentTime;
  if (!Number.isFinite(mediaTime) || mediaTime < 0) return;

  if (lastMediaTime !== null && mediaTime < lastMediaTime - 0.25) {
    resetTrace('seeked backward');
  }

  const detections: FencersTraceDetection[] = [];
  for (const det of frame.detections) {
    const id: TrackId = det.id === 'B' ? 'B' : 'A';
    const tipTimestamp = Number.isFinite(det.tip.timestamp) ? det.tip.timestamp : Number.NaN;
    if (!Number.isFinite(tipTimestamp)) continue;
    const last = lastTimestampByTrack[id];
    if (last !== null && tipTimestamp <= last + 1e-6) continue;
    lastTimestampByTrack[id] = tipTimestamp;

    detections.push({
      id,
      side: det.side,
      arm: det.arm ?? null,
      tipTimestamp,
      tip: { x: det.tip.x, y: det.tip.y, confidence: det.tip.confidence },
      rawExtensionLength: det.rawExtensionLength,
      smoothedExtensionLength: det.smoothedExtensionLength,
      lengthSmoothingAlpha: det.lengthSmoothingAlpha,
      seedQuality: detectionQuality(det),
      armMargin: det.armMargin,
      pose: tracePoseLandmarks(det.landmarks),
    });
  }

  if (detections.length === 0) return;

  const frameFps = frameRate();
  entries.push({
    frame: frameIndex(mediaTime, frameFps),
    frameAt30: frameIndex(mediaTime, DEFAULT_FRAME_RATE),
    frameFps,
    mediaTime,
    detections,
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  lastMediaTime = mediaTime;
  publishTraceStatus();
}

export function exportTrace(): void {
  if (entries.length === 0) {
    publishTraceStatus('Trace: 0 entries. Capture a run first.');
    return;
  }

  const fps = draftFps();
  const samples = getSamples();
  const scored = getScoredSamples();
  const state = appState.get();

  const payload = {
    version: 1,
    exportedAt: Date.now(),
    sessionId,
    source: {
      kind: session.activeSource.kind,
      videoId: session.currentVideoId,
      videoUrl: session.currentVideoUrl,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : null,
    },
    settings: {
      debugMode: state.debugMode,
      inferenceFps: state.inferenceFps,
      fencerATipExtension: state.fencerATipExtension,
      fencerBTipExtension: state.fencerBTipExtension,
      fencerALengthSmoothing: state.fencerALengthSmoothingAlpha,
      fencerBLengthSmoothing: state.fencerBLengthSmoothingAlpha,
      fencerAWristWeight: state.fencerAWristWeight,
      fencerBWristWeight: state.fencerBWristWeight,
      fencerAAngleOffsetDeg: state.fencerAAngleOffsetDeg,
      fencerBAngleOffsetDeg: state.fencerBAngleOffsetDeg,
      fencerAWeaponArm: state.fencerAWeaponArm,
      fencerBWeaponArm: state.fencerBWeaponArm,
    },
    draftFromLiveSamples: {
      fps,
      sampleCounts: { A: samples.A.length, B: samples.B.length },
      tracks: [
        { id: 'A', keyframes: keyframesFromLiveSamples([...samples.A], fps) },
        { id: 'B', keyframes: keyframesFromLiveSamples([...samples.B], fps) },
      ],
    },
    draftFromScoredSamples: {
      fps,
      minQuality: AUTO_SEED_SCORED_MIN_QUALITY,
      maxInterpolatedGapFrames: AUTO_SEED_SCORED_MAX_INTERP_GAP_FRAMES,
      sampleCounts: { A: scored.A.length, B: scored.B.length },
      tracks: [
        { id: 'A', keyframes: keyframesFromScoredSamples([...scored.A], fps, AUTO_SEED_SCORED_OPTIONS) },
        { id: 'B', keyframes: keyframesFromScoredSamples([...scored.B], fps, AUTO_SEED_SCORED_OPTIONS) },
      ],
    },
    trace: entries,
  };

  const idPart = (session.currentVideoId || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'session';
  downloadJson(JSON.stringify(payload), `tiptrack-fencers-trace-${idPart}.json`);
  publishTraceStatus(`Trace exported: ${entries.length} entries.`);
}
