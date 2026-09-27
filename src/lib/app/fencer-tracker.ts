import type { DetectionResult, Landmark, TipPosition } from '../../types/fencing';

type TrackId = 'A' | 'B';
type Side = 'left' | 'right';

export interface TipCandidate {
  tip: TipPosition;
  landmarks: Landmark[];
}

function sideForX(x: number): Side {
  return x < 0.5 ? 'left' : 'right';
}

function distance(a: TipPosition, b: TipPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export class FencerTracker {
  private lastTipByTrack: Record<TrackId, TipPosition | null> = { A: null, B: null };

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
      const aCost = this.matchCost('A', candidate.tip);
      const bCost = this.matchCost('B', candidate.tip);
      const track: TrackId = aCost <= bCost ? 'A' : 'B';
      const assigned = this.asDetection(track, candidate);
      this.lastTipByTrack[track] = assigned.tip;
      return [assigned];
    }

    const [c0, c1] = usable;
    const costAB = this.matchCost('A', c0.tip) + this.matchCost('B', c1.tip);
    const costBA = this.matchCost('A', c1.tip) + this.matchCost('B', c0.tip);

    const [forA, forB] = costAB <= costBA ? [c0, c1] : [c1, c0];
    const a = this.asDetection('A', forA);
    const b = this.asDetection('B', forB);
    this.lastTipByTrack.A = a.tip;
    this.lastTipByTrack.B = b.tip;
    return [a, b];
  }

  private asDetection(track: TrackId, candidate: TipCandidate): DetectionResult {
    const side = sideForX(candidate.tip.x);
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
    const expectedSide: Side = track === 'A' ? 'left' : 'right';
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
