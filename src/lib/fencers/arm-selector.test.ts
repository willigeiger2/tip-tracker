import { describe, expect, it } from 'vitest';
import { armJoints, forwardSignFor, selectWeaponArm } from './arm-selector';
import type { Landmark } from '../../types/fencing';

const L = { shoulder: 11, elbow: 13, wrist: 15 };
const R = { shoulder: 12, elbow: 14, wrist: 16 };

function lm(x: number, y: number, visibility = 0.9): Landmark {
  return { x, y, z: 0, visibility };
}

/** Pose with both arms; positions given as [x, y]. Unspecified landmarks are invisible. */
function pose(arms: {
  leftWrist?: [number, number];
  leftElbow?: [number, number];
  rightWrist?: [number, number];
  rightElbow?: [number, number];
  visibility?: { leftWrist?: number; rightWrist?: number };
}): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => lm(0, 0, 0));
  out[L.shoulder] = lm(0.3, 0.4);
  out[R.shoulder] = lm(0.32, 0.4);
  if (arms.leftElbow) out[L.elbow] = lm(...arms.leftElbow);
  if (arms.rightElbow) out[R.elbow] = lm(...arms.rightElbow);
  if (arms.leftWrist) out[L.wrist] = lm(...arms.leftWrist, arms.visibility?.leftWrist ?? 0.9);
  if (arms.rightWrist) out[R.wrist] = lm(...arms.rightWrist, arms.visibility?.rightWrist ?? 0.9);
  return out;
}

// Fencer on the left of frame (body at x=0.3), facing right (+x).
const BODY_X = 0.3;

describe('forwardSignFor', () => {
  it('faces the opponent when known', () => {
    expect(forwardSignFor(0.3, 0.7)).toBe(1);
    expect(forwardSignFor(0.7, 0.3)).toBe(-1);
  });

  it('falls back to facing frame center', () => {
    expect(forwardSignFor(0.3, null)).toBe(1);
    expect(forwardSignFor(0.7, null)).toBe(-1);
  });
});

describe('selectWeaponArm', () => {
  it('auto picks the wrist furthest toward the opponent, regardless of label', () => {
    // "left"-labelled wrist is forward: e.g. MediaPipe swapped labels on a right-handed fencer.
    const landmarks = pose({
      leftWrist: [0.45, 0.45],
      leftElbow: [0.38, 0.42],
      rightWrist: [0.25, 0.35],
      rightElbow: [0.27, 0.42],
    });
    const sel = selectWeaponArm(landmarks, BODY_X, 1, 'auto', null);
    expect(sel?.label).toBe('left');
    expect(sel?.margin).toBeCloseTo(0.2, 6);
  });

  it('respects forward direction for a fencer facing left', () => {
    const landmarks = pose({
      leftWrist: [0.55, 0.45],
      leftElbow: [0.6, 0.42],
      rightWrist: [0.75, 0.35],
      rightElbow: [0.72, 0.42],
    });
    const sel = selectWeaponArm(landmarks, 0.68, -1, 'auto', null);
    expect(sel?.label).toBe('left');
  });

  it('forced mode uses only that label', () => {
    const landmarks = pose({
      leftWrist: [0.45, 0.45],
      leftElbow: [0.38, 0.42],
      rightWrist: [0.25, 0.35],
      rightElbow: [0.27, 0.42],
    });
    const sel = selectWeaponArm(landmarks, BODY_X, 1, 'right', null);
    expect(sel?.label).toBe('right');
    expect(sel?.margin).toBeNull();
  });

  it('keeps following the previous wrist when the lead is within the switch margin', () => {
    const landmarks = pose({
      leftWrist: [0.41, 0.45],
      leftElbow: [0.36, 0.45],
      rightWrist: [0.4, 0.3],
      rightElbow: [0.35, 0.32],
    });
    // Previously tracking the right-labelled wrist (near 0.4, 0.3); left leads by only 0.01.
    const sel = selectWeaponArm(landmarks, BODY_X, 1, 'auto', { x: 0.395, y: 0.3 });
    expect(sel?.label).toBe('right');
    expect(sel?.margin).toBeLessThan(0);
  });

  it('switches when the other wrist leads by more than the switch margin', () => {
    const landmarks = pose({
      leftWrist: [0.46, 0.45],
      leftElbow: [0.4, 0.45],
      rightWrist: [0.4, 0.3],
      rightElbow: [0.35, 0.32],
    });
    const sel = selectWeaponArm(landmarks, BODY_X, 1, 'auto', { x: 0.395, y: 0.3 });
    expect(sel?.label).toBe('left');
  });

  it('ignores low-visibility wrists and returns null when no arm is usable', () => {
    const oneVisible = pose({
      leftWrist: [0.45, 0.45],
      leftElbow: [0.38, 0.42],
      rightWrist: [0.6, 0.35],
      rightElbow: [0.5, 0.42],
      visibility: { rightWrist: 0.2 },
    });
    expect(selectWeaponArm(oneVisible, BODY_X, 1, 'auto', null)?.label).toBe('left');

    const none = pose({
      leftWrist: [0.45, 0.45],
      rightWrist: [0.6, 0.35],
      visibility: { leftWrist: 0.1, rightWrist: 0.1 },
    });
    expect(selectWeaponArm(none, BODY_X, 1, 'auto', null)).toBeNull();
  });
});

describe('armJoints', () => {
  it('pairs a wrist with the other label elbow when that elbow is much closer', () => {
    const landmarks = pose({
      rightWrist: [0.45, 0.45],
      rightElbow: [0.25, 0.3], // far: probably belongs to the other arm
      leftElbow: [0.4, 0.44],
    });
    const joints = armJoints(landmarks, 'right');
    expect(joints?.elbow.x).toBeCloseTo(0.4, 6);
  });

  it('keeps the same-label elbow when it is reasonably close', () => {
    const landmarks = pose({
      rightWrist: [0.45, 0.45],
      rightElbow: [0.39, 0.43],
      leftElbow: [0.41, 0.44],
    });
    const joints = armJoints(landmarks, 'right');
    expect(joints?.elbow.x).toBeCloseTo(0.39, 6);
  });
});
