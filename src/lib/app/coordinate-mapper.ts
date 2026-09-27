// Coordinate Mapper
// Maps normalized video coordinates (0-1, as produced by MediaPipe) to overlay-canvas pixels.
//
// The video element fills the viewport with `object-fit: cover`, so part of the frame is cropped
// off two opposite edges. The overlay canvas is the size of the viewport, so a normalized video
// coordinate has to be scaled by the same factor the browser used and shifted by the cropped
// amount. The pure functions here are unit-tested; `createCoordinateMapper` is the thin DOM wrapper
// the renderers use.

import type { FitMode } from './sources/source';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface VideoMapping {
  /** Video pixels -> screen pixels (uniform in x and y). */
  scale: number;
  /** Video pixels cropped off each left/right edge (0 when the video fills the width). */
  cropX: number;
  /** Video pixels cropped off each top/bottom edge (0 when the video fills the height). */
  cropY: number;
  /** Size of the video as displayed, in screen pixels (may exceed the container). */
  videoDisplayWidth: number;
  videoDisplayHeight: number;
}

/** Used until the video element reports real dimensions (before `loadedmetadata`). */
export const DEFAULT_VIDEO_SIZE: Size = { width: 1280, height: 720 };

/**
 * Compute how a video of `video` size is scaled into a `container` for object-fit
 * `cover` (crop) or `contain` (letterbox). With contain, cropX/cropY are negative and
 * represent padding in video-pixel units.
 */
export function getVideoMapping(container: Size, video: Size, fit: FitMode = 'cover'): VideoMapping {
  const scaleX = container.width / video.width;
  const scaleY = container.height / video.height;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  const displayedWidth = video.width * scale;
  const displayedHeight = video.height * scale;

  const cropX = (displayedWidth - container.width) / 2 / scale;
  const cropY = (displayedHeight - container.height) / 2 / scale;

  return {
    scale,
    cropX,
    cropY,
    videoDisplayWidth: displayedWidth,
    videoDisplayHeight: displayedHeight,
  };
}

/**
 * Map a normalized video coordinate (0-1) to screen/canvas pixels for the given sizes.
 */
export function mapNormalizedToScreen(
  normX: number,
  normY: number,
  container: Size,
  video: Size,
  fit: FitMode = 'cover'
): Point {
  const { scale, cropX, cropY } = getVideoMapping(container, video, fit);
  const videoX = normX * video.width;
  const videoY = normY * video.height;
  return {
    x: (videoX - cropX) * scale,
    y: (videoY - cropY) * scale,
  };
}

/**
 * Inverse mapping: screen/canvas pixel -> normalized video coordinate.
 * Values can be outside [0, 1] when the screen point is in the letterboxed area (contain).
 */
export function mapScreenToNormalized(
  screenX: number,
  screenY: number,
  container: Size,
  video: Size,
  fit: FitMode = 'cover'
): Point {
  const { scale, cropX, cropY } = getVideoMapping(container, video, fit);
  const videoX = screenX / scale + cropX;
  const videoY = screenY / scale + cropY;
  return {
    x: videoX / video.width,
    y: videoY / video.height,
  };
}

/** A function that maps normalized video coordinates to overlay-canvas pixels. */
export type CoordinateMapper = (normX: number, normY: number) => Point;
export type InverseCoordinateMapper = (screenX: number, screenY: number) => Point;

/**
 * Current viewport size. Prefers `visualViewport`, which tracks the mobile address bar and
 * on-screen keyboard correctly; falls back to the window inner size.
 */
export function getViewportSize(): Size {
  const vv = window.visualViewport;
  return vv
    ? { width: vv.width, height: vv.height }
    : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Current intrinsic size of the video, or the default until metadata has loaded.
 */
export function getVideoSize(video: HTMLVideoElement): Size {
  return {
    width: video.videoWidth || DEFAULT_VIDEO_SIZE.width,
    height: video.videoHeight || DEFAULT_VIDEO_SIZE.height,
  };
}

/**
 * Build a mapper bound to a video element. It re-reads viewport and video dimensions on every
 * call, so it stays correct across resizes, orientation changes and late metadata (iOS).
 */
export function createCoordinateMapper(
  video: HTMLVideoElement,
  getFit: () => FitMode = () => 'cover'
): CoordinateMapper {
  return (normX, normY) =>
    mapNormalizedToScreen(normX, normY, getViewportSize(), getVideoSize(video), getFit());
}

/** Build an inverse mapper bound to a video element (screen pixel -> normalized video). */
export function createInverseCoordinateMapper(
  video: HTMLVideoElement,
  getFit: () => FitMode = () => 'cover'
): InverseCoordinateMapper {
  return (screenX, screenY) =>
    mapScreenToNormalized(screenX, screenY, getViewportSize(), getVideoSize(video), getFit());
}
