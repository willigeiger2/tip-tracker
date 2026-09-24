// Overlay Sizing
// Keeps the overlay canvas backing store the same size as the viewport, and re-syncs on every
// event that can change the viewport or the video's reported dimensions. The extra delayed
// re-syncs work around iOS Safari reporting video dimensions late.

import { getViewportSize } from './coordinate-mapper';

export interface Resizable {
  resize(): void;
}

/** Delays (ms) after `loadedmetadata` at which iOS needs another resize pass. */
export const METADATA_RESIZE_DELAYS_MS = [100, 500];
/** Delay (ms) after `playing` at which iOS needs another resize pass. */
export const PLAYING_RESIZE_DELAY_MS = 100;

/**
 * Size the overlay canvas to the current viewport and stretch it to fill its container.
 * Cropping/letterboxing is handled by the coordinate mapper, not by the canvas geometry.
 */
export function resizeOverlayCanvas(overlay: HTMLCanvasElement): void {
  const { width, height } = getViewportSize();

  overlay.width = width;
  overlay.height = height;

  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.left = '0';
  overlay.style.top = '0';
}

/**
 * Resize the overlay and every dependent renderer now, and again whenever the window,
 * visual viewport, or video dimensions change. Returns a function that performs one resize
 * pass on demand (e.g. after switching video source).
 */
export function installOverlaySizing(
  video: HTMLVideoElement,
  overlay: HTMLCanvasElement,
  renderers: Resizable[]
): () => void {
  const resizeAll = () => {
    resizeOverlayCanvas(overlay);
    for (const r of renderers) r.resize();
  };

  resizeAll();

  window.addEventListener('resize', resizeAll);

  // Mobile address bar, on-screen keyboard, pinch zoom
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resizeAll);
    window.visualViewport.addEventListener('scroll', resizeAll);
  }

  // Video dimensions become known; iOS needs a couple of delayed passes to settle
  video.addEventListener('loadedmetadata', () => {
    resizeAll();
    for (const delay of METADATA_RESIZE_DELAYS_MS) setTimeout(resizeAll, delay);
  });

  // iOS sometimes reports dimensions only once playback starts
  video.addEventListener('playing', () => {
    resizeAll();
    setTimeout(resizeAll, PLAYING_RESIZE_DELAY_MS);
  });

  // Video intrinsic size changed (new source, orientation)
  video.addEventListener('resize', resizeAll);

  return resizeAll;
}
