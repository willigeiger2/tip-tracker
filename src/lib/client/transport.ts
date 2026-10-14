// Video transport: frame rate, play/pause, frame stepping, seeking and scrub preview.

import {
  DEFAULT_FRAME_RATE,
  detectVideoFrameRate,
  frameIndex,
  loadFpsOverride,
  saveFpsOverride,
  seekTimeForFrame,
} from '../app/frame-rate';
import { deriveVideoId } from '../recorded/video-id';
import { events, isVideoSource, session, setStatus, urlSource, video } from './app';
import { setTrackSetFps } from './recorded';

let isDraggingSeek = false;
let seekDragFrame = 0;
let scrubPreviewRaf: number | null = null;
let scrubPreviewFrame = 0;

/** Frame rate used for all frame math: the video's reported fps (or the manual override). */
export function frameRate(): number {
  return session.transportFps;
}

export function seekDragState(): { dragging: boolean; frame: number } {
  return { dragging: isDraggingSeek, frame: seekDragFrame };
}

export function setTransportFps(fps: number, approximate: boolean): void {
  if (!Number.isFinite(fps) || fps <= 0) return;
  session.transportFps = fps;
  session.transportFpsApproximate = approximate;
  if (!approximate) setTrackSetFps(fps);
  events.emit('transport');
}

export async function detectTransportFps(url: string): Promise<void> {
  if (!isVideoSource()) return;
  const videoId = deriveVideoId(url);
  session.currentVideoId = videoId;

  const stored = loadFpsOverride(videoId);
  if (stored) {
    setTransportFps(stored, false);
    return;
  }

  setTransportFps(DEFAULT_FRAME_RATE, true);
  const detected = await detectVideoFrameRate(video, url);
  if (session.currentVideoId !== videoId) return;
  setTransportFps(detected.fps, detected.approximate);
}

/** Prompt for a manual fps override for the current video. */
export function promptFpsOverride(): void {
  if (!session.currentVideoId) return;
  const response = window.prompt('Override FPS for this video', session.transportFps.toFixed(2));
  if (response === null) return;
  const parsed = Number.parseFloat(response.trim());
  if (!Number.isFinite(parsed) || parsed <= 1 || parsed > 240) return;
  saveFpsOverride(session.currentVideoId, parsed);
  setTransportFps(parsed, false);
}

export function commitSeek(frame: number): void {
  if (!isVideoSource()) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  video.currentTime = seekTimeForFrame(frame, frameRate(), duration);
}

export function stepFrames(deltaFrames: number): void {
  if (!isVideoSource()) return;
  video.pause();
  commitSeek(frameIndex(video.currentTime, frameRate()) + deltaFrames);
}

export function seekSeconds(deltaSeconds: number): void {
  if (!isVideoSource()) return;
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(Math.max(0, video.currentTime + deltaSeconds), duration);
}

export function seekToStart(): void {
  video.currentTime = 0;
}

export function seekToEnd(): boolean {
  if (!Number.isFinite(video.duration)) return false;
  video.currentTime = Math.max(0, video.duration);
  return true;
}

// ---- Seek slider drag with throttled live preview ----

export function beginSeekDrag(): void {
  isDraggingSeek = true;
}

export function updateSeekDrag(frame: number): void {
  if (!isVideoSource()) return;
  seekDragFrame = Number.isFinite(frame) ? frame : 0;
  isDraggingSeek = true;

  scrubPreviewFrame = seekDragFrame;
  if (scrubPreviewRaf === null) {
    scrubPreviewRaf = window.requestAnimationFrame(() => {
      scrubPreviewRaf = null;
      video.pause();
      commitSeek(scrubPreviewFrame);
      events.emit('transport');
    });
  }
  events.emit('transport');
}

export function endSeekDrag(frame: number): void {
  isDraggingSeek = false;
  cancelScrubPreview();
  video.pause();
  commitSeek(Number.isFinite(frame) ? frame : 0);
  events.emit('transport');
}

export function cancelScrubPreview(): void {
  if (scrubPreviewRaf !== null) {
    window.cancelAnimationFrame(scrubPreviewRaf);
    scrubPreviewRaf = null;
  }
}

// ---- Play / pause ----

async function tryPlayVideo(): Promise<void> {
  if (!isVideoSource()) return;
  if (!(video.currentSrc || video.src)) {
    setStatus('Load a video URL first.');
    return;
  }

  if (video.ended && Number.isFinite(video.duration) && video.duration > 0) {
    video.currentTime = Math.max(0, video.duration - 1 / Math.max(1, session.transportFps));
  }

  try {
    await video.play();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorName =
      typeof err === 'object' && err !== null && 'name' in err
        ? String((err as { name?: unknown }).name ?? '')
        : '';

    if (errorName === 'NotSupportedError' && session.currentVideoUrl) {
      setStatus('Video source got stuck, reloading...');
      try {
        urlSource.setUrl(session.currentVideoUrl);
        await urlSource.attach(video);
        setStatus(video.paused ? 'Video reloaded - tap Play' : 'Video reloaded');
        return;
      } catch (reloadErr) {
        console.error('Video reload after NotSupportedError failed:', reloadErr);
      }
    }

    console.error('Video play failed:', err);
    if (message.includes('no supported sources') || message.includes('not supported')) {
      setStatus('Video cannot play this source. Reload the URL.');
    } else {
      setStatus(`Playback failed: ${message}`);
    }
  }
}

export async function togglePlay(): Promise<void> {
  if (!isVideoSource()) return;
  if (video.paused || video.ended) {
    await tryPlayVideo();
  } else {
    video.pause();
  }
  events.emit('transport');
}
