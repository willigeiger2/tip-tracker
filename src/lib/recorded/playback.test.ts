import { describe, expect, it } from 'vitest';
import { buildRecordedFrameSnapshot } from './playback';
import type { RecordedTrackSet } from './types';

const set: RecordedTrackSet = {
  version: 1,
  videoId: 'vid',
  videoUrl: 'https://example.com/vid.m3u8',
  fps: 30,
  maxGapSeconds: 1,
  createdAt: 1,
  updatedAt: 1,
  tracks: [
    {
      id: 'A',
      label: 'Track A',
      color: '#00ff00',
      keyframes: [
        { time: 0, x: 0.2, y: 0.2 },
        { time: 1, x: 0.4, y: 0.4 },
      ],
    },
    {
      id: 'B',
      label: 'Track B',
      color: '#ff0000',
      keyframes: [
        { time: 0, x: 0.8, y: 0.2 },
        { time: 1, x: 0.6, y: 0.4 },
      ],
    },
  ],
};

describe('buildRecordedFrameSnapshot', () => {
  it('produces two fencers and detections while inside track runs', () => {
    const frame = buildRecordedFrameSnapshot(set, 0.5, 1234, 10, 1.0);
    expect(frame.fencers.size).toBe(2);
    expect(frame.fencers.get('A')?.trail.length).toBeGreaterThan(0);
    expect(frame.fencers.get('B')?.trail.length).toBeGreaterThan(0);
    expect(frame.detections).toHaveLength(2);
  });
});
