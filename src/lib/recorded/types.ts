export interface Keyframe {
  time: number;
  x: number;
  y: number;
}

export type RecordedTrackId = 'A' | 'B';

/** A scoring touch, set by hand on a frame. `trackId` is the fencer who scored. */
export interface Hit {
  time: number;
  trackId: RecordedTrackId;
}

export interface RecordedTrack {
  id: RecordedTrackId;
  label: string;
  color: string;
  keyframes: Keyframe[];
}

export interface RecordedTrackSet {
  version: 1;
  videoId: string;
  videoUrl: string;
  fps: number;
  maxGapSeconds: number;
  createdAt: number;
  updatedAt: number;
  tracks: RecordedTrack[];
  /** Scoring touches, sorted by time. Optional so older saved sets stay valid. */
  hits?: Hit[];
}

export interface RecordedTrackSetSummary {
  videoId: string;
  videoUrl: string;
  updatedAt: number;
  keyframeCount: number;
}

export const DEFAULT_RECORDED_FPS = 30;
export const DEFAULT_MAX_GAP_SECONDS = 1.0;
