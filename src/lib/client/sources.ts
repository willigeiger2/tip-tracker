// Source control: camera start/stop, switching camera <-> video, loading a video URL.

import { DEFAULT_FRAME_RATE } from '../app/frame-rate';
import { installOverlaySizing } from '../app/overlay-sizing';
import { UnsupportedVideoSourceError } from '../app/sources/url-source';
import type { SourceKind } from '../app/sources/source';
import {
  appState,
  cameraSource,
  clearTrails,
  debugRenderer,
  detector,
  events,
  isVideoSource,
  mainLoop,
  overlay,
  session,
  setStatus,
  trailRenderer,
  urlSource,
  video,
} from './app';
import { resetCapture } from './auto-seed';
import { publishTraceStatus, resetTrace } from './fencers-trace';
import { refreshLibrary } from './library';
import { loadOrCreateTrackSet, publishStatus as publishRecordedStatus, resetForSourceSwitch } from './recorded';
import { cancelScrubPreview, detectTransportFps, setTransportFps } from './transport';

let refreshOverlaySizing: (() => void) | null = null;

export function installStageSizing(): void {
  refreshOverlaySizing = installOverlaySizing(video, overlay, [trailRenderer, debugRenderer]);
}

/** Re-derive everything that depends on the active source and notify the UI. */
export function applySourcePresentation(): void {
  video.controls = false;

  if (!isVideoSource() && appState.get().trackingMode === 'recorded') {
    appState.update({ trackingMode: 'hand' });
  }

  if (isVideoSource()) {
    void refreshLibrary({ silent: true });
  } else {
    events.emit('library-status', 'Switch to video source to browse saved library tracks.');
  }

  publishRecordedStatus();
  publishTraceStatus();
  events.emit('source');
}

export async function startCamera(): Promise<void> {
  if (session.activeSource.kind !== 'camera' || session.activeSource.isAttached()) return;

  try {
    await session.activeSource.attach(video);
    setStatus(detector.isReady() ? 'Running' : 'Loading model...');
    events.emit('source');
    mainLoop.start();
  } catch (err) {
    console.error('Failed to access camera:', err);
    setStatus('Camera access denied');
  }
}

function stopCamera(): void {
  if (session.activeSource.kind !== 'camera' || !session.activeSource.isAttached()) return;
  session.activeSource.detach();
  setStatus(detector.isReady() ? 'Ready' : 'Loading model...');
  events.emit('source');
}

export async function toggleCamera(): Promise<void> {
  if (session.activeSource.kind !== 'camera') return;
  if (session.activeSource.isAttached()) stopCamera();
  else await startCamera();
}

function setVideoQueryParam(url: string): void {
  const locationUrl = new URL(window.location.href);
  if (url) locationUrl.searchParams.set('video', url);
  else locationUrl.searchParams.delete('video');
  history.replaceState(null, '', locationUrl.toString());
}

export async function loadVideo(url: string): Promise<void> {
  if (!isVideoSource()) {
    await switchSource('video');
  }

  if (!url) {
    setStatus('Paste a video URL first');
    return;
  }

  urlSource.setUrl(url);
  setStatus('Loading video...');

  try {
    await urlSource.attach(video);
    setVideoQueryParam(url);
    await detectTransportFps(url);
    resetCapture();
    resetTrace('video loaded');
    await loadOrCreateTrackSet(url);
    void refreshLibrary({ silent: true });
    events.emit('source');
    if (appState.get().trackingMode === 'recorded') {
      setStatus(video.paused ? 'Recorded mode - tap Play' : 'Recorded mode');
    } else if (video.paused) {
      setStatus('Video loaded - tap Play');
    } else {
      setStatus(detector.isReady() ? 'Running' : 'Loading model...');
    }
    mainLoop.start();
  } catch (err) {
    console.error('Failed to load video URL:', err);
    setStatus(err instanceof UnsupportedVideoSourceError ? err.message : 'Failed to load video URL');
    events.emit('source');
  }
}

export async function loadVideoFromLibrary(url: string): Promise<void> {
  if (!url) return;
  events.emit('video-url', url);
  events.emit('library-status', 'Loading selected library video...');
  await loadVideo(url);

  if (isVideoSource() && session.currentVideoUrl === url) {
    appState.update({ trackingMode: 'recorded' });
    events.emit('library-status', 'Loaded from saved library entry.');
  }
}

export async function switchSource(kind: SourceKind, options: { autoLoadUrl?: string } = {}): Promise<void> {
  const autoLoadUrl = options.autoLoadUrl;
  if (session.switchingSource) return;
  if (session.activeSource.kind === kind && autoLoadUrl === undefined) return;

  session.switchingSource = true;
  try {
    if (session.activeSource.isAttached()) {
      session.activeSource.detach();
    }
    cancelScrubPreview();
    clearTrails();

    session.currentVideoId = null;
    session.currentVideoUrl = '';
    resetCapture();
    resetTrace(kind === 'camera' ? 'switched to camera' : 'switched to video mode');
    resetForSourceSwitch();

    if (kind === 'camera') {
      setTransportFps(DEFAULT_FRAME_RATE, true);
      session.activeSource = cameraSource;
      applySourcePresentation();
      refreshOverlaySizing?.();
      await startCamera();
    } else {
      session.activeSource = urlSource;
      applySourcePresentation();
      refreshOverlaySizing?.();
      setStatus('Video mode: paste URL and click Load');
      if (autoLoadUrl !== undefined) {
        await loadVideo(autoLoadUrl);
      }
    }
  } finally {
    session.switchingSource = false;
  }
}

/** Start with the ?video= URL if present, otherwise the camera. */
export async function startInitialSource(): Promise<void> {
  const initialVideoUrl = new URL(window.location.href).searchParams.get('video')?.trim() ?? '';
  if (initialVideoUrl) {
    events.emit('video-url', initialVideoUrl);
    urlSource.setUrl(initialVideoUrl);
    await switchSource('video', { autoLoadUrl: initialVideoUrl });
  } else {
    await startCamera();
  }
}
