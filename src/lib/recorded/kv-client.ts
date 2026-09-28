import { DEFAULT_RECORDED_FPS, type RecordedTrackSet, type RecordedTrackSetSummary } from './types';
import { normalizeTrackSet } from './schema';

interface ApiErrorPayload {
  ok?: false;
  error?: string;
  message?: string;
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const candidate = payload as ApiErrorPayload;
  if (typeof candidate.message === 'string' && candidate.message.trim()) {
    return candidate.message;
  }
  if (typeof candidate.error === 'string' && candidate.error.trim()) {
    return candidate.error;
  }
  return fallback;
}

export async function fetchTrackSetFromKv(videoId: string): Promise<RecordedTrackSet | null> {
  const response = await fetch(`/api/tracks/${encodeURIComponent(videoId)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (response.status === 404) {
    return null;
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    trackSet?: unknown;
    message?: string;
    error?: string;
  };

  if (!response.ok || payload.ok !== true) {
    throw new Error(getErrorMessage(payload, `Failed to load track set (${response.status}).`));
  }

  const rawTrackSet = payload.trackSet;
  if (!rawTrackSet || typeof rawTrackSet !== 'object') {
    throw new Error('Track set payload is missing.');
  }

  const fallbackUrl =
    typeof (rawTrackSet as { videoUrl?: unknown }).videoUrl === 'string'
      ? String((rawTrackSet as { videoUrl?: unknown }).videoUrl)
      : '';

  const normalized = normalizeTrackSet(rawTrackSet, videoId, fallbackUrl, DEFAULT_RECORDED_FPS);
  if (!normalized) {
    throw new Error('Track set payload was invalid.');
  }

  return normalized;
}

export async function saveTrackSetToKv(set: RecordedTrackSet): Promise<RecordedTrackSet> {
  const response = await fetch(`/api/tracks/${encodeURIComponent(set.videoId)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(set),
  });

  const payload = (await response.json()) as {
    ok?: boolean;
    trackSet?: unknown;
    message?: string;
    error?: string;
  };

  if (!response.ok || payload.ok !== true) {
    throw new Error(getErrorMessage(payload, `Failed to save track set (${response.status}).`));
  }

  const rawTrackSet = payload.trackSet;
  if (!rawTrackSet || typeof rawTrackSet !== 'object') {
    throw new Error('Saved track set payload is missing.');
  }

  const fallbackUrl =
    typeof (rawTrackSet as { videoUrl?: unknown }).videoUrl === 'string'
      ? String((rawTrackSet as { videoUrl?: unknown }).videoUrl)
      : set.videoUrl;

  const normalized = normalizeTrackSet(rawTrackSet, set.videoId, fallbackUrl, set.fps || DEFAULT_RECORDED_FPS);
  if (!normalized) {
    throw new Error('Saved track set payload was invalid.');
  }

  return normalized;
}

export async function fetchTrackSummariesFromKv(): Promise<RecordedTrackSetSummary[]> {
  const response = await fetch('/api/tracks', {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  const payload = (await response.json()) as {
    ok?: boolean;
    summaries?: unknown;
    message?: string;
    error?: string;
  };

  if (!response.ok || payload.ok !== true) {
    throw new Error(getErrorMessage(payload, `Failed to load track summaries (${response.status}).`));
  }

  if (!Array.isArray(payload.summaries)) {
    return [];
  }

  const summaries: RecordedTrackSetSummary[] = [];
  for (const item of payload.summaries) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<RecordedTrackSetSummary>;
    const updatedAt = Number(candidate.updatedAt);
    const keyframeCount = Number(candidate.keyframeCount);
    if (
      typeof candidate.videoId !== 'string' ||
      typeof candidate.videoUrl !== 'string' ||
      !Number.isFinite(updatedAt) ||
      !Number.isFinite(keyframeCount)
    ) {
      continue;
    }

    summaries.push({
      videoId: candidate.videoId,
      videoUrl: candidate.videoUrl,
      updatedAt: Math.max(0, Math.round(updatedAt)),
      keyframeCount: Math.max(0, Math.round(keyframeCount)),
    });
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}
