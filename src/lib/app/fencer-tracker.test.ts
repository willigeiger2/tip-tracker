import { describe, expect, it } from 'vitest';
import { FencerTracker } from './fencer-tracker';
import type { TipPosition } from '../../types/fencing';

function tip(x: number, y = 0.5, confidence = 1): TipPosition {
  return {
    x,
    y,
    z: 0,
    confidence,
    timestamp: 1000,
    side: x < 0.5 ? 'left' : 'right',
  };
}

function candidate(tipX: number, bodyX: number) {
  return { tip: tip(tipX), bodyX, landmarks: [] };
}

describe('FencerTracker', () => {
  it('assigns by body-side order (red-left, green-right)', () => {
    const tracker = new FencerTracker();
    const out = tracker.assign([
      candidate(0.8, 0.2),
      candidate(0.2, 0.8),
    ]);

    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get('A')?.tip.x).toBeCloseTo(0.2, 6);
    expect(byId.get('B')?.tip.x).toBeCloseTo(0.8, 6);
  });

  it('keeps body-side identity even when tips cross center', () => {
    const tracker = new FencerTracker();
    tracker.assign([
      candidate(0.2, 0.2),
      candidate(0.8, 0.8),
    ]);

    const out = tracker.assign([
      candidate(0.78, 0.22),
      candidate(0.26, 0.78),
    ]);

    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get('A')?.tip.x).toBeCloseTo(0.26, 6);
    expect(byId.get('B')?.tip.x).toBeCloseTo(0.78, 6);
  });

  it('assigns single-candidate frame by body-side when clearly left/right', () => {
    const tracker = new FencerTracker();
    tracker.assign([
      candidate(0.2, 0.2),
      candidate(0.8, 0.8),
    ]);

    const out = tracker.assign([candidate(0.75, 0.2)]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('B');
  });

  it('reset forgets previous state', () => {
    const tracker = new FencerTracker();
    tracker.assign([
      candidate(0.2, 0.2),
      candidate(0.8, 0.8),
    ]);
    tracker.reset();

    const out = tracker.assign([candidate(0.78, 0.78)]);
    expect(out[0].id).toBe('A');
  });
});
