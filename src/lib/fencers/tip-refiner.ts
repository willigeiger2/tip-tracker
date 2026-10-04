import type { Landmark, TipRefinementDebug } from '../../types/fencing';

export interface VideoFramePixels {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

const MAX_FRAME_WIDTH = 640;

let frameCanvas: HTMLCanvasElement | null = null;
let frameCtx: CanvasRenderingContext2D | null = null;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ensureFrameContext(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') {
    return null;
  }
  if (!frameCanvas || !frameCtx) {
    frameCanvas = document.createElement('canvas');
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!frameCtx || !frameCanvas) return null;
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  return frameCtx;
}

export function captureVideoFramePixels(video: HTMLVideoElement): VideoFramePixels | null {
  const srcWidth = video.videoWidth;
  const srcHeight = video.videoHeight;
  if (!Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) || srcWidth <= 0 || srcHeight <= 0) {
    return null;
  }

  const scale = Math.min(1, MAX_FRAME_WIDTH / srcWidth);
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));
  const ctx = ensureFrameContext(width, height);
  if (!ctx) return null;

  try {
    ctx.drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return {
      width,
      height,
      rgba: image.data,
    };
  } catch {
    return null;
  }
}

function sampleLuma(frame: VideoFramePixels, px: number, py: number): number {
  const x = Math.max(0, Math.min(frame.width - 1, Math.round(px)));
  const y = Math.max(0, Math.min(frame.height - 1, Math.round(py)));
  const i = (y * frame.width + x) * 4;
  const r = frame.rgba[i];
  const g = frame.rgba[i + 1];
  const b = frame.rgba[i + 2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type Direction2D = { x: number; y: number };

interface RayPointScore {
  point: { x: number; y: number };
  length: number;
  t: number;
  signal: number;
}

interface FanRayResult {
  angleDeg: number;
  dir: Direction2D;
  score: number;
  continuity: number;
  points: RayPointScore[];
  bestPoint: RayPointScore;
  end: { x: number; y: number };
}

const FAN_HALF_ANGLE_DEG = 30;
const FAN_STEP_DEG = 3;
const FAN_SAMPLES = 32;

function normalizeDirection(dx: number, dy: number): Direction2D | null {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: dx / len, y: dy / len };
}

function rotateDirection(dir: Direction2D, angleDeg: number): Direction2D {
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 1e-6) return dir;
  const r = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    x: dir.x * cos - dir.y * sin,
    y: dir.x * sin + dir.y * cos,
  };
}

function lineSignalAt(frame: VideoFramePixels, nx: number, ny: number, dir: Direction2D): number {
  const x = nx * frame.width;
  const y = ny * frame.height;
  const normalX = -dir.y;
  const normalY = dir.x;

  // Average center brightness over a tiny segment along the ray to improve faint-line SNR.
  const centerA = sampleLuma(frame, x + dir.x * 1.1, y + dir.y * 1.1);
  const centerB = sampleLuma(frame, x, y);
  const centerC = sampleLuma(frame, x - dir.x * 1.1, y - dir.y * 1.1);
  const center = (centerA + centerB + centerC) / 3;

  const sideOffsets = [1.6, 3.0, 4.4];
  const sideWeights = [0.5, 0.34, 0.16];

  let brightContrast = 0;
  let edgeContrast = 0;
  let sideDiff = 0;

  for (let i = 0; i < sideOffsets.length; i++) {
    const sidePx = sideOffsets[i];
    const w = sideWeights[i];
    const sideA = sampleLuma(frame, x + normalX * sidePx, y + normalY * sidePx);
    const sideB = sampleLuma(frame, x - normalX * sidePx, y - normalY * sidePx);
    const sideAvg = (sideA + sideB) / 2;
    brightContrast += Math.max(0, center - sideAvg) * w;
    edgeContrast += (Math.abs(center - sideA) + Math.abs(center - sideB)) * w;
    sideDiff += Math.abs(sideA - sideB) * w;
  }

  return brightContrast * 0.74 + edgeContrast * 0.2 + sideDiff * 0.06;
}

function tipBlobScoreAt(frame: VideoFramePixels, nx: number, ny: number): number {
  const x = nx * frame.width;
  const y = ny * frame.height;
  const center = sampleLuma(frame, x, y);
  const r = 2.6;
  const around =
    sampleLuma(frame, x + r, y) +
    sampleLuma(frame, x - r, y) +
    sampleLuma(frame, x, y + r) +
    sampleLuma(frame, x, y - r);
  const avgAround = around / 4;
  return center - avgAround;
}

function scoreFanRay(
  frame: VideoFramePixels,
  wrist: { x: number; y: number },
  dir: Direction2D,
  angleDeg: number,
  minLen: number,
  maxLen: number
): FanRayResult {
  const points: RayPointScore[] = [];
  let weightedSum = 0;
  let run = 0;
  let bestRun = 0;
  let bestPoint: RayPointScore | null = null;

  for (let i = 0; i < FAN_SAMPLES; i++) {
    const t = i / (FAN_SAMPLES - 1);
    const length = minLen + (maxLen - minLen) * t;
    const point = {
      x: clamp01(wrist.x + dir.x * length),
      y: clamp01(wrist.y + dir.y * length),
    };

    const signal = lineSignalAt(frame, point.x, point.y, dir);
    const scored = Math.max(0, signal - 6);
    const distalBias = 0.55 + 0.9 * t;
    weightedSum += scored * distalBias;

    if (signal > 10) {
      run += 1;
      bestRun = Math.max(bestRun, run);
    } else {
      run = 0;
    }

    const sample: RayPointScore = { point, length, t, signal };
    points.push(sample);
    if (!bestPoint || signal > bestPoint.signal) {
      bestPoint = sample;
    }
  }

  const continuity = bestRun / FAN_SAMPLES;
  const continuityBoost = 0.5 + continuity * 1.25;
  const score = weightedSum * continuityBoost;

  return {
    angleDeg,
    dir,
    score,
    continuity,
    points,
    bestPoint: bestPoint ?? {
      point: { x: clamp01(wrist.x + dir.x * minLen), y: clamp01(wrist.y + dir.y * minLen) },
      length: minLen,
      t: 0,
      signal: 0,
    },
    end: {
      x: clamp01(wrist.x + dir.x * maxLen),
      y: clamp01(wrist.y + dir.y * maxLen),
    },
  };
}

function endpointFromBestRay(frame: VideoFramePixels, ray: FanRayResult): { point: { x: number; y: number }; score: number } {
  const peak = ray.bestPoint.signal;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPoint = ray.bestPoint.point;
  const startIndex = Math.floor(ray.points.length * 0.55);

  for (let i = startIndex; i < ray.points.length; i++) {
    const sample = ray.points[i];
    if (sample.signal < peak * 0.23) continue;
    const blob = Math.max(0, tipBlobScoreAt(frame, sample.point.x, sample.point.y));
    const distalBonus = sample.t * 18;
    const score = sample.signal * 0.72 + blob * 0.58 + distalBonus;
    if (score > bestScore) {
      bestScore = score;
      bestPoint = sample.point;
    }
  }

  if (!Number.isFinite(bestScore)) {
    bestScore = ray.bestPoint.signal;
    bestPoint = ray.bestPoint.point;
  }

  return { point: bestPoint, score: bestScore };
}

export function refineTipFromFrame(
  frame: VideoFramePixels,
  prior: { x: number; y: number },
  wrist: Landmark,
  elbow: Landmark,
  seedDirection?: { x: number; y: number }
): TipRefinementDebug {
  const base: TipRefinementDebug = {
    wrist: { x: clamp01(wrist.x), y: clamp01(wrist.y) },
    prior: { x: clamp01(prior.x), y: clamp01(prior.y) },
    refined: { x: clamp01(prior.x), y: clamp01(prior.y) },
    searchStart: { x: clamp01(prior.x), y: clamp01(prior.y) },
    searchEnd: { x: clamp01(prior.x), y: clamp01(prior.y) },
    confidence: 0,
    edgeScore: 0,
    usedRefined: false,
  };

  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  const forearm = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(forearm) || forearm < 1e-4) return base;

  let seedDir = normalizeDirection(dx, dy);
  if (!seedDir) return base;

  if (seedDirection && Number.isFinite(seedDirection.x) && Number.isFinite(seedDirection.y)) {
    seedDir = normalizeDirection(seedDirection.x, seedDirection.y) ?? seedDir;
  }

  const priorDir = normalizeDirection(prior.x - wrist.x, prior.y - wrist.y) ?? seedDir;
  const priorLen = Math.sqrt((prior.x - wrist.x) * (prior.x - wrist.x) + (prior.y - wrist.y) * (prior.y - wrist.y));
  const minLen = Math.max(0.03, forearm * 0.45);
  const maxLen = Math.max(minLen + 0.02, Math.min(0.95, Math.max(priorLen * 1.25, forearm * 2.2)));

  const rays: FanRayResult[] = [];
  for (let angle = -FAN_HALF_ANGLE_DEG; angle <= FAN_HALF_ANGLE_DEG + 1e-6; angle += FAN_STEP_DEG) {
    const dir = rotateDirection(priorDir, angle);
    rays.push(scoreFanRay(frame, wrist, dir, angle, minLen, maxLen));
  }

  rays.sort((a, b) => b.score - a.score);
  const bestRay = rays[0];
  if (!bestRay) return base;
  const secondRay = rays[1] ?? bestRay;

  const endpoint = endpointFromBestRay(frame, bestRay);
  const margin = bestRay.score > 1e-6 ? (bestRay.score - secondRay.score) / bestRay.score : 0;
  const lineStrength = clamp01((bestRay.score - 70) / 170);
  const endpointStrength = clamp01((endpoint.score - 10) / 28);
  const continuityStrength = clamp01(bestRay.continuity * 1.7);
  const marginStrength = clamp01(margin * 2.6);
  const angleConfidence = clamp01(lineStrength * 0.5 + continuityStrength * 0.25 + marginStrength * 0.25);
  const endpointConfidence = clamp01(endpointStrength * 0.7 + lineStrength * 0.2 + marginStrength * 0.1);
  const confidence = clamp01(
    lineStrength * 0.31 + endpointStrength * 0.31 + continuityStrength * 0.2 + marginStrength * 0.18
  );
  const usedRefined = confidence > 0.14;
  const blendAlpha = usedRefined ? 0.2 + 0.72 * confidence : 0;

  const refinedX = clamp01(base.prior.x * (1 - blendAlpha) + endpoint.point.x * blendAlpha);
  const refinedY = clamp01(base.prior.y * (1 - blendAlpha) + endpoint.point.y * blendAlpha);

  base.searchStart = {
    x: clamp01(wrist.x + bestRay.dir.x * minLen),
    y: clamp01(wrist.y + bestRay.dir.y * minLen),
  };
  base.searchEnd = {
    x: clamp01(wrist.x + bestRay.dir.x * maxLen),
    y: clamp01(wrist.y + bestRay.dir.y * maxLen),
  };

  return {
    ...base,
    refined: { x: refinedX, y: refinedY },
    confidence,
    edgeScore: Math.max(0, bestRay.score),
    fan: rays.map((ray) => ({
      angleDeg: ray.angleDeg,
      score: Math.max(0, ray.score),
      end: ray.end,
    })),
    bestFanAngleDeg: bestRay.angleDeg,
    secondFanAngleDeg: secondRay.angleDeg,
    bestRayScore: Math.max(0, bestRay.score),
    secondRayScore: Math.max(0, secondRay.score),
    fanMargin: clamp01(margin),
    bestDirection: bestRay.dir,
    angleConfidence,
    endpointConfidence,
    bestLinePoint: bestRay.bestPoint.point,
    endpoint: endpoint.point,
    endpointScore: Math.max(0, endpoint.score),
    usedRefined,
  };
}
