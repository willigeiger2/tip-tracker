import { describe, expect, it } from 'vitest';
import { keyframesFromLiveSamples } from './auto-seed';

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
