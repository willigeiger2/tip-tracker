import {
  DEFAULT_MAX_GAP_SECONDS,
  DEFAULT_RECORDED_FPS,
  type Keyframe,
  type RecordedTrack,
  type RecordedTrackId,
  type RecordedTrackSet,
  type RecordedTrackSetSummary,
} from './types';

const TRACK_META: Record<RecordedTrackId, { label: string; color: string; side: 'left' | 'right' }> = {
  A: { label: 'Track A', color: '#00ff00', side: 'left' },
  B: { label: 'Track B', color: '#ff5030', side: 'right' },
};

const LEGACY_TRACK_COLORS: Record<RecordedTrackId, string[]> = {
  A: [],
  B: ['#ff0000', '#ff8060'],
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeKeyframes(raw: unknown, fps: number): Keyframe[] {
  if (!Array.isArray(raw)) return [];

  const parsed: Keyframe[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<Keyframe>;
    if (!isFiniteNumber(candidate.time) || !isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.y)) {
      continue;
    }
    parsed.push({
      time: Math.max(0, candidate.time),
      x: clamp01(candidate.x),
      y: clamp01(candidate.y),
    });
  }

  parsed.sort((a, b) => a.time - b.time);

  // At most one keyframe per frame index.
  const byFrame = new Map<number, Keyframe>();
  for (const kf of parsed) {
    const frame = Math.round(kf.time * fps);
    byFrame.set(frame, kf);
  }

  return [...byFrame.values()].sort((a, b) => a.time - b.time);
}

function normalizeTrack(raw: unknown, id: RecordedTrackId, fps: number): RecordedTrack {
  const meta = TRACK_META[id];
  const candidate = raw && typeof raw === 'object' ? (raw as Partial<RecordedTrack>) : null;
  const rawColor = typeof candidate?.color === 'string' ? candidate.color.trim() : '';
  const normalizedColor = rawColor.toLowerCase();
  const color = !rawColor
    ? meta.color
    : LEGACY_TRACK_COLORS[id].includes(normalizedColor)
      ? meta.color
      : rawColor;

  return {
    id,
    label: typeof candidate?.label === 'string' && candidate.label.trim() ? candidate.label : meta.label,
    color,
    keyframes: normalizeKeyframes(candidate?.keyframes, fps),
  };
}

function trackById(tracks: unknown, id: RecordedTrackId): unknown {
  if (!Array.isArray(tracks)) return null;
  return tracks.find((t) => t && typeof t === 'object' && (t as { id?: string }).id === id) ?? null;
}

export function createEmptyTrackSet(
  videoId: string,
  videoUrl: string,
  fps = DEFAULT_RECORDED_FPS,
  maxGapSeconds = DEFAULT_MAX_GAP_SECONDS
): RecordedTrackSet {
  const now = Date.now();
  return {
    version: 1,
    videoId,
    videoUrl,
    fps,
    maxGapSeconds,
    createdAt: now,
    updatedAt: now,
    tracks: [
      { id: 'A', label: TRACK_META.A.label, color: TRACK_META.A.color, keyframes: [] },
      { id: 'B', label: TRACK_META.B.label, color: TRACK_META.B.color, keyframes: [] },
    ],
  };
}

export function normalizeTrackSet(
  raw: unknown,
  expectedVideoId: string,
  fallbackUrl: string,
  fallbackFps = DEFAULT_RECORDED_FPS
): RecordedTrackSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<RecordedTrackSet>;
  if (candidate.version !== 1) return null;

  const fps = isFiniteNumber(candidate.fps) && candidate.fps > 0 ? candidate.fps : fallbackFps;
  const maxGapSeconds =
    isFiniteNumber(candidate.maxGapSeconds) && candidate.maxGapSeconds > 0
      ? candidate.maxGapSeconds
      : DEFAULT_MAX_GAP_SECONDS;
  const createdAt = isFiniteNumber(candidate.createdAt) ? candidate.createdAt : Date.now();
  const updatedAt = isFiniteNumber(candidate.updatedAt) ? candidate.updatedAt : Date.now();

  return {
    version: 1,
    videoId: expectedVideoId,
    videoUrl: typeof candidate.videoUrl === 'string' && candidate.videoUrl.trim() ? candidate.videoUrl : fallbackUrl,
    fps,
    maxGapSeconds,
    createdAt,
    updatedAt,
    tracks: [
      normalizeTrack(trackById(candidate.tracks, 'A'), 'A', fps),
      normalizeTrack(trackById(candidate.tracks, 'B'), 'B', fps),
    ],
  };
}

export function importTrackSetFromJson(
  jsonText: string,
  expectedVideoId: string,
  fallbackUrl: string,
  fallbackFps = DEFAULT_RECORDED_FPS
): RecordedTrackSet | null {
  try {
    const parsed = JSON.parse(jsonText);
    return normalizeTrackSet(parsed, expectedVideoId, fallbackUrl, fallbackFps);
  } catch {
    return null;
  }
}

export function exportTrackSetToJson(set: RecordedTrackSet): string {
  return JSON.stringify(set, null, 2);
}

export function keyframeCount(set: RecordedTrackSet): number {
  return set.tracks.reduce((sum, track) => sum + track.keyframes.length, 0);
}

export function trackSetToSummary(set: RecordedTrackSet): RecordedTrackSetSummary {
  return {
    videoId: set.videoId,
    videoUrl: set.videoUrl,
    updatedAt: set.updatedAt,
    keyframeCount: keyframeCount(set),
  };
}
