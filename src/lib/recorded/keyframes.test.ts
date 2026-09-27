import { describe, expect, it } from 'vitest';
import {
  deleteKeyframeAtFrame,
  keyframeAtFrame,
  listKeyframesWithFrames,
  nearestNeighborFrames,
  upsertKeyframeAtFrame,
} from './keyframes';
import type { RecordedTrack } from './types';

function track(keyframes: RecordedTrack['keyframes']): RecordedTrack {
  return {
    id: 'A',
    label: 'Track A',
    color: '#00ff00',
    keyframes,
  };
}

describe('upsertKeyframeAtFrame', () => {
  it('replaces existing keyframe at frame and keeps sorting', () => {
    const input = track([
      { time: 0.0, x: 0.1, y: 0.1 },
      { time: 2 / 30, x: 0.2, y: 0.2 },
    ]);

    const out = upsertKeyframeAtFrame(input, 2, 0.7, 0.8, 30);
    expect(out.keyframes).toHaveLength(2);
    expect(out.keyframes[1]).toEqual({ time: 2 / 30, x: 0.7, y: 0.8 });
  });
});

describe('deleteKeyframeAtFrame', () => {
  it('deletes by frame index', () => {
    const input = track([
      { time: 0, x: 0.1, y: 0.1 },
      { time: 1 / 30, x: 0.2, y: 0.2 },
    ]);
    const out = deleteKeyframeAtFrame(input, 1, 30);
    expect(out.keyframes).toHaveLength(1);
    expect(out.keyframes[0].time).toBe(0);
  });
});

describe('neighbor helpers', () => {
  it('finds previous/current/next around frame', () => {
    const input = track([
      { time: 0, x: 0.1, y: 0.1 },
      { time: 10 / 30, x: 0.2, y: 0.2 },
      { time: 20 / 30, x: 0.3, y: 0.3 },
    ]);

    const n = nearestNeighborFrames(input, 10, 30);
    expect(n.previous?.frame).toBe(0);
    expect(n.current?.frame).toBe(10);
    expect(n.next?.frame).toBe(20);
  });

  it('lists keyframes with frame indices', () => {
    const rows = listKeyframesWithFrames(
      track([
        { time: 0, x: 0.1, y: 0.1 },
        { time: 0.5, x: 0.2, y: 0.2 },
      ]),
      30
    );

    expect(rows.map((r) => r.frame)).toEqual([0, 15]);
    expect(keyframeAtFrame(track(rows), 15, 30)).not.toBeNull();
  });
});
