import { describe, expect, it } from 'vitest';
import { createEmptyTrackSet } from './schema';
import { getTrackSet, listTrackSummaries, putTrackSet, trackSetStorageKey } from './kv-repository';

class MemoryKv {
  private readonly data = new Map<string, string>();

  async get(key: string, type: 'text' = 'text'): Promise<string | null> {
    if (type !== 'text') {
      throw new Error(`Unsupported get type: ${type}`);
    }
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

function asKvNamespace(memoryKv: MemoryKv): KVNamespace {
  return memoryKv as unknown as KVNamespace;
}

describe('kv-repository', () => {
  it('writes track sets and updates the summary index', async () => {
    const kv = asKvNamespace(new MemoryKv());
    const set = createEmptyTrackSet('vid-a', 'https://example.com/one.m3u8', 30, 1.0);
    set.tracks[0].keyframes.push({ time: 0.2, x: 0.3, y: 0.4 });

    const saved = await putTrackSet(kv, set.videoId, set);
    expect(saved.trackSet.videoId).toBe('vid-a');
    expect(saved.summary.keyframeCount).toBe(1);

    const loaded = await getTrackSet(kv, set.videoId);
    expect(loaded?.tracks[0].keyframes).toHaveLength(1);

    const summaries = await listTrackSummaries(kv);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].videoId).toBe('vid-a');
  });

  it('preserves createdAt when overwriting the same videoId', async () => {
    const kv = asKvNamespace(new MemoryKv());
    const first = createEmptyTrackSet('vid-b', 'https://example.com/two.m3u8', 30, 1.0);
    const firstSaved = await putTrackSet(kv, first.videoId, first);

    const nextPayload = {
      ...firstSaved.trackSet,
      createdAt: firstSaved.trackSet.createdAt + 5000,
      tracks: firstSaved.trackSet.tracks.map((track) =>
        track.id === 'B'
          ? {
              ...track,
              keyframes: [...track.keyframes, { time: 0.3, x: 0.6, y: 0.3 }],
            }
          : track
      ),
    };

    const secondSaved = await putTrackSet(kv, first.videoId, nextPayload);
    expect(secondSaved.trackSet.createdAt).toBe(firstSaved.trackSet.createdAt);
    expect(secondSaved.trackSet.updatedAt).toBeGreaterThanOrEqual(firstSaved.trackSet.updatedAt);
  });

  it('returns null for malformed stored JSON', async () => {
    const memory = new MemoryKv();
    const kv = asKvNamespace(memory);
    await memory.put(trackSetStorageKey('broken'), '{nope');

    const loaded = await getTrackSet(kv, 'broken');
    expect(loaded).toBeNull();
  });
});
