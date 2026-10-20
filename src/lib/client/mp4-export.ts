// Frame-accurate MP4 export of recorded playback: the video frame plus trails, tips and hit
// effects, at the video's native resolution and reported fps. No UI is ever in the output.
//
// Recorded mode is a pure function of media time, so each output frame is produced by seeking
// a hidden <video> (loaded at the highest HLS rendition, independent of the on-screen player)
// to the frame center, then rendering a fresh overlay for that time. The overlay is laid out in
// the on-screen video's coordinate space and scaled up, so line widths and glow match what you
// see while playing. Slower than real time (~150ms per native seek) but never drops frames.
//
// The encoder library (mediabunny) is loaded on first export so it adds nothing to page load.

import { frameIndex, seekTimeForFrame } from '../app/frame-rate';
import { getVideoMapping, getViewportSize } from '../app/coordinate-mapper';
import { bestHlsVariant, parseHlsVariants } from '../app/hls-variants';
import { renderFrame, type RenderContext } from '../app/render-modes';
import { isHlsUrl } from '../app/sources/url-source';
import { DebugRenderer, TrailRenderer } from '../renderer';
import { appState, isVideoSource, session, urlSource, video } from './app';
import { drawRecordedHits } from './hit-effects';
import { getTrackSet, recordedSnapshotAt } from './recorded';

export interface ExportProgress {
  done: number;
  total: number;
}

export interface ExportResult {
  blob: Blob;
  frames: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
}

const LOAD_TIMEOUT_MS = 30000;
const SEEK_TIMEOUT_MS = 10000;
const FRAME_PRESENT_TIMEOUT_MS = 250;

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function waitForEvent(target: EventTarget, name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      target.removeEventListener(name, onEvent);
      reject(new Error(`Timed out waiting for video ${name}`));
    }, timeoutMs);
    target.addEventListener(name, onEvent, { once: true });
  });
}

/** Resolves once the element presents its next frame (rVFC), or after a short fallback. */
function waitForPresentedFrame(el: HTMLVideoElement): Promise<void> {
  const rvfc = (el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
    .requestVideoFrameCallback;
  if (typeof rvfc !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, FRAME_PRESENT_TIMEOUT_MS);
    rvfc.call(el, () => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

async function seekExactly(el: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(el.currentTime - time) < 1e-6 && el.readyState >= 2) return;
  const seeked = waitForEvent(el, 'seeked', SEEK_TIMEOUT_MS);
  const presented = waitForPresentedFrame(el);
  el.currentTime = time;
  await seeked;
  await presented;
}

/** The highest-resolution rendition for HLS master manifests; other URLs are used as-is. */
async function resolveExportUrl(url: string): Promise<string> {
  if (!isHlsUrl(url)) return url;
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return url;
    return bestHlsVariant(parseHlsVariants(await response.text(), response.url || url))?.uri ?? url;
  } catch {
    return url;
  }
}

/** A hidden, muted video element for decoding export frames. Caller removes it. */
async function createExportVideo(url: string): Promise<HTMLVideoElement> {
  const el = document.createElement('video');
  el.crossOrigin = 'anonymous';
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  // In the document (so frames are decoded and presented) but invisible and tiny.
  el.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(el);
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Timed out loading video for export')), LOAD_TIMEOUT_MS);
    el.addEventListener('loadeddata', () => (window.clearTimeout(timer), resolve()), { once: true });
    el.addEventListener('error', () => (window.clearTimeout(timer), reject(new Error('Could not load video for export'))), {
      once: true,
    });
  });
  el.src = await resolveExportUrl(url);
  el.load();
  try {
    await loaded;
  } catch (error) {
    el.remove();
    throw error;
  }
  return el;
}

/** Parse "m:ss.s", "ss.s" or "h:mm:ss" into seconds; null when invalid. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => p.trim() === '')) return null;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

export async function exportRecordedMp4(
  startTime: number,
  endTime: number,
  onProgress: (progress: ExportProgress) => void,
  signal: AbortSignal
): Promise<ExportResult> {
  const set = getTrackSet();
  const playbackUrl = urlSource.getUrl();
  if (!isVideoSource() || !set || !playbackUrl) throw new Error('Load a video with recorded tracks first.');
  if (!video.videoWidth || !video.videoHeight) throw new Error('Video is not ready yet.');

  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, getFirstEncodableVideoCodec } =
    await import('mediabunny');

  const fps = session.transportFps;
  const state = appState.get();

  // Overlay layout space: the video as currently displayed on screen (same aspect as the source).
  const onScreen = getVideoMapping(
    getViewportSize(),
    { width: video.videoWidth, height: video.videoHeight },
    session.activeSource.fit
  );
  const logicalWidth = Math.max(1, onScreen.videoDisplayWidth);
  const logicalHeight = Math.max(1, onScreen.videoDisplayHeight);
  const mapLogical = (nx: number, ny: number) => ({ x: nx * logicalWidth, y: ny * logicalHeight });

  const playerWasPaused = video.paused;
  video.pause();
  const source = await createExportVideo(playbackUrl);

  try {
    const duration = Number.isFinite(source.duration) ? source.duration : video.duration;
    const lastFrame = Math.max(0, frameIndex(duration, fps) - 1);
    const startFrame = Math.min(frameIndex(Math.max(0, Math.min(startTime, endTime)), fps), lastFrame);
    const endFrame = Math.min(frameIndex(Math.max(startTime, endTime), fps), lastFrame);
    const total = endFrame - startFrame + 1;

    const width = even(source.videoWidth);
    const height = even(source.videoHeight);
    const scaleX = width / logicalWidth;
    const scaleY = height / logicalHeight;

    const overlay = document.createElement('canvas');
    const composite = document.createElement('canvas');
    overlay.width = composite.width = width;
    overlay.height = composite.height = height;
    const overlayCtx = overlay.getContext('2d');
    const compositeCtx = composite.getContext('2d');
    if (!overlayCtx || !compositeCtx) throw new Error('Canvas 2D is unavailable.');

    const trailRenderer = new TrailRenderer(overlay);
    trailRenderer.setCoordinateMapper(mapLogical);
    trailRenderer.setGlowIntensity(state.glowIntensity);
    trailRenderer.setEffectMode(state.effectMode);
    const debugRenderer = new DebugRenderer(overlay);
    debugRenderer.setCoordinateMapper(mapLogical);
    const context: RenderContext = { overlay, trailRenderer, debugRenderer, mapToCanvas: mapLogical };

    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height });
    if (!codec) throw new Error('This browser cannot encode video (WebCodecs unavailable).');

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const canvasSource = new CanvasSource(composite, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
    output.addVideoTrack(canvasSource, { frameRate: fps });
    await output.start();

    try {
      for (let i = 0; i < total; i++) {
        if (signal.aborted) throw new DOMException('Export canceled', 'AbortError');
        const t = seekTimeForFrame(startFrame + i, fps, duration);
        await seekExactly(source, t);

        overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
        overlayCtx.clearRect(0, 0, width, height);
        overlayCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        const snapshot = recordedSnapshotAt(t, performance.now(), state.trailLength);
        if (snapshot) {
          renderFrame(context, {
            trackingMode: 'recorded',
            debugMode: state.debugMode,
            fencers: snapshot.fencers,
            detections: snapshot.detections,
          });
        }
        drawRecordedHits(overlayCtx, set, t, mapLogical);
        overlayCtx.setTransform(1, 0, 0, 1, 0, 0);

        compositeCtx.drawImage(source, 0, 0, width, height);
        compositeCtx.drawImage(overlay, 0, 0);
        await canvasSource.add(i / fps, 1 / fps);
        onProgress({ done: i + 1, total });
      }
      await output.finalize();
    } catch (error) {
      if (output.state !== 'finalized') await output.cancel().catch(() => {});
      throw error;
    }

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Encoder produced no output.');
    return { blob: new Blob([buffer], { type: 'video/mp4' }), frames: total, width, height, fps, codec };
  } finally {
    source.removeAttribute('src');
    source.load();
    source.remove();
    if (!playerWasPaused) void video.play().catch(() => {});
  }
}
