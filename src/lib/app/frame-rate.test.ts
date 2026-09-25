import { describe, expect, it } from 'vitest';
import {
  chooseManifestFrameRate,
  frameIndex,
  parseManifestFrameRates,
  seekTimeForFrame,
} from './frame-rate';

describe('parseManifestFrameRates', () => {
  it('parses FRAME-RATE values from master manifest variant lines', () => {
    const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1048576,RESOLUTION=640x360,FRAME-RATE=29.970,CODECS="avc1.4d401e,mp4a.40.2"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6291456,RESOLUTION=1920x1080,FRAME-RATE=59.94,CODECS="avc1.640028,mp4a.40.2"
high.m3u8`;

    expect(parseManifestFrameRates(manifest)).toEqual([29.97, 59.94]);
  });

  it('returns empty list when no FRAME-RATE is present', () => {
    const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1048576,RESOLUTION=640x360
low.m3u8`;
    expect(parseManifestFrameRates(manifest)).toEqual([]);
  });
});

describe('chooseManifestFrameRate', () => {
  it('chooses the highest fps from variants', () => {
    expect(chooseManifestFrameRate([24, 29.97, 60])).toBe(60);
  });

  it('returns null for empty input', () => {
    expect(chooseManifestFrameRate([])).toBeNull();
  });
});

describe('frame helpers', () => {
  it('frameIndex floors time * fps (frame-center safe)', () => {
    expect(frameIndex(1.0, 30)).toBe(30);
    expect(frameIndex(1.49 / 30, 30)).toBe(1);
    expect(frameIndex(1.99 / 30, 30)).toBe(1);
    expect(frameIndex(2.01 / 30, 30)).toBe(2);
    expect(frameIndex((15 + 0.5) / 30, 30)).toBe(15);
  });

  it('seekTimeForFrame targets frame centers and clamps to duration', () => {
    expect(seekTimeForFrame(0, 30, 100)).toBeCloseTo(0.5 / 30, 8);
    expect(seekTimeForFrame(30, 30, 100)).toBeCloseTo(1 + 0.5 / 30, 8);
    expect(seekTimeForFrame(-50, 30, 100)).toBe(0);
    expect(seekTimeForFrame(99999, 30, 2)).toBe(2);
  });
});
