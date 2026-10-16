import { describe, expect, it } from 'vitest';
import { activeHits, hitAtFrame, listHitsWithFrames, removeHit, toggleHitAtFrame } from './hits';
import { normalizeTrackSet } from './schema';

describe('toggleHitAtFrame', () => {
  it('adds a hit at the frame start time, then removes it on the second toggle', () => {
    const first = toggleHitAtFrame([], 'A', 30, 30);
    expect(first.added).toBe(true);
    expect(first.hits).toEqual([{ time: 1, trackId: 'A' }]);
    const second = toggleHitAtFrame(first.hits, 'A', 30, 30);
    expect(second.added).toBe(false);
    expect(second.hits).toEqual([]);
  });

  it('keeps hits for both fencers on the same frame (double touch) and sorts by time', () => {
    let hits = toggleHitAtFrame([], 'B', 90, 30).hits;
    hits = toggleHitAtFrame(hits, 'A', 90, 30).hits;
    hits = toggleHitAtFrame(hits, 'A', 15, 30).hits;
    expect(hits).toEqual([
      { time: 0.5, trackId: 'A' },
      { time: 3, trackId: 'A' },
      { time: 3, trackId: 'B' },
    ]);
    expect(hitAtFrame(hits, 'B', 90, 30)).toEqual({ time: 3, trackId: 'B' });
    expect(hitAtFrame(hits, 'B', 91, 30)).toBeNull();
  });
});

describe('hit helpers', () => {
  const hits = [
    { time: 1, trackId: 'A' as const },
    { time: 2, trackId: 'B' as const },
  ];

  it('lists frames at the given fps', () => {
    expect(listHitsWithFrames(hits, 60).map((h) => h.frame)).toEqual([60, 120]);
  });

  it('finds hits whose effect window covers t', () => {
    expect(activeHits(hits, 0.99, 0.5)).toEqual([]);
    expect(activeHits(hits, 1, 0.5)).toEqual([hits[0]]);
    expect(activeHits(hits, 1.49, 0.5)).toEqual([hits[0]]);
    expect(activeHits(hits, 1.5, 0.5)).toEqual([]);
  });

  it('removes a specific hit', () => {
    expect(removeHit(hits, { time: 2, trackId: 'B' })).toEqual([hits[0]]);
  });
});

describe('normalizeTrackSet hits', () => {
  const base = { version: 1, fps: 30, tracks: [] };

  it('defaults to no hits for older sets', () => {
    expect(normalizeTrackSet(base, 'v', 'u')?.hits).toEqual([]);
  });

  it('keeps valid hits sorted and drops invalid ones', () => {
    const set = normalizeTrackSet(
      { ...base, hits: [{ time: 2, trackId: 'B' }, { time: -1, trackId: 'A' }, { time: 1, trackId: 'C' }, { time: 1, trackId: 'A' }] },
      'v',
      'u'
    );
    expect(set?.hits).toEqual([
      { time: 1, trackId: 'A' },
      { time: 2, trackId: 'B' },
    ]);
  });
});
