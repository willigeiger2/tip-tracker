// App startup. Component scripts wire their own markup when they run; startApp() waits until all
// of them have run (DOMContentLoaded fires after deferred/module scripts) and then starts the
// detector and the initial source.

import { addAfterRenderHook, appState, detector, events, mapToCanvas, video } from './app';
import { captureSamples } from './auto-seed';
import { captureTrace } from './fencers-trace';
import {
  drawFencersDebugOverlay,
  drawHitMarkers,
  drawRecordedEditorOverlay,
  isFencersDebugOverlayEnabled,
} from './overlays';
import { drawRecordedHits } from './hit-effects';
import { getTrackSet, isEditorActive } from './recorded';
import { applySourcePresentation, installStageSizing, startInitialSource } from './sources';

let started = false;

async function start(): Promise<void> {
  if (started) return;
  started = true;

  // After-render passes, in order: capture, then debug and editor overlays.
  addAfterRenderHook((_context, frame) => captureSamples(frame));
  addAfterRenderHook((_context, frame) => captureTrace(frame));
  addAfterRenderHook((context, frame) => {
    if (isFencersDebugOverlayEnabled() && appState.get().trackingMode === 'fencers') {
      drawFencersDebugOverlay(context.overlay, frame);
    }
  });
  addAfterRenderHook((context) => {
    if (!isEditorActive()) return;
    context.trailRenderer.clear();
    drawRecordedEditorOverlay(context.overlay);
  });
  // Hit effects (recorded mode). While editing, they play only during playback so a paused
  // frame stays clean for placing keyframes; a marker shows hits on the current frame instead.
  addAfterRenderHook((context) => {
    const set = getTrackSet();
    if (appState.get().trackingMode !== 'recorded' || !set) return;
    const editing = isEditorActive();
    if (editing && video.paused) {
      drawHitMarkers(context.overlay);
      return;
    }
    const ctx = context.overlay.getContext('2d');
    if (ctx) drawRecordedHits(ctx, set, video.currentTime, mapToCanvas);
  });

  applySourcePresentation();
  events.emit('recorded');
  events.emit('auto-seed');
  installStageSizing();

  await detector.load(appState.get().trackingMode);
  await startInitialSource();
}

export function startApp(): void {
  if (document.readyState === 'complete') {
    void start();
    return;
  }
  document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
  window.addEventListener('load', () => void start(), { once: true });
}
