import { describe, expect, it } from 'vitest';
import {
  HIT_FLASH_SECONDS,
  flashAlpha,
  flashColor,
  makeStreaks,
  mulberry32,
  project,
  seedForHit,
  streakPosition,
} from './hit-effects';

describe('hit burst model', () => {
  it('is deterministic per hit and differs between hits', () => {
    const hit = { time: 12.3, trackId: 'A' as const };
    expect(makeStreaks(seedForHit(hit))).toEqual(makeStreaks(seedForHit(hit)));
    expect(makeStreaks(seedForHit(hit))).not.toEqual(makeStreaks(seedForHit({ ...hit, trackId: 'B' })));
  });

  it('fires every streak into the hemisphere facing the camera, with unit directions', () => {
    for (const s of makeStreaks(42)) {
      expect(s.dir.z).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(s.dir.x, s.dir.y, s.dir.z)).toBeCloseTo(1, 6);
    }
  });

  it('starts at the origin, moves outward and decelerates', () => {
    const s = { dir: { x: 1, y: 0, z: 0 }, speed: 1, width: 1, life: 1 };
    expect(streakPosition(s, 0)).toEqual({ x: 0, y: 0, z: 0 });
    const d1 = streakPosition(s, 0.1).x;
    const d2 = streakPosition(s, 0.2).x - d1;
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBeLessThan(d1);
    expect(streakPosition(s, 0.5).y).toBeGreaterThan(0); // gravity pulls down
  });

  it('projects points nearer the camera larger and further out', () => {
    const flat = project({ x: 0.1, y: 0, z: 0 });
    const near = project({ x: 0.1, y: 0, z: 0.5 });
    expect(flat.scale).toBeCloseTo(1);
    expect(near.scale).toBeGreaterThan(1);
    expect(near.x).toBeGreaterThan(flat.x);
  });

  it('flash starts at peak and fades to zero', () => {
    expect(flashAlpha(-0.01)).toBe(0);
    expect(flashAlpha(0)).toBeGreaterThan(0.5);
    expect(flashAlpha(HIT_FLASH_SECONDS / 2)).toBeLessThan(flashAlpha(0));
    expect(flashAlpha(HIT_FLASH_SECONDS)).toBe(0);
  });

  it('flash starts white and takes on the tint as it fades', () => {
    expect(flashColor([0, 255, 0], 0)).toEqual([255, 255, 255]);
    const mid = flashColor([0, 255, 0], HIT_FLASH_SECONDS * 0.15);
    expect(mid[0]).toBeLessThan(255);
    expect(mid[0]).toBeGreaterThan(0);
    expect(flashColor([0, 255, 0], HIT_FLASH_SECONDS * 0.5)).toEqual([0, 255, 0]);
  });

  it('prng yields values in [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
