// Weapon-arm selection for fencers mode.
//
// MediaPipe's left/right body labels are unreliable on fencing footage (fencers are side-on and
// often facing away from the camera), so in 'auto' mode we pick the weapon arm by geometry instead
// of by label: the wrist furthest forward, i.e. toward the opponent. A little hysteresis keeps the
// choice from flickering when both wrists are roughly level.

import type { Landmark } from '../../types/fencing';

export type ArmLabel = 'left' | 'right';
export type WeaponArmMode = 'auto' | ArmLabel;

// MediaPipe Pose landmark indices (kept local so this module stays free of MediaPipe imports).
const IDX = {
  left: { shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19, thumb: 21 },
  right: { shoulder: 12, elbow: 14, wrist: 16, pinky: 18, index: 20, thumb: 22 },
} as const;

export interface ArmJoints {
  /** MediaPipe label of the wrist used (informational; may not match the true anatomical side). */
  label: ArmLabel;
  wrist: Landmark;
  elbow: Landmark;
  shoulder?: Landmark;
  handHints: { index?: Landmark; thumb?: Landmark; pinky?: Landmark };
}

export interface ArmSelection extends ArmJoints {
  /** Signed forward distance of the chosen wrist from the body anchor (normalized x units). */
  forwardness: number;
  /** Forwardness lead over the other eligible wrist; null when only one arm was eligible. */
  margin: number | null;
}

export interface ArmSelectorOptions {
  /** Minimum wrist/elbow visibility for an arm to be considered. */
  minVisibility?: number;
  /** Required forwardness lead (normalized x) before switching away from the previous arm. */
  switchMargin?: number;
  /** Max distance (normalized) between previous and current wrist to count as "the same arm". */
  continuityRadius?: number;
  /** Re-pair a wrist with the other label's elbow when that elbow is this much closer. */
  elbowSwapRatio?: number;
}

const DEFAULTS: Required<ArmSelectorOptions> = {
  minVisibility: 0.5,
  switchMargin: 0.02,
  continuityRadius: 0.08,
  elbowSwapRatio: 0.6,
};

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function usable(lm: Landmark | undefined, minVisibility: number): lm is Landmark {
  return Boolean(lm) && Number.isFinite(lm!.x) && Number.isFinite(lm!.y) && lm!.visibility >= minVisibility;
}

/**
 * Build the joints for the arm whose wrist carries `label`. The wrist is paired with the elbow of
 * the same label unless the other elbow is much closer (MediaPipe sometimes swaps only the wrist).
 */
export function armJoints(
  landmarks: Landmark[],
  label: ArmLabel,
  options: ArmSelectorOptions = {}
): ArmJoints | null {
  const opts = { ...DEFAULTS, ...options };
  const own = IDX[label];
  const other = IDX[label === 'left' ? 'right' : 'left'];
  const wrist = landmarks[own.wrist];
  if (!usable(wrist, opts.minVisibility)) return null;

  const sameElbow = landmarks[own.elbow];
  const otherElbow = landmarks[other.elbow];
  let elbow: Landmark | undefined = usable(sameElbow, opts.minVisibility) ? sameElbow : undefined;
  let elbowSet: typeof own | typeof other = own;
  if (usable(otherElbow, opts.minVisibility)) {
    if (!elbow || dist(wrist, otherElbow) < dist(wrist, elbow) * opts.elbowSwapRatio) {
      elbow = otherElbow;
      elbowSet = other;
    }
  }
  if (!elbow) return null;

  return {
    label,
    wrist,
    elbow,
    shoulder: landmarks[elbowSet.shoulder],
    handHints: {
      index: landmarks[own.index],
      thumb: landmarks[own.thumb],
      pinky: landmarks[own.pinky],
    },
  };
}

/**
 * Choose the weapon arm for one fencer.
 *
 * @param bodyX           this fencer's body anchor x (normalized)
 * @param forwardSign     +1 if the fencer faces +x (toward the right of frame), -1 otherwise
 * @param previousWrist   wrist position chosen on the previous inference frame, for hysteresis
 */
export function selectWeaponArm(
  landmarks: Landmark[],
  bodyX: number,
  forwardSign: 1 | -1,
  mode: WeaponArmMode,
  previousWrist: { x: number; y: number } | null,
  options: ArmSelectorOptions = {}
): ArmSelection | null {
  const opts = { ...DEFAULTS, ...options };
  const labels: ArmLabel[] = mode === 'auto' ? ['left', 'right'] : [mode];

  const candidates = labels
    .map((label) => armJoints(landmarks, label, opts))
    .filter((c): c is ArmJoints => c !== null)
    .map((c) => ({ ...c, forwardness: (c.wrist.x - bodyX) * forwardSign }));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { ...candidates[0], margin: null };

  candidates.sort((a, b) => b.forwardness - a.forwardness);
  const [front, back] = candidates;
  const margin = front.forwardness - back.forwardness;

  // Hysteresis: if the back wrist is clearly the one we were following, keep it unless the
  // front wrist leads by more than switchMargin.
  if (previousWrist && margin < opts.switchMargin) {
    const dFront = dist(front.wrist, previousWrist);
    const dBack = dist(back.wrist, previousWrist);
    if (dBack < dFront && dBack <= opts.continuityRadius) {
      return { ...back, margin: -margin };
    }
  }

  return { ...front, margin };
}

/** Direction a fencer faces: toward the opponent if known, else toward frame center. */
export function forwardSignFor(bodyX: number, opponentBodyX: number | null): 1 | -1 {
  if (opponentBodyX !== null && Number.isFinite(opponentBodyX) && opponentBodyX !== bodyX) {
    return opponentBodyX > bodyX ? 1 : -1;
  }
  return bodyX < 0.5 ? 1 : -1;
}
