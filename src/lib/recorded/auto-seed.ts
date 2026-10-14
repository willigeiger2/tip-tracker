import { frameIndex } from '../app/frame-rate';
import type { Keyframe } from './types';

export interface LiveTipSample {
  time: number;
  x: number;
  y: number;
}

export interface LiveTipScoredSample extends LiveTipSample {
  quality: number;
}

export interface ScoredKeyframeOptions {
  minQuality?: number;
  maxInterpolatedGapFrames?: number;
  fastMotionMinQuality?: number;
  fastMotionSpeedThreshold?: number;
  fastMotionSpeedFull?: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Convert captured live tip samples to a normalized, frame-deduped keyframe list.
 * Rules:
 * - discard non-finite inputs
 * - clamp x/y to [0, 1], time to >= 0
 * - sort by time ascending
 * - keep at most one sample per frame index (latest sample in that frame wins)
 */
export function keyframesFromLiveSamples(samples: LiveTipSample[], fps: number): Keyframe[] {
  if (!Number.isFinite(fps) || fps <= 0 || samples.length === 0) return [];

  const normalized = samples
    .map((sample, index) => ({ sample, index }))
    .filter(
      ({ sample }) =>
        Number.isFinite(sample.time) && Number.isFinite(sample.x) && Number.isFinite(sample.y)
    )
    .map(({ sample, index }) => ({
      time: Math.max(0, sample.time),
      x: clamp01(sample.x),
      y: clamp01(sample.y),
      index,
    }))
    .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time));

  const byFrame = new Map<number, Keyframe>();
  for (const item of normalized) {
    const frame = frameIndex(item.time, fps);
    byFrame.set(frame, { time: item.time, x: item.x, y: item.y });
  }

  return [...byFrame.values()].sort((a, b) => a.time - b.time);
}

/**
 * Build keyframes from scored samples.
 * - keeps only samples at/above minQuality
 * - fills only short gaps by interpolation
 * - falls back to raw conversion when no scored samples pass the threshold
 */
export function keyframesFromScoredSamples(
  samples: LiveTipScoredSample[],
  fps: number,
  options: ScoredKeyframeOptions = {}
): Keyframe[] {
  if (!Number.isFinite(fps) || fps <= 0 || samples.length === 0) return [];

  const minQuality = Number.isFinite(options.minQuality) ? clamp01(options.minQuality ?? 0) : 0.75;
  const maxInterpolatedGapFrames = Number.isFinite(options.maxInterpolatedGapFrames)
    ? Math.max(0, Math.floor(options.maxInterpolatedGapFrames ?? 0))
    : 3;
  const fastMotionMinQuality = Number.isFinite(options.fastMotionMinQuality)
    ? Math.min(minQuality, clamp01(options.fastMotionMinQuality ?? minQuality))
    : minQuality;
  const fastMotionSpeedThreshold = Number.isFinite(options.fastMotionSpeedThreshold)
    ? Math.max(0, options.fastMotionSpeedThreshold ?? 0)
    : Number.POSITIVE_INFINITY;
  const fastMotionSpeedFull = Number.isFinite(options.fastMotionSpeedFull)
    ? Math.max(fastMotionSpeedThreshold, options.fastMotionSpeedFull ?? fastMotionSpeedThreshold)
    : fastMotionSpeedThreshold;

  const normalized = samples
    .map((sample, index) => ({ sample, index }))
    .filter(
      ({ sample }) =>
        Number.isFinite(sample.time) &&
        Number.isFinite(sample.x) &&
        Number.isFinite(sample.y) &&
        Number.isFinite(sample.quality)
    )
    .map(({ sample, index }) => ({
      time: Math.max(0, sample.time),
      x: clamp01(sample.x),
      y: clamp01(sample.y),
      quality: clamp01(sample.quality),
      index,
    }))
    .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time));

  const byFrame = new Map<number, { frame: number; time: number; x: number; y: number; quality: number }>();
  for (const item of normalized) {
    const frame = frameIndex(item.time, fps);
    byFrame.set(frame, { frame, time: item.time, x: item.x, y: item.y, quality: item.quality });
  }

  const scoredFrames = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const motionSpeedByIndex = scoredFrames.map((_sample, index) => {
    const current = scoredFrames[index];
    let maxSpeed = 0;

    if (index > 0) {
      const previous = scoredFrames[index - 1];
      const dt = current.time - previous.time;
      if (dt > 1e-6) {
        const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
        maxSpeed = Math.max(maxSpeed, distance / dt);
      }
    }

    if (index < scoredFrames.length - 1) {
      const next = scoredFrames[index + 1];
      const dt = next.time - current.time;
      if (dt > 1e-6) {
        const distance = Math.hypot(next.x - current.x, next.y - current.y);
        maxSpeed = Math.max(maxSpeed, distance / dt);
      }
    }

    return maxSpeed;
  });

  const accepted = scoredFrames.filter((sample, index) => {
    let requiredQuality = minQuality;
    if (
      Number.isFinite(fastMotionSpeedThreshold) &&
      fastMotionMinQuality < minQuality &&
      motionSpeedByIndex[index] > fastMotionSpeedThreshold
    ) {
      if (fastMotionSpeedFull <= fastMotionSpeedThreshold) {
        requiredQuality = fastMotionMinQuality;
      } else {
        const blend = clamp01(
          (motionSpeedByIndex[index] - fastMotionSpeedThreshold) /
            (fastMotionSpeedFull - fastMotionSpeedThreshold)
        );
        requiredQuality = minQuality - (minQuality - fastMotionMinQuality) * blend;
      }
    }
    return sample.quality >= requiredQuality;
  });
  if (accepted.length === 0) {
    return keyframesFromLiveSamples(samples, fps);
  }

  const keyframes: Keyframe[] = [];
  for (let i = 0; i < accepted.length; i++) {
    const current = accepted[i];
    if (i === 0) {
      keyframes.push({ time: current.time, x: current.x, y: current.y });
      continue;
    }

    const previous = accepted[i - 1];
    const frameGap = current.frame - previous.frame;
    const missingFrames = frameGap - 1;

    if (missingFrames > 0 && missingFrames <= maxInterpolatedGapFrames) {
      for (let step = 1; step <= missingFrames; step++) {
        const t = step / frameGap;
        keyframes.push({
          time: previous.time + (current.time - previous.time) * t,
          x: previous.x + (current.x - previous.x) * t,
          y: previous.y + (current.y - previous.y) * t,
        });
      }
    }

    keyframes.push({ time: current.time, x: current.x, y: current.y });
  }

  return keyframes.sort((a, b) => a.time - b.time);
}

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Group capture times into contiguous ranges, splitting wherever consecutive times are more
 * than `maxGapSeconds` apart (e.g. the user skipped forward between plays).
 */
export function captureRanges(times: readonly number[], maxGapSeconds: number): TimeRange[] {
  const sorted = times.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const ranges: TimeRange[] = [];
  for (const t of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && t - last.end <= maxGapSeconds) {
      last.end = t;
    } else {
      ranges.push({ start: t, end: t });
    }
  }
  return ranges;
}

/** True when `time` lies inside any range widened by `padSeconds` on both sides. */
export function inRanges(time: number, ranges: readonly TimeRange[], padSeconds = 0): boolean {
  return ranges.some((r) => time >= r.start - padSeconds && time <= r.end + padSeconds);
}

/**
 * Merge a draft into an existing track: existing keyframes inside the captured ranges are
 * replaced by the draft; existing keyframes outside them are kept untouched.
 */
export function mergeDraftKeyframes(
  existing: readonly Keyframe[],
  draft: readonly Keyframe[],
  ranges: readonly TimeRange[],
  padSeconds = 0
): { keyframes: Keyframe[]; replaced: number } {
  const kept = existing.filter((kf) => !inRanges(kf.time, ranges, padSeconds));
  return {
    keyframes: [...kept, ...draft].sort((a, b) => a.time - b.time),
    replaced: existing.length - kept.length,
  };
}
