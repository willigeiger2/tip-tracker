import { frameIndex } from '../app/frame-rate';
import type { Keyframe, RecordedTrack } from './types';

export interface KeyframeWithFrame extends Keyframe {
  frame: number;
}

export function frameForKeyframe(keyframe: Keyframe, fps: number): number {
  return frameIndex(keyframe.time, fps);
}

export function timeForFrame(frame: number, fps: number): number {
  return Math.max(0, frame) / Math.max(1, fps);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function upsertKeyframeAtFrame(
  track: RecordedTrack,
  frame: number,
  x: number,
  y: number,
  fps: number
): RecordedTrack {
  const targetFrame = Math.max(0, frame);
  const next: Keyframe[] = track.keyframes
    .filter((kf) => frameForKeyframe(kf, fps) !== targetFrame)
    .concat({
      time: timeForFrame(targetFrame, fps),
      x: clamp01(x),
      y: clamp01(y),
    })
    .sort((a, b) => a.time - b.time);

  return { ...track, keyframes: next };
}

export function deleteKeyframeAtFrame(track: RecordedTrack, frame: number, fps: number): RecordedTrack {
  const targetFrame = Math.max(0, frame);
  return {
    ...track,
    keyframes: track.keyframes.filter((kf) => frameForKeyframe(kf, fps) !== targetFrame),
  };
}

export function keyframeAtFrame(track: RecordedTrack, frame: number, fps: number): Keyframe | null {
  const targetFrame = Math.max(0, frame);
  return track.keyframes.find((kf) => frameForKeyframe(kf, fps) === targetFrame) ?? null;
}

export function nearestNeighborFrames(
  track: RecordedTrack,
  frame: number,
  fps: number
): { previous: KeyframeWithFrame | null; current: KeyframeWithFrame | null; next: KeyframeWithFrame | null } {
  const target = Math.max(0, frame);
  let previous: KeyframeWithFrame | null = null;
  let current: KeyframeWithFrame | null = null;
  let next: KeyframeWithFrame | null = null;

  for (const kf of track.keyframes) {
    const kfFrame = frameForKeyframe(kf, fps);
    const item: KeyframeWithFrame = { ...kf, frame: kfFrame };

    if (kfFrame < target) {
      previous = item;
      continue;
    }
    if (kfFrame === target) {
      current = item;
      continue;
    }
    next = item;
    break;
  }

  return { previous, current, next };
}

export function listKeyframesWithFrames(track: RecordedTrack, fps: number): KeyframeWithFrame[] {
  return track.keyframes.map((kf) => ({ ...kf, frame: frameForKeyframe(kf, fps) }));
}
