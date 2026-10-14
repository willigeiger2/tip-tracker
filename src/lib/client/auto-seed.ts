// Auto-seed: capture live tips while a video plays, then turn them into an editable recorded draft.

import {
  captureRanges,
  keyframesFromLiveSamples,
  keyframesFromScoredSamples,
  type LiveTipSample,
  type LiveTipScoredSample,
  type ScoredKeyframeOptions,
} from '../recorded/auto-seed';
import type { FrameData } from '../app/render-modes';
import type { TrackingMode } from '../../types/fencing';
import { appState, clearTrails, events, isVideoSource, mainLoop, session, setStatus, video, type TrackId } from './app';
import { formatClock } from './format';
import { applyDraft, keyframesInRanges } from './recorded';

type LiveMode = Exclude<TrackingMode, 'recorded'>;

export const AUTO_SEED_SCORED_MIN_QUALITY = 0.55;
export const AUTO_SEED_SCORED_MAX_INTERP_GAP_FRAMES = 0;
const AUTO_SEED_FILTERED_MAX_GAP_SECONDS = 0.6;
/** Capture times further apart than this (e.g. after skipping forward) form separate draft ranges. */
const CAPTURE_RANGE_SPLIT_SECONDS = 0.5;
export const AUTO_SEED_SCORED_OPTIONS: ScoredKeyframeOptions = {
  minQuality: AUTO_SEED_SCORED_MIN_QUALITY,
  maxInterpolatedGapFrames: AUTO_SEED_SCORED_MAX_INTERP_GAP_FRAMES,
};
const BASE_HINT = 'Capture live hand/pose/fencers tips while playing, then generate editable recorded keyframes.';

let samples: Record<TrackId, LiveTipSample[]> = { A: [], B: [] };
let scoredSamples: Record<TrackId, LiveTipScoredSample[]> = { A: [], B: [] };
let lastTimestampByTrack: Record<TrackId, number | null> = { A: null, B: null };
let captureMode: LiveMode | null = null;
let lastMediaTime: number | null = null;

export function detectionQuality(detection: FrameData['detections'][number]): number {
  return Math.max(0, Math.min(1, detection.tip.confidence));
}

/** Fps basis for drafts: the video's reported fps. */
export function draftFps(): number {
  return session.transportFps;
}

function sampleCount(): number {
  return samples.A.length + samples.B.length;
}

function scoredSampleCount(): number {
  return scoredSamples.A.length + scoredSamples.B.length;
}

export function getSamples(): Readonly<Record<TrackId, readonly LiveTipSample[]>> {
  return samples;
}

export function getScoredSamples(): Readonly<Record<TrackId, readonly LiveTipScoredSample[]>> {
  return scoredSamples;
}

export function resetCapture(): void {
  samples = { A: [], B: [] };
  scoredSamples = { A: [], B: [] };
  lastTimestampByTrack = { A: null, B: null };
  captureMode = null;
  lastMediaTime = null;
  events.emit('auto-seed');
}

function pushSample(id: TrackId, time: number, detection: FrameData['detections'][number]): void {
  samples[id].push({ time, x: detection.tip.x, y: detection.tip.y });
  scoredSamples[id].push({ time, x: detection.tip.x, y: detection.tip.y, quality: detectionQuality(detection) });
}

/** After-render hook: record new live tips while the video plays. */
export function captureSamples(frame: FrameData): void {
  if (!isVideoSource()) return;
  if (frame.trackingMode === 'recorded') return;
  if (!session.activeSource.isPlaying()) return;
  if (frame.detections.length === 0) return;

  const liveMode = frame.trackingMode;
  if (captureMode && captureMode !== liveMode) {
    resetCapture();
  }
  captureMode = liveMode;

  const mediaTime = video.currentTime;
  if (!Number.isFinite(mediaTime) || mediaTime < 0) return;

  if (lastMediaTime !== null && mediaTime < lastMediaTime - 0.25) {
    resetCapture();
    captureMode = liveMode;
  }

  let capturedAny = false;
  for (const det of frame.detections) {
    const id: TrackId = det.id === 'B' ? 'B' : 'A';
    const ts = Number.isFinite(det.tip.timestamp) ? det.tip.timestamp : Number.NaN;
    if (!Number.isFinite(ts)) continue;
    const last = lastTimestampByTrack[id];
    if (last !== null && ts <= last + 1e-6) continue;
    lastTimestampByTrack[id] = ts;
    pushSample(id, mediaTime, det);
    capturedAny = true;
  }

  if (capturedAny) {
    lastMediaTime = mediaTime;
    events.emit('auto-seed');
  }
}

/** UI state for the "Generate Recorded Draft" button and hint. */
export function draftUiState(): { visible: boolean; enabled: boolean; hint: string } {
  const liveTrackingMode = isVideoSource() && appState.get().trackingMode !== 'recorded';
  const count = sampleCount();
  if (!liveTrackingMode) return { visible: false, enabled: false, hint: BASE_HINT };

  const enabled = !!session.currentVideoId && count > 0;
  if (count === 0) {
    return { visible: true, enabled, hint: 'Play video in Hand, Pose, or Fencers mode to capture draft samples.' };
  }

  const a = samples.A.length;
  const b = samples.B.length;
  if (appState.get().trackingMode === 'fencers') {
    const threshold = AUTO_SEED_SCORED_MIN_QUALITY;
    const qualifiedA = scoredSamples.A.filter((s) => s.quality >= threshold).length;
    const qualifiedB = scoredSamples.B.filter((s) => s.quality >= threshold).length;
    return {
      visible: true,
      enabled,
      hint:
        `Captured ${count} raw sample${count === 1 ? '' : 's'} (A ${a}, B ${b}); ` +
        `${scoredSampleCount()} scored (A ${scoredSamples.A.length}, B ${scoredSamples.B.length}), ` +
        `${qualifiedA + qualifiedB} above q>=${threshold.toFixed(2)} ` +
        `(A ${qualifiedA}, B ${qualifiedB}). Generate filtered draft when ready.`,
    };
  }

  return {
    visible: true,
    enabled,
    hint:
      `Captured ${count} live sample${count === 1 ? '' : 's'} (A ${a}, B ${b}). ` +
      'Generate a recorded draft when ready.',
  };
}

/** Convert captured samples into a recorded draft and switch to recorded mode. */
export function generateDraft(): void {
  if (!isVideoSource()) return;
  if (appState.get().trackingMode === 'recorded') {
    setStatus('Switch to Hand, Pose, or Fencers mode to capture a new draft.');
    return;
  }
  if (!session.currentVideoId || !session.currentVideoUrl) {
    setStatus('Load a video first.');
    return;
  }

  if (sampleCount() === 0) {
    const mediaTime = video.currentTime;
    const currentDetections = mainLoop.getDetections();
    if (Number.isFinite(mediaTime) && mediaTime >= 0 && currentDetections.length > 0) {
      for (const det of currentDetections) {
        pushSample(det.id === 'B' ? 'B' : 'A', mediaTime, det);
      }
    }
  }

  if (sampleCount() === 0) {
    setStatus('No live samples captured yet. Play in Hand, Pose, or Fencers mode first.');
    return;
  }

  const liveMode = appState.get().trackingMode as LiveMode;
  const fps = draftFps();
  const rawA = keyframesFromLiveSamples(samples.A, fps);
  const rawB = keyframesFromLiveSamples(samples.B, fps);
  const scoredA = keyframesFromScoredSamples(scoredSamples.A, fps, AUTO_SEED_SCORED_OPTIONS);
  const scoredB = keyframesFromScoredSamples(scoredSamples.B, fps, AUTO_SEED_SCORED_OPTIONS);
  const useFilteredDraft = liveMode === 'fencers' && scoredSampleCount() > 0;
  const aKeyframes = useFilteredDraft ? scoredA : rawA;
  const bKeyframes = useFilteredDraft ? scoredB : rawB;
  const draftLabel = useFilteredDraft ? 'filtered' : 'raw';

  if (aKeyframes.length === 0 && bKeyframes.length === 0) {
    setStatus('Captured samples were not usable as keyframes.');
    return;
  }

  const ranges = captureRanges(
    [...samples.A, ...samples.B].map((s) => s.time),
    CAPTURE_RANGE_SPLIT_SECONDS
  );
  const replacing = keyframesInRanges(ranges, fps);
  if (replacing > 0) {
    const rangeText = ranges.map((r) => `${formatClock(r.start)}–${formatClock(r.end)}`).join(', ');
    const replace = window.confirm(
      `Replace ${replacing} existing keyframe${replacing === 1 ? '' : 's'} in ${rangeText} ` +
        `with the generated draft (A ${aKeyframes.length}, B ${bKeyframes.length})?\n\n` +
        `Keyframes outside ${ranges.length === 1 ? 'this range' : 'these ranges'} are kept.`
    );
    if (!replace) return;
  }

  applyDraft(aKeyframes, bKeyframes, {
    fps,
    ranges,
    maxGapSeconds: useFilteredDraft ? AUTO_SEED_FILTERED_MAX_GAP_SECONDS : undefined,
    note:
      `Auto-seeded ${draftLabel} draft: A ${aKeyframes.length}, B ${bKeyframes.length}. ` +
      `(raw A ${rawA.length}, B ${rawB.length})`,
  });
  clearTrails();
  appState.update({ trackingMode: 'recorded' });

  const minTime = Math.min(
    ...(aKeyframes[0] ? [aKeyframes[0].time] : []),
    ...(bKeyframes[0] ? [bKeyframes[0].time] : [])
  );
  const maxTime = Math.max(
    ...(aKeyframes.length > 0 ? [aKeyframes[aKeyframes.length - 1].time] : []),
    ...(bKeyframes.length > 0 ? [bKeyframes[bKeyframes.length - 1].time] : [])
  );
  const sampledDuration = Number.isFinite(minTime) && Number.isFinite(maxTime) ? Math.max(0, maxTime - minTime) : 0;
  setStatus(
    `Generated ${draftLabel} draft: A ${aKeyframes.length}, B ${bKeyframes.length} keyframes` +
      ` (${sampledDuration.toFixed(1)}s @ ${fps.toFixed(2)}fps` +
      `${useFilteredDraft ? `, base q>=${AUTO_SEED_SCORED_MIN_QUALITY.toFixed(2)}` : ''})`
  );

  resetCapture();
}
