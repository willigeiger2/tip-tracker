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

describe('FencerTracker', () => {
  it('initially assigns by side prior', () => {
    const tracker = new FencerTracker();
    const out = tracker.assign([
      { tip: tip(0.8), landmarks: [] },
      { tip: tip(0.2), landmarks: [] },
    ]);

    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get('A')?.tip.x).toBeCloseTo(0.2, 6);
    expect(byId.get('B')?.tip.x).toBeCloseTo(0.8, 6);
  });

  it('keeps identity by proximity on subsequent frames', () => {
    const tracker = new FencerTracker();
    tracker.assign([
      { tip: tip(0.2), landmarks: [] },
      { tip: tip(0.8), landmarks: [] },
    ]);

    const out = tracker.assign([
      { tip: tip(0.27), landmarks: [] },
      { tip: tip(0.73), landmarks: [] },
    ]);

    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get('A')?.tip.x).toBeCloseTo(0.27, 6);
    expect(byId.get('B')?.tip.x).toBeCloseTo(0.73, 6);
  });

  it('assigns single-candidate frame to the nearer existing track', () => {
    const tracker = new FencerTracker();
    tracker.assign([
      { tip: tip(0.2), landmarks: [] },
      { tip: tip(0.8), landmarks: [] },
    ]);

    const out = tracker.assign([{ tip: tip(0.25), landmarks: [] }]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('A');
  });

  it('reset forgets previous state', () => {
    const tracker = new FencerTracker();
    tracker.assign([
      { tip: tip(0.2), landmarks: [] },
      { tip: tip(0.8), landmarks: [] },
    ]);
    tracker.reset();

    const out = tracker.assign([{ tip: tip(0.78), landmarks: [] }]);
    expect(out[0].id).toBe('B');
  });
});
