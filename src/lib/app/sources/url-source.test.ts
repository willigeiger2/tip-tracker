import { describe, expect, it } from 'vitest';
import { isHlsUrl } from './url-source';

describe('isHlsUrl', () => {
  it('detects .m3u8 URLs', () => {
    expect(isHlsUrl('https://example.com/manifest/video.m3u8')).toBe(true);
    expect(isHlsUrl('https://example.com/playlist.M3U8?token=abc')).toBe(true);
  });

  it('returns false for non-HLS URLs', () => {
    expect(isHlsUrl('https://example.com/video.mp4')).toBe(false);
    expect(isHlsUrl('https://example.com/video.webm')).toBe(false);
  });
});
