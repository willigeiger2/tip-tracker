// Frame-rate helpers for transport and frame stepping.

export const DEFAULT_FRAME_RATE = 30;
export const FPS_STORAGE_PREFIX = 'tiptrack:v1:fps:';

export interface DetectedFrameRate {
  fps: number;
  approximate: boolean;
  source: 'manifest' | 'measured' | 'default';
}

/** Parse every FRAME-RATE value from an HLS master manifest body. */
export function parseManifestFrameRates(manifestText: string): number[] {
  const rates: number[] = [];
  const re = /\bFRAME-RATE=([0-9]+(?:\.[0-9]+)?)/gi;
  let m: RegExpExecArray | null = re.exec(manifestText);
  while (m) {
    const value = Number.parseFloat(m[1]);
    if (Number.isFinite(value) && value > 0) rates.push(value);
    m = re.exec(manifestText);
  }
  return rates;
}

/** Choose a usable fps from parsed HLS variants (highest non-zero value). */
export function chooseManifestFrameRate(rates: number[]): number | null {
  if (rates.length === 0) return null;
  return Math.max(...rates);
}

export async function fetchManifestFrameRate(url: string): Promise<number | null> {
  if (!url.toLowerCase().includes('.m3u8')) return null;

  try {
    const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
    if (!response.ok) return null;
    const text = await response.text();
    return chooseManifestFrameRate(parseManifestFrameRates(text));
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[half - 1] + sorted[half]) / 2 : sorted[half];
}

/**
 * Measure frame-rate from requestVideoFrameCallback media-time deltas.
 * Returns null when unsupported, unavailable, or insufficiently stable.
 */
export async function measureVideoFrameRate(
  video: HTMLVideoElement,
  sampleCount = 12,
  timeoutMs = 3000
): Promise<number | null> {
  const withRvfc = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (
      callback: (now: number, metadata: { mediaTime: number }) => void
    ) => number;
    cancelVideoFrameCallback?: (id: number) => void;
  };

  if (typeof withRvfc.requestVideoFrameCallback !== 'function') return null;
  if (video.paused) return null;

  return new Promise<number | null>((resolve) => {
    const deltas: number[] = [];
    let previousMediaTime: number | null = null;
    let callbackId: number | null = null;

    const finish = (value: number | null) => {
      if (callbackId !== null && typeof withRvfc.cancelVideoFrameCallback === 'function') {
        withRvfc.cancelVideoFrameCallback(callbackId);
      }
      clearTimeout(timeoutId);
      resolve(value);
    };

    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (previousMediaTime !== null) {
        const dt = metadata.mediaTime - previousMediaTime;
        if (dt > 0 && dt <= 0.25) {
          deltas.push(dt);
        }
      }

      previousMediaTime = metadata.mediaTime;

      if (deltas.length >= sampleCount) {
        const med = median(deltas);
        if (med > 0) {
          finish(1 / med);
        } else {
          finish(null);
        }
        return;
      }

      callbackId = withRvfc.requestVideoFrameCallback?.(onFrame) ?? null;
    };

    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);
    callbackId = withRvfc.requestVideoFrameCallback(onFrame);
  });
}

export async function detectVideoFrameRate(
  video: HTMLVideoElement,
  url: string
): Promise<DetectedFrameRate> {
  const fromManifest = await fetchManifestFrameRate(url);
  if (fromManifest && fromManifest > 0) {
    return { fps: fromManifest, approximate: false, source: 'manifest' };
  }

  const measured = await measureVideoFrameRate(video);
  if (measured && measured > 0) {
    return { fps: measured, approximate: false, source: 'measured' };
  }

  return { fps: DEFAULT_FRAME_RATE, approximate: true, source: 'default' };
}

/** The displayed frame index for media time `t` at `fps`. */
export function frameIndex(timeSeconds: number, fps: number): number {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(fps) || fps <= 0) return 0;
  // Use floor so seeking to frame centers ((f + 0.5) / fps) maps back to f.
  return Math.max(0, Math.floor(timeSeconds * fps + 1e-6));
}

/** Seek target for frame `f` (center of frame interval), clamped to the media duration. */
export function seekTimeForFrame(frame: number, fps: number, duration: number): number {
  const t = (frame + 0.5) / fps;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, t);
  return Math.min(Math.max(0, t), duration);
}

export function fpsStorageKey(videoId: string): string {
  return `${FPS_STORAGE_PREFIX}${videoId}`;
}

export function loadFpsOverride(videoId: string): number | null {
  const raw = localStorage.getItem(fpsStorageKey(videoId));
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function saveFpsOverride(videoId: string, fps: number): void {
  localStorage.setItem(fpsStorageKey(videoId), fps.toString());
}
