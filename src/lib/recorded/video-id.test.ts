import { describe, expect, it } from 'vitest';
import { deriveVideoId, extractStreamUid } from './video-id';

describe('extractStreamUid', () => {
  it('extracts Stream uid from manifest path', () => {
    const uid = extractStreamUid(
      'https://customer-abc.cloudflarestream.com/8f5f410961f04f7f89fa2f0bcaef5137/manifest/video.m3u8'
    );
    expect(uid).toBe('8f5f410961f04f7f89fa2f0bcaef5137');
  });

  it('extracts Stream uid from watch.videodelivery.net URL', () => {
    const uid = extractStreamUid('https://watch.videodelivery.net/8f5f410961f04f7f89fa2f0bcaef5137');
    expect(uid).toBe('8f5f410961f04f7f89fa2f0bcaef5137');
  });

  it('returns null when no Stream uid exists', () => {
    expect(extractStreamUid('https://example.com/video.mp4')).toBeNull();
  });
});

describe('deriveVideoId', () => {
  it('returns the stream uid when present', () => {
    expect(
      deriveVideoId('https://watch.videodelivery.net/8F5F410961F04F7F89FA2F0BCAEF5137')
    ).toBe('8f5f410961f04f7f89fa2f0bcaef5137');
  });

  it('falls back to a stable URL hash for non-stream URLs', () => {
    const url = 'https://cdn.example.com/fencing/demo.mp4?token=abc';
    const id = deriveVideoId(url);
    expect(id).toMatch(/^url-[0-9a-f]{8}$/);
    expect(deriveVideoId(url)).toBe(id);
  });
});
