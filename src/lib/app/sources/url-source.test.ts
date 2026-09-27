import { describe, expect, it } from 'vitest';
import { isCrossOriginUrl, isHlsUrl } from './url-source';

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

describe('isCrossOriginUrl', () => {
  it('returns true for different origins', () => {
    expect(
      isCrossOriginUrl(
        'https://hqvideos.boutcaster.com/7b135988f581f61debbf5d1c38a520ce.mp4',
        'http://localhost:4321',
        'http://localhost:4321/'
      )
    ).toBe(true);
  });

  it('returns false for same-origin URLs', () => {
    expect(isCrossOriginUrl('/clip.mp4', 'http://localhost:4321', 'http://localhost:4321/')).toBe(
      false
    );
    expect(
      isCrossOriginUrl(
        'http://localhost:4321/clip.mp4',
        'http://localhost:4321',
        'http://localhost:4321/'
      )
    ).toBe(false);
  });
});
