import { DEFAULT_RECORDED_FPS, type RecordedTrackSet } from './types';
import { normalizeTrackSet } from './schema';

export {
  createEmptyTrackSet,
  exportTrackSetToJson,
  importTrackSetFromJson,
  keyframeCount,
  normalizeTrackSet,
  trackSetToSummary,
} from './schema';

export const TRACKS_STORAGE_PREFIX = 'tiptrack:v1:tracks:';

export function storageKeyForVideo(videoId: string): string {
  return `${TRACKS_STORAGE_PREFIX}${videoId}`;
}

export function loadTrackSet(
  videoId: string,
  videoUrl = '',
  fallbackFps = DEFAULT_RECORDED_FPS
): RecordedTrackSet | null {
  const raw = localStorage.getItem(storageKeyForVideo(videoId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return normalizeTrackSet(parsed, videoId, videoUrl, fallbackFps);
  } catch {
    return null;
  }
}

export function saveTrackSet(
  set: RecordedTrackSet,
  options: { touchUpdatedAt?: boolean } = {}
): void {
  const touchUpdatedAt = options.touchUpdatedAt !== false;
  const payload: RecordedTrackSet = {
    ...set,
    version: 1,
    updatedAt: touchUpdatedAt ? Date.now() : Number.isFinite(set.updatedAt) ? set.updatedAt : Date.now(),
  };
  localStorage.setItem(storageKeyForVideo(payload.videoId), JSON.stringify(payload));
}
