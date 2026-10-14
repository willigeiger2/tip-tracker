import { describe, expect, it } from 'vitest';
import { keyframesFromLiveSamples, keyframesFromScoredSamples } from './auto-seed';

describe('keyframesFromLiveSamples', () => {
  it('sorts by time and clamps normalized coordinates', () => {
    const out = keyframesFromLiveSamples(
      [
        { time: 0.2, x: 1.2, y: -0.1 },
        { time: 0.0, x: 0.1, y: 0.2 },
      ],
      30
    );

    expect(out).toEqual([
      { time: 0.0, x: 0.1, y: 0.2 },
      { time: 0.2, x: 1, y: 0 },
    ]);
  });

  it('keeps only the latest sample within the same frame index', () => {
    const out = keyframesFromLiveSamples(
      [
        { time: 0.101, x: 0.2, y: 0.2 },
        { time: 0.104, x: 0.7, y: 0.8 },
      ],
      30
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ time: 0.104, x: 0.7, y: 0.8 });
  });

  it('drops invalid rows and handles non-positive fps', () => {
    expect(
      keyframesFromLiveSamples(
        [
          { time: Number.NaN, x: 0.1, y: 0.2 },
          { time: 0.1, x: Number.POSITIVE_INFINITY, y: 0.2 },
          { time: 0.2, x: 0.2, y: Number.NaN },
        ],
        30
      )
    ).toEqual([]);

    expect(keyframesFromLiveSamples([{ time: 0.1, x: 0.2, y: 0.2 }], 0)).toEqual([]);
  });

  it('clamps negative time to zero', () => {
    const out = keyframesFromLiveSamples([{ time: -0.3, x: 0.5, y: 0.5 }], 30);
    expect(out).toEqual([{ time: 0, x: 0.5, y: 0.5 }]);
  });
});

describe('keyframesFromScoredSamples', () => {
  it('keeps only samples above threshold and interpolates short gaps', () => {
    const out = keyframesFromScoredSamples(
      [
        { time: 0 / 30, x: 0.1, y: 0.2, quality: 0.95 },
        { time: 1 / 30, x: 0.2, y: 0.3, quality: 0.4 },
        { time: 2 / 30, x: 0.3, y: 0.4, quality: 0.92 },
      ],
      30,
      { minQuality: 0.8, maxInterpolatedGapFrames: 2 }
    );

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ time: 0 / 30, x: 0.1, y: 0.2 });
    expect(out[1].time).toBeCloseTo(1 / 30, 9);
    expect(out[1].x).toBeCloseTo(0.2, 9);
    expect(out[1].y).toBeCloseTo(0.3, 9);
    expect(out[2]).toEqual({ time: 2 / 30, x: 0.3, y: 0.4 });
  });

  it('does not interpolate long gaps', () => {
    const out = keyframesFromScoredSamples(
      [
        { time: 0 / 30, x: 0.1, y: 0.2, quality: 0.95 },
        { time: 4 / 30, x: 0.5, y: 0.6, quality: 0.95 },
      ],
      30,
      { minQuality: 0.8, maxInterpolatedGapFrames: 2 }
    );

    expect(out).toEqual([
      { time: 0 / 30, x: 0.1, y: 0.2 },
      { time: 4 / 30, x: 0.5, y: 0.6 },
    ]);
  });

  it('falls back to raw conversion when no scored samples pass threshold', () => {
    const out = keyframesFromScoredSamples(
      [
        { time: 0.0, x: 0.1, y: 0.2, quality: 0.3 },
        { time: 0.04, x: 0.2, y: 0.4, quality: 0.2 },
      ],
      30,
      { minQuality: 0.9 }
    );

    expect(out).toEqual([
      { time: 0.0, x: 0.1, y: 0.2 },
      { time: 0.04, x: 0.2, y: 0.4 },
    ]);
  });

  it('keeps fast-motion samples that are below base threshold', () => {
    const out = keyframesFromScoredSamples(
      [
        { time: 0 / 30, x: 0.1, y: 0.2, quality: 0.95 },
        { time: 1 / 30, x: 0.72, y: 0.64, quality: 0.75 },
        { time: 2 / 30, x: 0.84, y: 0.72, quality: 0.94 },
      ],
      30,
      {
        minQuality: 0.82,
        fastMotionMinQuality: 0.72,
        fastMotionSpeedThreshold: 4,
        fastMotionSpeedFull: 10,
        maxInterpolatedGapFrames: 0,
      }
    );

    expect(out).toHaveLength(3);
    expect(out[1].time).toBeCloseTo(1 / 30, 9);
    expect(out[1].x).toBeCloseTo(0.72, 9);
    expect(out[1].y).toBeCloseTo(0.64, 9);
  });

  it('still filters low-quality samples during slow motion', () => {
    const out = keyframesFromScoredSamples(
      [
        { time: 0 / 30, x: 0.5, y: 0.5, quality: 0.95 },
        { time: 1 / 30, x: 0.505, y: 0.502, quality: 0.75 },
        { time: 2 / 30, x: 0.51, y: 0.504, quality: 0.94 },
      ],
      30,
      {
        minQuality: 0.82,
        fastMotionMinQuality: 0.72,
        fastMotionSpeedThreshold: 4,
        fastMotionSpeedFull: 10,
        maxInterpolatedGapFrames: 0,
      }
    );

    expect(out).toEqual([
      { time: 0 / 30, x: 0.5, y: 0.5 },
      { time: 2 / 30, x: 0.51, y: 0.504 },
    ]);
  });
});
