import { beforeEach, describe, expect, it } from 'vitest';
import { LANDMARKS } from './detector';
import { estimateTip, getPoseTipExtension, setPoseTipExtension } from './tip-estimator';
import type { Landmark, Pose } from '../types/fencing';

function makeLandmark(x: number, y: number, visibility = 1): Landmark {
  return { x, y, z: 0, visibility };
}

function makePose(): Pose {
  const landmarks = Array.from({ length: 33 }, () => makeLandmark(0, 0, 0));
  landmarks[LANDMARKS.RIGHT_ELBOW] = makeLandmark(0.5, 0.5, 1);
  landmarks[LANDMARKS.RIGHT_WRIST] = makeLandmark(0.56, 0.5, 1);
  landmarks[LANDMARKS.RIGHT_SHOULDER] = makeLandmark(0.44, 0.5, 1);
  return {
    landmarks,
    worldLandmarks: landmarks,
    score: 1,
  };
}

describe('pose tip extension multiplier', () => {
  beforeEach(() => {
    setPoseTipExtension(4.2);
  });

  it('uses 4.2 by default', () => {
    const tip = estimateTip(makePose(), 1000, 'right');
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeCloseTo(0.812, 6);
  });

  it('moves the estimated tip farther when increased', () => {
    setPoseTipExtension(5.0);
    const tip = estimateTip(makePose(), 1000, 'right');
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeCloseTo(0.86, 6);
  });

  it('clamps estimated tip to frame bounds', () => {
    setPoseTipExtension(8.0);
    const tip = estimateTip(makePose(), 1000, 'right');
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeLessThanOrEqual(1);
    expect(tip!.x).toBeGreaterThanOrEqual(0);
  });

  it('clamps the multiplier to a safe range', () => {
    setPoseTipExtension(99);
    expect(getPoseTipExtension()).toBe(8);

    setPoseTipExtension(-20);
    expect(getPoseTipExtension()).toBe(1);
  });
});
