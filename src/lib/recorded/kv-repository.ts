import { DEFAULT_RECORDED_FPS, type RecordedTrackSet, type RecordedTrackSetSummary } from './types';
import { normalizeTrackSet, trackSetToSummary } from './schema';

export const TRACKS_INDEX_KEY = 'tracks:index';
export const TRACKS_KEY_PREFIX = 'tracks:';
export const MAX_TRACK_SET_BYTES = 1_000_000;

export class InvalidTrackSetError extends Error {
  constructor(message = 'Invalid track-set payload') {
    super(message);
    this.name = 'InvalidTrackSetError';
  }
}

function isValidSummary(value: unknown): value is RecordedTrackSetSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RecordedTrackSetSummary>;
  return (
    typeof candidate.videoId === 'string' &&
    candidate.videoId.trim().length > 0 &&
    typeof candidate.videoUrl === 'string' &&
    Number.isFinite(candidate.updatedAt) &&
    Number.isFinite(candidate.keyframeCount)
  );
}

function normalizeSummaryIndex(raw: unknown): RecordedTrackSetSummary[] {
  if (!Array.isArray(raw)) return [];

  const deduped = new Map<string, RecordedTrackSetSummary>();
  for (const item of raw) {
    if (!isValidSummary(item)) continue;
    const summary: RecordedTrackSetSummary = {
      videoId: item.videoId,
      videoUrl: item.videoUrl,
      updatedAt: Math.max(0, Math.round(item.updatedAt)),
      keyframeCount: Math.max(0, Math.round(item.keyframeCount)),
    };
    const existing = deduped.get(summary.videoId);
    if (!existing || summary.updatedAt >= existing.updatedAt) {
      deduped.set(summary.videoId, summary);
    }
  }

  return [...deduped.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsertSummary(
  summaries: RecordedTrackSetSummary[],
  summary: RecordedTrackSetSummary
): RecordedTrackSetSummary[] {
  const next = summaries.filter((item) => item.videoId !== summary.videoId);
  next.push(summary);
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

export function trackSetStorageKey(videoId: string): string {
  return `${TRACKS_KEY_PREFIX}${videoId}`;
}

export async function listTrackSummaries(kv: KVNamespace): Promise<RecordedTrackSetSummary[]> {
  const raw = await kv.get(TRACKS_INDEX_KEY, 'text');
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return normalizeSummaryIndex(parsed);
  } catch {
    return [];
  }
}

export async function getTrackSet(kv: KVNamespace, videoId: string): Promise<RecordedTrackSet | null> {
  const raw = await kv.get(trackSetStorageKey(videoId), 'text');
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return normalizeTrackSet(parsed, videoId, '', DEFAULT_RECORDED_FPS);
  } catch {
    return null;
  }
}

export async function putTrackSet(
  kv: KVNamespace,
  videoId: string,
  payload: unknown
): Promise<{ trackSet: RecordedTrackSet; summary: RecordedTrackSetSummary }> {
  const fallbackUrl =
    payload && typeof payload === 'object' && typeof (payload as { videoUrl?: unknown }).videoUrl === 'string'
      ? String((payload as { videoUrl?: unknown }).videoUrl)
      : '';

  const normalized = normalizeTrackSet(payload, videoId, fallbackUrl, DEFAULT_RECORDED_FPS);
  if (!normalized) {
    throw new InvalidTrackSetError();
  }

  const existing = await getTrackSet(kv, videoId);
  const now = Date.now();
  const trackSet: RecordedTrackSet = {
    ...normalized,
    version: 1,
    videoId,
    createdAt: existing?.createdAt ?? normalized.createdAt ?? now,
    updatedAt: now,
  };

  await kv.put(trackSetStorageKey(videoId), JSON.stringify(trackSet));

  const summary = trackSetToSummary(trackSet);
  const index = await listTrackSummaries(kv);
  const nextIndex = upsertSummary(index, summary);
  await kv.put(TRACKS_INDEX_KEY, JSON.stringify(nextIndex));

  return { trackSet, summary };
}
