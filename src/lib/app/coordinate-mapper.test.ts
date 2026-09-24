import { describe, expect, it } from 'vitest';
import { getVideoMapping, mapNormalizedToScreen, DEFAULT_VIDEO_SIZE } from './coordinate-mapper';

// These tests pin the object-fit: cover math that was previously inlined in index.astro.
// Reference values are derived from the same formulas by hand, not copied from the code.

const LANDSCAPE_VIDEO = { width: 1280, height: 720 };
const PORTRAIT_VIDEO = { width: 720, height: 1280 };

describe('getVideoMapping (object-fit: cover)', () => {
  it('video wider than container: fills height, crops left/right', () => {
    const container = { width: 800, height: 800 };
    const m = getVideoMapping(container, LANDSCAPE_VIDEO);

    // scale = 800 / 720
    expect(m.scale).toBeCloseTo(800 / 720, 10);
    // displayed width = 1280 * (800/720) = 1422.2; overflow = 622.2 screen px; half per side,
    // converted back to video px: 311.1 / (800/720) = 280
    expect(m.cropX).toBeCloseTo(280, 10);
    expect(m.cropY).toBe(0);
    expect(m.videoDisplayWidth).toBeCloseTo(1422.222, 3);
    expect(m.videoDisplayHeight).toBeCloseTo(800, 10);
  });

  it('video taller than container: fills width, crops top/bottom', () => {
    const container = { width: 800, height: 800 };
    const m = getVideoMapping(container, PORTRAIT_VIDEO);

    expect(m.scale).toBeCloseTo(800 / 720, 10);
    expect(m.cropX).toBe(0);
    expect(m.cropY).toBeCloseTo(280, 10);
    expect(m.videoDisplayWidth).toBeCloseTo(800, 10);
    expect(m.videoDisplayHeight).toBeCloseTo(1422.222, 3);
  });

  it('matching aspect: no cropping, pure scale', () => {
    const container = { width: 640, height: 360 };
    const m = getVideoMapping(container, LANDSCAPE_VIDEO);

    expect(m.scale).toBeCloseTo(0.5, 10);
    expect(m.cropX).toBe(0);
    expect(m.cropY).toBe(0);
    expect(m.videoDisplayWidth).toBeCloseTo(640, 10);
    expect(m.videoDisplayHeight).toBeCloseTo(360, 10);
  });

  it('phone portrait viewport with landscape camera (the iOS alignment case)', () => {
    // iPhone-ish viewport, 16:9 camera: video fills the height, most of the width is cropped.
    const container = { width: 390, height: 844 };
    const m = getVideoMapping(container, LANDSCAPE_VIDEO);

    const scale = 844 / 720;
    expect(m.scale).toBeCloseTo(scale, 10);
    const displayedWidth = 1280 * scale;
    expect(m.cropX).toBeCloseTo((displayedWidth - 390) / 2 / scale, 10);
    expect(m.cropY).toBe(0);
  });
});

describe('mapNormalizedToScreen', () => {
  it('maps the video center to the container center regardless of cropping', () => {
    for (const container of [
      { width: 800, height: 800 },
      { width: 390, height: 844 },
      { width: 1920, height: 1080 },
    ]) {
      for (const video of [LANDSCAPE_VIDEO, PORTRAIT_VIDEO]) {
        const p = mapNormalizedToScreen(0.5, 0.5, container, video);
        expect(p.x).toBeCloseTo(container.width / 2, 8);
        expect(p.y).toBeCloseTo(container.height / 2, 8);
      }
    }
  });

  it('wider video: corners land outside the container horizontally, exactly on it vertically', () => {
    const container = { width: 800, height: 800 };
    const tl = mapNormalizedToScreen(0, 0, container, LANDSCAPE_VIDEO);
    const br = mapNormalizedToScreen(1, 1, container, LANDSCAPE_VIDEO);

    // Horizontal overflow of 622.2 screen px total, 311.1 per side
    expect(tl.x).toBeCloseTo(-311.111, 3);
    expect(tl.y).toBeCloseTo(0, 10);
    expect(br.x).toBeCloseTo(800 + 311.111, 3);
    expect(br.y).toBeCloseTo(800, 10);
  });

  it('taller video: corners land outside the container vertically, exactly on it horizontally', () => {
    const container = { width: 800, height: 800 };
    const tl = mapNormalizedToScreen(0, 0, container, PORTRAIT_VIDEO);
    const br = mapNormalizedToScreen(1, 1, container, PORTRAIT_VIDEO);

    expect(tl.x).toBeCloseTo(0, 10);
    expect(tl.y).toBeCloseTo(-311.111, 3);
    expect(br.x).toBeCloseTo(800, 10);
    expect(br.y).toBeCloseTo(800 + 311.111, 3);
  });

  it('matching aspect: corners map exactly onto the container corners', () => {
    const container = { width: 640, height: 360 };
    expect(mapNormalizedToScreen(0, 0, container, LANDSCAPE_VIDEO)).toEqual({ x: 0, y: 0 });
    const br = mapNormalizedToScreen(1, 1, container, LANDSCAPE_VIDEO);
    expect(br.x).toBeCloseTo(640, 10);
    expect(br.y).toBeCloseTo(360, 10);
  });

  it('is linear in the normalized input', () => {
    const container = { width: 1000, height: 500 };
    const a = mapNormalizedToScreen(0.2, 0.3, container, LANDSCAPE_VIDEO);
    const b = mapNormalizedToScreen(0.4, 0.6, container, LANDSCAPE_VIDEO);
    const mid = mapNormalizedToScreen(0.3, 0.45, container, LANDSCAPE_VIDEO);
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 8);
    expect(mid.y).toBeCloseTo((a.y + b.y) / 2, 8);
  });
});

describe('DEFAULT_VIDEO_SIZE', () => {
  it('is 1280x720, matching the pre-refactor fallback', () => {
    expect(DEFAULT_VIDEO_SIZE).toEqual({ width: 1280, height: 720 });
  });
});
