// Saved-video library: summaries of track sets stored in Workers KV.

import { fetchTrackSummariesFromKv } from '../recorded/kv-client';
import type { RecordedTrackSetSummary } from '../recorded/types';
import { events, isVideoSource } from './app';

let summaries: RecordedTrackSetSummary[] = [];
let loading = false;
let refreshSequence = 0;

export function getSummaries(): readonly RecordedTrackSetSummary[] {
  return summaries;
}

export function isLoading(): boolean {
  return loading;
}

export function savedVideoTitle(summary: RecordedTrackSetSummary): string {
  try {
    const parsed = new URL(summary.videoUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments[segments.length - 1];
    if (tail && tail !== 'video.m3u8') return decodeURIComponent(tail);
    return summary.videoId;
  } catch {
    return summary.videoId;
  }
}

export function upsertSummary(summary: RecordedTrackSetSummary): void {
  summaries = [...summaries.filter((item) => item.videoId !== summary.videoId), summary].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  events.emit('library');
}

export async function refreshLibrary(options: { silent?: boolean } = {}): Promise<void> {
  if (!isVideoSource()) return;

  const sequence = ++refreshSequence;
  loading = true;
  if (!options.silent) {
    events.emit('library-status', 'Loading saved video library...');
  }
  events.emit('library');

  try {
    const next = await fetchTrackSummariesFromKv();
    if (sequence !== refreshSequence) return;
    summaries = next;
    const count = next.length;
    events.emit(
      'library-status',
      count === 0 ? 'No saved videos in library yet.' : `${count} saved video${count === 1 ? '' : 's'} in library.`
    );
  } catch (error) {
    if (sequence !== refreshSequence) return;
    console.warn('Failed to load saved videos list:', error);
    events.emit('library-status', 'Library unavailable right now.');
  } finally {
    if (sequence === refreshSequence) {
      loading = false;
      events.emit('library');
    }
  }
}
