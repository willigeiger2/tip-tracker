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

function edgeScoreAt(
  frame: VideoFramePixels,
  nx: number,
  ny: number,
  normalX: number,
  normalY: number,
  halfWidthPx = 3
): number {
  const x = nx * frame.width;
  const y = ny * frame.height;
  let score = 0;
  for (let k = 1; k <= halfWidthPx; k++) {
    const l1 = sampleLuma(frame, x + normalX * k, y + normalY * k);
    const l2 = sampleLuma(frame, x - normalX * k, y - normalY * k);
    score += Math.abs(l1 - l2);
  }
  return score;
}

export function refineTipFromFrame(
  frame: VideoFramePixels,
  prior: { x: number; y: number },
  wrist: Landmark,
  elbow: Landmark,
  seedDirection?: { x: number; y: number }
): TipRefinementDebug {
  const base: TipRefinementDebug = {
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

  let dirX = dx / forearm;
  let dirY = dy / forearm;
  if (seedDirection && Number.isFinite(seedDirection.x) && Number.isFinite(seedDirection.y)) {
    const seedLen = Math.sqrt(seedDirection.x * seedDirection.x + seedDirection.y * seedDirection.y);
    if (seedLen > 1e-4) {
      dirX = seedDirection.x / seedLen;
      dirY = seedDirection.y / seedLen;
    }
  }
  const normalX = -dirY;
  const normalY = dirX;

  const searchStart = {
    x: clamp01(wrist.x + dirX * forearm * 0.2),
    y: clamp01(wrist.y + dirY * forearm * 0.2),
  };
  const searchEnd = {
    x: clamp01(prior.x + dirX * forearm * 0.8),
    y: clamp01(prior.y + dirY * forearm * 0.8),
  };

  base.searchStart = searchStart;
  base.searchEnd = searchEnd;

  const samples = 30;
  let bestScore = -1;
  let best = { x: prior.x, y: prior.y };

  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const x = searchStart.x + (searchEnd.x - searchStart.x) * t;
    const y = searchStart.y + (searchEnd.y - searchStart.y) * t;

    const edge = edgeScoreAt(frame, x, y, normalX * frame.width, normalY * frame.height, 2);
    const positionBias = 0.6 + 0.9 * t;
    const score = edge * positionBias;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }

  const confidence = clamp01((bestScore - 22) / 70);
  const usedRefined = confidence > 0.2;
  const alpha = usedRefined ? 0.25 + 0.55 * confidence : 0;

  const refinedX = clamp01(base.prior.x * (1 - alpha) + best.x * alpha);
  const refinedY = clamp01(base.prior.y * (1 - alpha) + best.y * alpha);

  return {
    ...base,
    refined: { x: refinedX, y: refinedY },
    confidence,
    edgeScore: Math.max(0, bestScore),
    usedRefined,
  };
}
