import { describe, expect, it } from 'vitest';
import {
  createEmptyTrackSet,
  exportTrackSetToJson,
  importTrackSetFromJson,
  keyframeCount,
  normalizeTrackSet,
} from './track-store';

describe('createEmptyTrackSet', () => {
  it('creates A/green and B/red empty tracks', () => {
    const set = createEmptyTrackSet('vid-1', 'https://example.com/clip.m3u8', 30, 1.0);
    expect(set.videoId).toBe('vid-1');
    expect(set.tracks).toHaveLength(2);
    expect(set.tracks[0].id).toBe('A');
    expect(set.tracks[0].color).toBe('#00ff00');
    expect(set.tracks[1].id).toBe('B');
    expect(set.tracks[1].color).toBe('#ff5030');
  });
});

describe('normalizeTrackSet', () => {
  it('rejects non-v1 payloads', () => {
    expect(normalizeTrackSet({ version: 2 }, 'v', '', 30)).toBeNull();
  });

  it('clamps coords, sorts keyframes, and dedupes by frame index', () => {
    const raw = {
      version: 1,
      videoUrl: 'https://example.com/a.m3u8',
      fps: 30,
      maxGapSeconds: 1,
      createdAt: 1,
      updatedAt: 2,
      tracks: [
        {
          id: 'A',
          keyframes: [
            { time: 1.014, x: 1.7, y: -0.2 },
            { time: 1.01, x: 0.4, y: 0.4 },
            { time: 0.2, x: 0.2, y: 0.2 },
          ],
        },
      ],
    };

    const normalized = normalizeTrackSet(raw, 'expected', 'https://fallback', 30)!;
    expect(normalized.videoId).toBe('expected');
    expect(normalized.tracks[0].keyframes).toHaveLength(2);
    expect(normalized.tracks[0].keyframes[1].x).toBe(1);
    expect(normalized.tracks[0].keyframes[1].y).toBe(0);
  });

  it('migrates legacy default red track colors to the current B color', () => {
    const raw = {
      version: 1,
      videoUrl: 'https://example.com/a.m3u8',
      fps: 30,
      maxGapSeconds: 1,
      createdAt: 1,
      updatedAt: 2,
      tracks: [
        { id: 'A', color: '#00ff00', keyframes: [] },
        { id: 'B', color: '#ff8060', keyframes: [] },
      ],
    };

    const normalized = normalizeTrackSet(raw, 'expected', 'https://fallback', 30)!;
    expect(normalized.tracks.find((t) => t.id === 'B')?.color).toBe('#ff5030');
  });

  it('preserves custom track colors', () => {
    const raw = {
      version: 1,
      videoUrl: 'https://example.com/a.m3u8',
      fps: 30,
      maxGapSeconds: 1,
      createdAt: 1,
      updatedAt: 2,
      tracks: [
        { id: 'A', color: '#00ff00', keyframes: [] },
        { id: 'B', color: '#fa2f75', keyframes: [] },
      ],
    };

    const normalized = normalizeTrackSet(raw, 'expected', 'https://fallback', 30)!;
    expect(normalized.tracks.find((t) => t.id === 'B')?.color).toBe('#fa2f75');
  });
});

describe('import/export helpers', () => {
  it('round-trips valid JSON', () => {
    const original = createEmptyTrackSet('vid-2', 'https://example.com/b.m3u8');
    original.tracks[0].keyframes.push({ time: 0.5, x: 0.3, y: 0.4 });

    const json = exportTrackSetToJson(original);
    const imported = importTrackSetFromJson(json, 'vid-2', original.videoUrl, 30);

    expect(imported).not.toBeNull();
    expect(keyframeCount(imported!)).toBe(1);
  });

  it('returns null for malformed JSON', () => {
    expect(importTrackSetFromJson('{nope', 'v', '', 30)).toBeNull();
  });
});
