import type { Keyframe, RecordedTrack } from './types';

export interface InterpolatorOptions {
  maxGapSeconds: number;
  fps: number;
}

export interface InterpolatedPoint {
  time: number;
  x: number;
  y: number;
}

interface Run {
  startTime: number;
  endTime: number;
  keyframes: Keyframe[];
}

const EPSILON = 1e-9;

function splitIntoRuns(keyframes: Keyframe[], maxGapSeconds: number): Run[] {
  if (keyframes.length === 0) return [];

  const runs: Run[] = [];
  let start = 0;

  for (let i = 0; i < keyframes.length - 1; i++) {
    if (keyframes[i + 1].time - keyframes[i].time > maxGapSeconds) {
      const part = keyframes.slice(start, i + 1);
      runs.push({
        startTime: part[0].time,
        endTime: part[part.length - 1].time,
        keyframes: part,
      });
      start = i + 1;
    }
  }

  const finalPart = keyframes.slice(start);
  runs.push({
    startTime: finalPart[0].time,
    endTime: finalPart[finalPart.length - 1].time,
    keyframes: finalPart,
  });

  return runs;
}

function runForTime(runs: Run[], t: number): Run | null {
  for (const run of runs) {
    if (t + EPSILON >= run.startTime && t - EPSILON <= run.endTime) return run;
  }
  return null;
}

function slope(a: Keyframe, b: Keyframe): { x: number; y: number } {
  const dt = b.time - a.time;
  if (Math.abs(dt) < EPSILON) return { x: 0, y: 0 };
  return {
    x: (b.x - a.x) / dt,
    y: (b.y - a.y) / dt,
  };
}

function tangentAt(run: Keyframe[], index: number): { x: number; y: number } {
  if (run.length < 2) return { x: 0, y: 0 };

  if (index <= 0) return slope(run[0], run[1]);
  if (index >= run.length - 1) return slope(run[run.length - 2], run[run.length - 1]);

  const prev = slope(run[index - 1], run[index]);
  const next = slope(run[index], run[index + 1]);
  return {
    x: (prev.x + next.x) / 2,
    y: (prev.y + next.y) / 2,
  };
}

function hermiteSegment(p0: Keyframe, p1: Keyframe, m0: { x: number; y: number }, m1: { x: number; y: number }, t: number): InterpolatedPoint {
  const dt = p1.time - p0.time;
  if (dt <= EPSILON) {
    return { time: t, x: p0.x, y: p0.y };
  }

  const u = (t - p0.time) / dt;
  const u2 = u * u;
  const u3 = u2 * u;

  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  return {
    time: t,
    x: h00 * p0.x + h10 * dt * m0.x + h01 * p1.x + h11 * dt * m1.x,
    y: h00 * p0.y + h10 * dt * m0.y + h01 * p1.y + h11 * dt * m1.y,
  };
}

/**
 * Sample one track at media time `t`.
 * Returns null when outside runs or inside a gap larger than maxGapSeconds.
 */
export function sampleTrackAt(
  track: RecordedTrack,
  t: number,
  options: InterpolatorOptions
): InterpolatedPoint | null {
  const keyframes = track.keyframes;
  if (keyframes.length === 0) return null;

  const frameTolerance = 0.5 / Math.max(options.fps, 1);

  const runs = splitIntoRuns(keyframes, options.maxGapSeconds);
  let run = runForTime(runs, t);

  if (!run) {
    for (const candidate of runs) {
      if (candidate.keyframes.length !== 1) continue;
      const k = candidate.keyframes[0];
      if (Math.abs(t - k.time) <= frameTolerance + EPSILON) {
        run = candidate;
        break;
      }
    }
  }

  if (!run) return null;

  if (run.keyframes.length === 1) {
    const k = run.keyframes[0];
    if (Math.abs(t - k.time) <= frameTolerance + EPSILON) {
      return { time: t, x: k.x, y: k.y };
    }
    return null;
  }

  const local = run.keyframes;

  for (let i = 0; i < local.length; i++) {
    if (Math.abs(t - local[i].time) <= EPSILON) {
      return { time: t, x: local[i].x, y: local[i].y };
    }
  }

  for (let i = 0; i < local.length - 1; i++) {
    const a = local[i];
    const b = local[i + 1];
    if (t + EPSILON < a.time || t - EPSILON > b.time) continue;

    const m0 = tangentAt(local, i);
    const m1 = tangentAt(local, i + 1);
    return hermiteSegment(a, b, m0, m1, t);
  }

  return null;
}

/**
 * Build deterministic trail samples over [t-windowSeconds, t] within the same run as `t`.
 */
export function sampleTrackTrail(
  track: RecordedTrack,
  t: number,
  windowSeconds: number,
  samples: number,
  options: InterpolatorOptions
): InterpolatedPoint[] {
  if (samples <= 0) return [];

  const runs = splitIntoRuns(track.keyframes, options.maxGapSeconds);
  const run = runForTime(runs, t);
  if (!run) return [];

  const start = Math.max(run.startTime, t - Math.max(windowSeconds, 0));
  const end = t;

  if (end + EPSILON < start) return [];

  const points: InterpolatedPoint[] = [];
  const count = Math.max(1, samples);
  for (let i = 0; i < count; i++) {
    const time = count === 1 ? end : start + ((end - start) * i) / (count - 1);
    const p = sampleTrackAt(track, time, options);
    if (p) points.push(p);
  }

  return points;
}
