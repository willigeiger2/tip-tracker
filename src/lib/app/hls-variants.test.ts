import { describe, expect, it } from 'vitest';
import { bestHlsVariant, parseHlsVariants } from './hls-variants';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.4d4020,mp4a.40.2",BANDWIDTH=2370489,FRAME-RATE=60.000,AUDIO="group_audio"
stream_720.m3u8
#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="avc1.4d402a,mp4a.40.2",BANDWIDTH=4977721,FRAME-RATE=60.000,AUDIO="group_audio"
stream_1080.m3u8?p=abc
#EXT-X-STREAM-INF:RESOLUTION=426x240,BANDWIDTH=698143
https://other.example/240.m3u8
`;

describe('parseHlsVariants', () => {
  it('parses resolution, bandwidth and resolves relative URIs', () => {
    const v = parseHlsVariants(MASTER, 'https://cdn.example/abc/manifest/video.m3u8');
    expect(v).toEqual([
      { uri: 'https://cdn.example/abc/manifest/stream_720.m3u8', width: 1280, height: 720, bandwidth: 2370489 },
      { uri: 'https://cdn.example/abc/manifest/stream_1080.m3u8?p=abc', width: 1920, height: 1080, bandwidth: 4977721 },
      { uri: 'https://other.example/240.m3u8', width: 426, height: 240, bandwidth: 698143 },
    ]);
  });

  it('returns nothing for a media playlist', () => {
    expect(parseHlsVariants('#EXTM3U\n#EXTINF:4.0,\nseg_1.mp4\n', 'https://x/y.m3u8')).toEqual([]);
  });
});

describe('bestHlsVariant', () => {
  it('picks the highest resolution', () => {
    expect(bestHlsVariant(parseHlsVariants(MASTER, 'https://cdn.example/m.m3u8'))?.height).toBe(1080);
    expect(bestHlsVariant([])).toBeNull();
  });
});
