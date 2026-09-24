import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_SIZE,
  getVideoMapping,
  mapNormalizedToScreen,
  mapScreenToNormalized,
} from './coordinate-mapper';

// These tests pin object-fit math for both cover and contain.

const LANDSCAPE_VIDEO = { width: 1280, height: 720 };
const PORTRAIT_VIDEO = { width: 720, height: 1280 };

describe('getVideoMapping (object-fit: cover)', () => {
  it('video wider than container: fills height, crops left/right', () => {
    const container = { width: 800, height: 800 };
    const m = getVideoMapping(container, LANDSCAPE_VIDEO, 'cover');

    expect(m.scale).toBeCloseTo(800 / 720, 10);
    expect(m.cropX).toBeCloseTo(280, 10);
    expect(m.cropY).toBe(0);
    expect(m.videoDisplayWidth).toBeCloseTo(1422.222, 3);
    expect(m.videoDisplayHeight).toBeCloseTo(800, 10);
  });

  it('video taller than container: fills width, crops top/bottom', () => {
    const container = { width: 800, height: 800 };
    const m = getVideoMapping(container, PORTRAIT_VIDEO, 'cover');

    expect(m.scale).toBeCloseTo(800 / 720, 10);
    expect(m.cropX).toBe(0);
    expect(m.cropY).toBeCloseTo(280, 10);
    expect(m.videoDisplayWidth).toBeCloseTo(800, 10);
    expect(m.videoDisplayHeight).toBeCloseTo(1422.222, 3);
  });
});

describe('getVideoMapping (object-fit: contain)', () => {
  it('video wider than container: fills width and letterboxes top/bottom', () => {
    const container = { width: 800, height: 800 };
    const m = getVideoMapping(container, LANDSCAPE_VIDEO, 'contain');

    expect(m.scale).toBeCloseTo(800 / 1280, 10);
    expect(m.cropX).toBeCloseTo(0, 10);
    // Negative means padding in contain mode.
    expect(m.cropY).toBeCloseTo(-280, 10);
    expect(m.videoDisplayWidth).toBeCloseTo(800, 10);
    expect(m.videoDisplayHeight).toBeCloseTo(450, 10);
  });

  it('video taller than container: fills height and letterboxes left/right', () => {
    const container = { width: 800, height: 800 };
    const m = getVideoMapping(container, PORTRAIT_VIDEO, 'contain');

    expect(m.scale).toBeCloseTo(800 / 1280, 10);
    expect(m.cropX).toBeCloseTo(-280, 10);
    expect(m.cropY).toBeCloseTo(0, 10);
    expect(m.videoDisplayWidth).toBeCloseTo(450, 10);
    expect(m.videoDisplayHeight).toBeCloseTo(800, 10);
  });
});

describe('mapNormalizedToScreen', () => {
  it('maps the video center to the container center for cover and contain', () => {
    const container = { width: 800, height: 800 };
    for (const fit of ['cover', 'contain'] as const) {
      const p = mapNormalizedToScreen(0.5, 0.5, container, LANDSCAPE_VIDEO, fit);
      expect(p.x).toBeCloseTo(container.width / 2, 8);
      expect(p.y).toBeCloseTo(container.height / 2, 8);
    }
  });

  it('contain mode places corners inside the container with letterbox offsets', () => {
    const container = { width: 800, height: 800 };
    const tl = mapNormalizedToScreen(0, 0, container, LANDSCAPE_VIDEO, 'contain');
    const br = mapNormalizedToScreen(1, 1, container, LANDSCAPE_VIDEO, 'contain');

    expect(tl.x).toBeCloseTo(0, 10);
    expect(tl.y).toBeCloseTo(175, 10);
    expect(br.x).toBeCloseTo(800, 10);
    expect(br.y).toBeCloseTo(625, 10);
  });
});

describe('mapScreenToNormalized', () => {
  it('is the inverse of mapNormalizedToScreen (cover)', () => {
    const container = { width: 390, height: 844 };
    const points = [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.8 },
    ];

    for (const p of points) {
      const screen = mapNormalizedToScreen(p.x, p.y, container, LANDSCAPE_VIDEO, 'cover');
      const norm = mapScreenToNormalized(screen.x, screen.y, container, LANDSCAPE_VIDEO, 'cover');
      expect(norm.x).toBeCloseTo(p.x, 8);
      expect(norm.y).toBeCloseTo(p.y, 8);
    }
  });

  it('returns out-of-range normalized values in letterboxed contain areas', () => {
    const container = { width: 800, height: 800 };
    const topCenter = mapScreenToNormalized(400, 10, container, LANDSCAPE_VIDEO, 'contain');
    const bottomCenter = mapScreenToNormalized(400, 790, container, LANDSCAPE_VIDEO, 'contain');

    expect(topCenter.x).toBeCloseTo(0.5, 8);
    expect(topCenter.y).toBeLessThan(0);
    expect(bottomCenter.x).toBeCloseTo(0.5, 8);
    expect(bottomCenter.y).toBeGreaterThan(1);
  });
});

describe('DEFAULT_VIDEO_SIZE', () => {
  it('is 1280x720, matching the pre-refactor fallback', () => {
    expect(DEFAULT_VIDEO_SIZE).toEqual({ width: 1280, height: 720 });
  });
});
