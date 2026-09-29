import { describe, expect, it } from 'vitest';
import { refineTipFromFrame, type VideoFramePixels } from './tip-refiner';

function createFrame(
  width: number,
  height: number,
  lumaAt: (x: number, y: number) => number
): VideoFramePixels {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const luma = Math.max(0, Math.min(255, Math.round(lumaAt(x, y))));
      rgba[idx] = luma;
      rgba[idx + 1] = luma;
      rgba[idx + 2] = luma;
      rgba[idx + 3] = 255;
    }
  }
  return { width, height, rgba };
}

describe('refineTipFromFrame', () => {
  it('keeps prior when there is no visible edge signal', () => {
    const frame = createFrame(120, 80, () => 90);
    const result = refineTipFromFrame(
      frame,
      { x: 0.4, y: 0.5 },
      { x: 0.3, y: 0.5, z: 0, visibility: 1 },
      { x: 0.2, y: 0.5, z: 0, visibility: 1 }
    );

    expect(result.confidence).toBe(0);
    expect(result.usedRefined).toBe(false);
    expect(result.refined.x).toBeCloseTo(0.4, 5);
    expect(result.refined.y).toBeCloseTo(0.5, 5);
  });

  it('pulls toward refined endpoint when strong edge signal exists', () => {
    const frame = createFrame(120, 80, (_x, y) => (y < 40 ? 240 : 8));
    const result = refineTipFromFrame(
      frame,
      { x: 0.4, y: 0.5 },
      { x: 0.3, y: 0.5, z: 0, visibility: 1 },
      { x: 0.2, y: 0.5, z: 0, visibility: 1 }
    );

    expect(result.confidence).toBeGreaterThan(0.2);
    expect(result.usedRefined).toBe(true);
    expect(result.refined.x).toBeGreaterThan(0.4);
    expect(result.refined.x).toBeLessThanOrEqual(0.48);
  });

  it('falls back safely when forearm direction is invalid', () => {
    const frame = createFrame(64, 64, () => 128);
    const result = refineTipFromFrame(
      frame,
      { x: 0.35, y: 0.44 },
      { x: 0.5, y: 0.5, z: 0, visibility: 1 },
      { x: 0.5, y: 0.5, z: 0, visibility: 1 }
    );

    expect(result.usedRefined).toBe(false);
    expect(result.refined.x).toBeCloseTo(0.35, 5);
    expect(result.refined.y).toBeCloseTo(0.44, 5);
  });

  it('uses provided seed direction when available', () => {
    const frame = createFrame(120, 80, () => 128);
    const result = refineTipFromFrame(
      frame,
      { x: 0.4, y: 0.5 },
      { x: 0.3, y: 0.5, z: 0, visibility: 1 },
      { x: 0.2, y: 0.5, z: 0, visibility: 1 },
      { x: 0.6, y: -0.8 }
    );

    expect(result.searchStart.x).toBeGreaterThan(0.3);
    expect(result.searchStart.y).toBeLessThan(0.5);
  });
});
