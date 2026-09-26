import { frameIndex } from '../app/frame-rate';
import type { Keyframe } from './types';

export interface LiveTipSample {
  time: number;
  x: number;
  y: number;
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
