// Scoring touches ("hits") on a recorded track set: one per fencer per frame, set by hand.

import { frameIndex } from '../app/frame-rate';
import { timeForFrame } from './keyframes';
import type { Hit, RecordedTrackId } from './types';

export interface HitWithFrame extends Hit {
  frame: number;
}

function sortHits(hits: Hit[]): Hit[] {
  return hits.sort((a, b) => a.time - b.time || a.trackId.localeCompare(b.trackId));
}

export function hitAtFrame(hits: readonly Hit[], trackId: RecordedTrackId, frame: number, fps: number): Hit | null {
  return hits.find((h) => h.trackId === trackId && frameIndex(h.time, fps) === frame) ?? null;
}

/** Add a hit for `trackId` at `frame`, or remove it if one is already there. */
export function toggleHitAtFrame(
  hits: readonly Hit[],
  trackId: RecordedTrackId,
  frame: number,
  fps: number
): { hits: Hit[]; added: boolean } {
  const target = Math.max(0, frame);
  const existing = hitAtFrame(hits, trackId, target, fps);
  if (existing) {
    return { hits: hits.filter((h) => h !== existing), added: false };
  }
  return { hits: sortHits([...hits, { time: timeForFrame(target, fps), trackId }]), added: true };
}

export function removeHit(hits: readonly Hit[], hit: Hit): Hit[] {
  return hits.filter((h) => !(h.trackId === hit.trackId && h.time === hit.time));
}

export function listHitsWithFrames(hits: readonly Hit[], fps: number): HitWithFrame[] {
  return hits.map((h) => ({ ...h, frame: frameIndex(h.time, fps) }));
}

/** Hits whose effect is visible at media time `t` (started at most `durationSeconds` ago). */
export function activeHits(hits: readonly Hit[], t: number, durationSeconds: number): Hit[] {
  return hits.filter((h) => t >= h.time && t - h.time < durationSeconds);
}
