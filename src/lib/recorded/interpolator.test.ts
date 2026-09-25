import { describe, expect, it } from 'vitest';
import { sampleTrackAt, sampleTrackTrail } from './interpolator';
import type { RecordedTrack } from './types';

const OPTIONS = { maxGapSeconds: 1.0, fps: 30 };

function track(keyframes: Array<{ time: number; x: number; y: number }>): RecordedTrack {
  return { id: 'A', label: 'Track A', color: '#00ff00', keyframes };
}

describe('sampleTrackAt', () => {
  it('returns null outside all keyframe runs', () => {
    const t = track([
      { time: 1, x: 0.1, y: 0.1 },
      { time: 2, x: 0.2, y: 0.2 },
    ]);
    expect(sampleTrackAt(t, 0.5, OPTIONS)).toBeNull();
    expect(sampleTrackAt(t, 2.5, OPTIONS)).toBeNull();
  });

  it('passes exactly through each keyframe', () => {
    const t = track([
      { time: 0, x: 0.2, y: 0.3 },
      { time: 1, x: 0.5, y: 0.6 },
      { time: 2, x: 0.8, y: 0.4 },
    ]);

    for (const kf of t.keyframes) {
      const p = sampleTrackAt(t, kf.time, OPTIONS);
      expect(p).not.toBeNull();
      expect(p!.x).toBeCloseTo(kf.x, 9);
      expect(p!.y).toBeCloseTo(kf.y, 9);
    }
  });

  it('respects maxGapSeconds (no interpolation across large gaps)', () => {
    const t = track([
      { time: 0, x: 0.1, y: 0.1 },
      { time: 0.5, x: 0.2, y: 0.2 },
      { time: 2.0, x: 0.7, y: 0.7 },
    ]);

    expect(sampleTrackAt(t, 1.0, OPTIONS)).toBeNull();
  });

  it('single-keyframe runs render only at that frame (+/- half frame)', () => {
    const t = track([{ time: 1, x: 0.4, y: 0.6 }]);
    const within = sampleTrackAt(t, 1 + 0.5 / 30 - 1e-4, OPTIONS);
    expect(within).not.toBeNull();
    const outside = sampleTrackAt(t, 1 + 0.5 / 30 + 1e-3, OPTIONS);
    expect(outside).toBeNull();
  });

  it('is C1-like continuous at interior joints (numerical derivative)', () => {
    const t = track([
      { time: 0, x: 0, y: 0 },
      { time: 1, x: 1, y: 1 },
      { time: 2, x: 2, y: 1 },
      { time: 3, x: 3, y: 0 },
    ]);

    const eps = 1e-3;
    const leftA = sampleTrackAt(t, 1 - eps, OPTIONS)!;
    const leftB = sampleTrackAt(t, 1, OPTIONS)!;
    const rightA = sampleTrackAt(t, 1, OPTIONS)!;
    const rightB = sampleTrackAt(t, 1 + eps, OPTIONS)!;

    const dxLeft = (leftB.x - leftA.x) / eps;
    const dxRight = (rightB.x - rightA.x) / eps;
    const dyLeft = (leftB.y - leftA.y) / eps;
    const dyRight = (rightB.y - rightA.y) / eps;

    expect(dxLeft).toBeCloseTo(dxRight, 1);
    expect(dyLeft).toBeCloseTo(dyRight, 1);
  });
});

describe('sampleTrackTrail', () => {
  it('samples oldest -> newest points in the current run only', () => {
    const t = track([
      { time: 0, x: 0, y: 0 },
      { time: 1, x: 1, y: 1 },
      { time: 2.5, x: 0.2, y: 0.8 },
      { time: 3, x: 0.3, y: 0.9 },
    ]);

    const points = sampleTrackTrail(t, 2.75, 1.0, 8, OPTIONS);
    expect(points.length).toBeGreaterThan(0);
    expect(points[0].time).toBeGreaterThanOrEqual(2.5);
    expect(points[points.length - 1].time).toBeCloseTo(2.75, 8);
  });
});
