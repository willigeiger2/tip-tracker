import type { DetectionResult, Fencer, TrailPoint, TipPosition } from '../../types/fencing';
import { sampleTrackAt, sampleTrackTrail } from './interpolator';
import type { RecordedTrack, RecordedTrackId, RecordedTrackSet } from './types';

export interface RecordedFrameSnapshot {
  fencers: Map<string, Fencer>;
  detections: DetectionResult[];
}

const TRACK_META: Record<RecordedTrackId, { side: 'left' | 'right'; color: string }> = {
  A: { side: 'left', color: '#00ff00' },
  B: { side: 'right', color: '#ff0000' },
};

function toTipPosition(id: RecordedTrackId, point: { x: number; y: number }, timestamp: number): TipPosition {
  return {
    x: point.x,
    y: point.y,
    z: 0,
    confidence: 1,
    timestamp,
    side: TRACK_META[id].side,
  };
}

function toTrailPoints(points: Array<{ time: number; x: number; y: number }>): TrailPoint[] {
  if (points.length === 0) return [];

  return points.map((p, i) => {
    let velocity = 0;
    if (i > 0) {
      const prev = points[i - 1];
      const dt = p.time - prev.time;
      if (dt > 0) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        velocity = Math.sqrt(dx * dx + dy * dy) / dt;
      }
    }

    return {
      x: p.x,
      y: p.y,
      z: 0,
      timestamp: p.time,
      velocity,
      // Keep per-point opacity flat in recorded mode; age fading is handled in the renderer.
      opacity: 1,
    };
  });
}

function trackById(set: RecordedTrackSet, id: RecordedTrackId): RecordedTrack | null {
  return set.tracks.find((track) => track.id === id) ?? null;
}

export function buildRecordedFrameSnapshot(
  set: RecordedTrackSet,
  mediaTime: number,
  timestamp: number,
  trailSamples: number,
  trailWindowSeconds = 1.0
): RecordedFrameSnapshot {
  const fencers = new Map<string, Fencer>();
  const detections: DetectionResult[] = [];

  (['A', 'B'] as const).forEach((id) => {
    const meta = TRACK_META[id];
    const track = trackById(set, id) ?? { id, label: `Track ${id}`, color: meta.color, keyframes: [] };

    const tipPoint = sampleTrackAt(track, mediaTime, {
      maxGapSeconds: set.maxGapSeconds,
      fps: set.fps,
    });

    const trailPoints = sampleTrackTrail(
      track,
      mediaTime,
      trailWindowSeconds,
      trailSamples,
      {
        maxGapSeconds: set.maxGapSeconds,
        fps: set.fps,
      }
    );

    const tip = tipPoint ? toTipPosition(id, tipPoint, timestamp) : null;
    const trail = toTrailPoints(trailPoints);

    const fencer: Fencer = {
      id,
      side: meta.side,
      color: track.color || meta.color,
      tip,
      trail,
    };
    fencers.set(id, fencer);

    if (tip) {
      detections.push({
        id,
        side: meta.side,
        tip,
        landmarks: [],
      });
    }
  });

  return { fencers, detections };
}
