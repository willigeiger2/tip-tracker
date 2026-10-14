import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyTrackSet } from './schema';
import { fetchTrackSetFromKv, fetchTrackSummariesFromKv, saveTrackSetToKv } from './kv-client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kv-client', () => {
  it('returns null on 404 for a track-set GET', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const loaded = await fetchTrackSetFromKv('missing-video');
    expect(loaded).toBeNull();
  });

  it('loads and normalizes a track-set payload', async () => {
    const set = createEmptyTrackSet('vid-a', 'https://example.com/a.m3u8', 30, 1.0);
    set.tracks[0].keyframes.push({ time: 0.2, x: 0.3, y: 0.4 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, trackSet: set }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const loaded = await fetchTrackSetFromKv('vid-a');
    expect(loaded?.videoId).toBe('vid-a');
    expect(loaded?.tracks[0].keyframes).toHaveLength(1);
  });

  it('saves track-set and returns normalized server payload', async () => {
    const set = createEmptyTrackSet('vid-b', 'https://example.com/b.m3u8', 30, 1.0);
    set.updatedAt = set.updatedAt + 2500;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, trackSet: set }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const saved = await saveTrackSetToKv(set);
    expect(saved.videoId).toBe('vid-b');
  });

  it('loads summaries and sorts by updatedAt descending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            summaries: [
              { videoId: 'older', videoUrl: 'https://example.com/1', updatedAt: 100, keyframeCount: 1 },
              { videoId: 'newer', videoUrl: 'https://example.com/2', updatedAt: 200, keyframeCount: 2 },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );

    const summaries = await fetchTrackSummariesFromKv();
    expect(summaries.map((s) => s.videoId)).toEqual(['newer', 'older']);
  });
});
