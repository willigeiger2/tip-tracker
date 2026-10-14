// App startup. Component scripts wire their own markup when they run; startApp() waits until all
// of them have run (DOMContentLoaded fires after deferred/module scripts) and then starts the
// detector and the initial source.

import { addAfterRenderHook, appState, detector, events } from './app';
import { captureSamples } from './auto-seed';
import { captureTrace } from './fencers-trace';
import { drawFencersDebugOverlay, drawRecordedEditorOverlay, isFencersDebugOverlayEnabled } from './overlays';
import { isEditorActive } from './recorded';
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
