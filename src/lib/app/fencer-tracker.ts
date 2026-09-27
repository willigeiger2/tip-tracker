import type { DetectionResult, Landmark, TipPosition } from '../../types/fencing';

type TrackId = 'A' | 'B';
type Side = 'left' | 'right';

export interface TipCandidate {
  tip: TipPosition;
  landmarks: Landmark[];
  bodyX?: number;
}

function sideForX(x: number): Side {
  return x < 0.5 ? 'left' : 'right';
}

function distance(a: TipPosition, b: TipPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function normalizedBodyX(candidate: TipCandidate): number {
  if (Number.isFinite(candidate.bodyX)) {
    return Math.max(0, Math.min(1, candidate.bodyX as number));
  }
  return Math.max(0, Math.min(1, candidate.tip.x));
}

export class FencerTracker {
  private lastTipByTrack: Record<TrackId, TipPosition | null> = { A: null, B: null };
  // Temporary default until we add a user-facing switch:
  // left fencer is red (B), right fencer is green (A).
  private readonly trackForSide: Record<Side, TrackId> = { left: 'B', right: 'A' };

  reset(): void {
    this.lastTipByTrack = { A: null, B: null };
  }

  assign(candidates: TipCandidate[]): DetectionResult[] {
    if (candidates.length === 0) {
      return [];
    }

    const usable = candidates.slice(0, 2);
    if (usable.length === 1) {
      const candidate = usable[0];
      const bodyX = normalizedBodyX(candidate);
      let track: TrackId;
      if (bodyX < 0.48) {
        track = this.trackForSide.left;
      } else if (bodyX > 0.52) {
        track = this.trackForSide.right;
      } else {
        const aCost = this.matchCost('A', candidate.tip);
        const bCost = this.matchCost('B', candidate.tip);
        track = aCost <= bCost ? 'A' : 'B';
      }
      const assigned = this.asDetection(track, candidate);
      this.lastTipByTrack[track] = assigned.tip;
      return [assigned];
    }

    const sortedByBody = [...usable].sort((a, b) => normalizedBodyX(a) - normalizedBodyX(b));
    const [leftCandidate, rightCandidate] = sortedByBody;
    const [forA, forB] =
      this.trackForSide.left === 'A'
        ? [leftCandidate, rightCandidate]
        : [rightCandidate, leftCandidate];

    const a = this.asDetection('A', forA);
    const b = this.asDetection('B', forB);
    this.lastTipByTrack.A = a.tip;
    this.lastTipByTrack.B = b.tip;
    return [a, b];
  }

  private asDetection(track: TrackId, candidate: TipCandidate): DetectionResult {
    const side = sideForX(normalizedBodyX(candidate));
    return {
      id: track,
      side,
      tip: {
        ...candidate.tip,
        side,
      },
      landmarks: candidate.landmarks,
    };
  }

  private matchCost(track: TrackId, tip: TipPosition): number {
    const previous = this.lastTipByTrack[track];
    const expectedSide: Side = this.trackForSide.left === track ? 'left' : 'right';
    const tipSide = sideForX(tip.x);

    // Soft side prior only. Identity should mostly follow motion continuity.
    const sidePenalty = tipSide === expectedSide ? 0 : 0.12;
    const confidencePenalty = (1 - tip.confidence) * 0.06;

    if (!previous) {
      const anchorX = expectedSide === 'left' ? 0.25 : 0.75;
      const anchorCost = Math.abs(tip.x - anchorX) * 0.25;
      return anchorCost + sidePenalty + confidencePenalty;
    }

    return distance(previous, tip) + sidePenalty + confidencePenalty;
  }
}
