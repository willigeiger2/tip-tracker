import { beforeEach, describe, expect, it } from 'vitest';
import { LANDMARKS } from './detector';
import {
  estimateTip,
  estimateTipForArm,
  getFencerDirectionTuning,
  getPoseTipExtension,
  setFencerDirectionTuning,
  setPoseTipExtension,
} from './tip-estimator';
import type { Landmark, Pose } from '../types/fencing';

function makeLandmark(x: number, y: number, visibility = 1): Landmark {
  return { x, y, z: 0, visibility };
}

function makePose(): Pose {
  const landmarks = Array.from({ length: 33 }, () => makeLandmark(0, 0, 0));
  landmarks[LANDMARKS.LEFT_ELBOW] = makeLandmark(0.5, 0.5, 1);
  landmarks[LANDMARKS.LEFT_WRIST] = makeLandmark(0.44, 0.5, 1);
  landmarks[LANDMARKS.LEFT_SHOULDER] = makeLandmark(0.56, 0.5, 1);
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
    setPoseTipExtension(3.6);
    setFencerDirectionTuning('A', { wristWeight: 0.35, angleOffsetDeg: 0, extensionMultiplier: 3.6 });
    setFencerDirectionTuning('B', { wristWeight: 0.35, angleOffsetDeg: 0, extensionMultiplier: 3.6 });
  });

  it('uses 3.6 by default', () => {
    const tip = estimateTip(makePose(), 1000, 'right');
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeCloseTo(0.776, 6);
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

  it('can estimate from the left arm when requested', () => {
    const tip = estimateTipForArm(makePose(), 1000, 'left', 'left');
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeCloseTo(0.224, 6);
  });

  it('blends forearm with wrist orientation when hand hints are available', () => {
    const pose = makePose();
    pose.landmarks[LANDMARKS.RIGHT_INDEX] = makeLandmark(0.56, 0.44, 1);

    const tip = estimateTipForArm(pose, 1000, 'right', 'right');
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeCloseTo(0.7502, 4);
    expect(tip!.y).toBeCloseTo(0.398, 3);
  });

  it('supports per-fencer blend tuning', () => {
    const pose = makePose();
    pose.landmarks[LANDMARKS.RIGHT_INDEX] = makeLandmark(0.56, 0.44, 1);

    setFencerDirectionTuning('A', { wristWeight: 0 });
    setFencerDirectionTuning('B', { wristWeight: 1 });

    const tipA = estimateTipForArm(pose, 1000, 'right', 'right', 'A');
    const tipB = estimateTipForArm(pose, 1000, 'right', 'right', 'B');
    expect(tipA).not.toBeNull();
    expect(tipB).not.toBeNull();

    expect(tipA!.y).toBeCloseTo(0.5, 5);
    expect(tipB!.y).toBeLessThan(0.45);
  });

  it('supports per-fencer angle fudge offsets', () => {
    const pose = makePose();
    setFencerDirectionTuning('A', { wristWeight: 0, angleOffsetDeg: -12 });
    setFencerDirectionTuning('B', { wristWeight: 0, angleOffsetDeg: 12 });

    const tipA = estimateTipForArm(pose, 1000, 'right', 'right', 'A');
    const tipB = estimateTipForArm(pose, 1000, 'right', 'right', 'B');
    expect(tipA).not.toBeNull();
    expect(tipB).not.toBeNull();

    expect(tipA!.y).toBeLessThan(0.5);
    expect(tipB!.y).toBeGreaterThan(0.5);
  });

  it('supports per-fencer extension multipliers', () => {
    const pose = makePose();
    setFencerDirectionTuning('A', { wristWeight: 0, angleOffsetDeg: 0, extensionMultiplier: 2.0 });
    setFencerDirectionTuning('B', { wristWeight: 0, angleOffsetDeg: 0, extensionMultiplier: 5.0 });

    const tipA = estimateTipForArm(pose, 1000, 'right', 'right', 'A');
    const tipB = estimateTipForArm(pose, 1000, 'right', 'right', 'B');
    expect(tipA).not.toBeNull();
    expect(tipB).not.toBeNull();

    expect(tipA!.x).toBeLessThan(tipB!.x);
  });

  it('clamps fencer tuning values to safe ranges', () => {
    setFencerDirectionTuning('A', { wristWeight: 9, angleOffsetDeg: 90, extensionMultiplier: 99 });
    setFencerDirectionTuning('B', { wristWeight: -5, angleOffsetDeg: -120, extensionMultiplier: -8 });

    const a = getFencerDirectionTuning('A');
    const b = getFencerDirectionTuning('B');

    expect(a.wristWeight).toBe(1);
    expect(a.angleOffsetDeg).toBe(30);
    expect(a.extensionMultiplier).toBe(8);
    expect(b.wristWeight).toBe(0);
    expect(b.angleOffsetDeg).toBe(-30);
    expect(b.extensionMultiplier).toBe(1);
  });

  it('returns null when the selected arm landmarks are low confidence', () => {
    const pose = makePose();
    pose.landmarks[LANDMARKS.LEFT_WRIST] = makeLandmark(0.44, 0.5, 0.1);
    pose.landmarks[LANDMARKS.LEFT_ELBOW] = makeLandmark(0.5, 0.5, 0.1);

    const leftTip = estimateTipForArm(pose, 1000, 'left', 'left');
    const rightTip = estimateTipForArm(pose, 1000, 'left', 'right');
    expect(leftTip).toBeNull();
    expect(rightTip).not.toBeNull();
  });
});
