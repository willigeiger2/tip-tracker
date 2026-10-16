// Hit effects for the loaded track set: resolves each active hit's origin (the scoring fencer's
// tip at the hit time) and color, then draws with the pure effect module. Shared by the on-screen
// overlay pass and the MP4 exporter, which pass their own canvas-coordinate mapper.

import { frameIndex } from '../app/frame-rate';
import { HIT_EFFECT_SECONDS, drawHitEffects, type HitEffectInput, type VideoRect } from '../recorded/hit-effects';
import { activeHits } from '../recorded/hits';
import { sampleTrackAt } from '../recorded/interpolator';
import type { Hit, RecordedTrackSet } from '../recorded/types';
import { appState } from './app';

type Mapper = (normX: number, normY: number) => { x: number; y: number };

/** Nearest keyframe within this window is used when the tip isn't tracked exactly at the hit. */
const ORIGIN_FALLBACK_SECONDS = 0.5;

/**
 * Burst origin: the scorer's tip where it is drawn on the hit frame. Playback and export show a
 * frame's tip at the frame center, so sample there (not at the frame start, which lags behind a
 * fast-moving tip by half a frame).
 */
export function hitOrigin(set: RecordedTrackSet, hit: Hit): { x: number; y: number } | null {
  const track = set.tracks.find((t) => t.id === hit.trackId);
  if (!track || track.keyframes.length === 0) return null;
  const frameCenter = (frameIndex(hit.time, set.fps) + 0.5) / set.fps;
  const sampled = sampleTrackAt(track, frameCenter, { fps: set.fps, maxGapSeconds: set.maxGapSeconds });
  if (sampled) return { x: sampled.x, y: sampled.y };
  let best: { x: number; y: number } | null = null;
  let bestDt = ORIGIN_FALLBACK_SECONDS;
  for (const kf of track.keyframes) {
    const dt = Math.abs(kf.time - hit.time);
    if (dt <= bestDt) {
      bestDt = dt;
      best = { x: kf.x, y: kf.y };
    }
  }
  return best;
}

export function hitColor(set: RecordedTrackSet, hit: Hit): string {
  return set.tracks.find((t) => t.id === hit.trackId)?.color ?? '#ffffff';
}

/** The video frame's rectangle in canvas pixels for a mapper. */
export function videoRect(map: Mapper): VideoRect {
  const a = map(0, 0);
  const b = map(1, 1);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

export function hitEffectInputs(set: RecordedTrackSet, mediaTime: number, map: Mapper): HitEffectInput[] {
  // Snap to the frame grid so the effect for a frame never depends on where in the frame the
  // playhead sits (export seeks to frame centers; playback reports arbitrary times).
  const t = frameIndex(mediaTime, set.fps) / set.fps;
  return activeHits(set.hits ?? [], t, HIT_EFFECT_SECONDS).map((hit) => {
    const origin = hitOrigin(set, hit);
    return {
      hit,
      age: t - hit.time,
      color: hitColor(set, hit),
      origin: origin ? map(origin.x, origin.y) : null,
    };
  });
}

export function drawRecordedHits(
  ctx: CanvasRenderingContext2D,
  set: RecordedTrackSet,
  mediaTime: number,
  map: Mapper
): void {
  const mode = appState.get().hitEffect;
  if (mode === 'off' || !set.hits?.length) return;
  drawHitEffects(ctx, hitEffectInputs(set, mediaTime, map), mode, videoRect(map));
}
