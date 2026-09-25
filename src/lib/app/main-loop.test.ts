import { describe, expect, it, vi } from 'vitest';
import { MainLoop, tipDistance, CLASH_DISTANCE } from './main-loop';
import { createAppState } from './state';
import { TrailManager } from '../trail-manager';
import type { VideoSource } from './sources/source';
import type { DetectionResult, Fencer, TipPosition } from '../../types/fencing';

// The loop is driven by a hand-cranked requestAnimationFrame so each test controls time exactly.
// Timestamps start at T0 (not 0) because, like real rAF timestamps, the first frame must be far
// enough from the initial lastDetectionTime = 0 for the first detection to fire.
const T0 = 10_000;

function tip(x: number, y: number, timestamp = 0): TipPosition {
  return { x, y, z: 0, confidence: 1, timestamp, side: x < 0.5 ? 'left' : 'right' };
}

function detection(id: string, x: number, y: number): DetectionResult {
  return { id, side: x < 0.5 ? 'left' : 'right', tip: tip(x, y), landmarks: [] };
}

class FakeSource implements VideoSource {
  readonly kind = 'camera' as const;
  readonly mirrored = true;
  readonly fit = 'cover' as const;
  attached = false;
  playing = true;
  async attach(): Promise<void> { this.attached = true; }
  detach(): void { this.attached = false; }
  isAttached(): boolean { return this.attached; }
  isPlaying(): boolean { return this.attached && this.playing; }
}

function setup(options: { detections?: DetectionResult[]; inferenceFps?: number; recordedFrame?: { fencers: Map<string, Fencer>; detections: DetectionResult[] } | null } = {}) {
  const pending: Array<(t: number) => void | Promise<void>> = [];
  const requestFrame = (cb: (t: number) => void | Promise<void>) => { pending.push(cb); };
  /** Run every queued frame callback with the given timestamp. */
  const crank = async (timestamp: number) => {
    const cbs = pending.splice(0);
    for (const cb of cbs) await cb(timestamp);
  };

  const source = new FakeSource();
  const appState = createAppState({ inferenceFps: options.inferenceFps ?? 10 }); // 100 ms interval
  const trailManager = new TrailManager({ maxLength: 30 });
  const detect = vi.fn(async () => options.detections ?? []);
  const renderFrame = vi.fn();
  const addEffect = vi.fn();
  const onFps = vi.fn();

  const loop = new MainLoop({
    video: {} as HTMLVideoElement,
    getSource: () => source,
    appState,
    trailManager,
    effectManager: { addEffect, updateAndRender: vi.fn() } as never,
    renderContext: {
      overlay: { width: 100, height: 100 } as HTMLCanvasElement,
      trailRenderer: { clear: vi.fn() } as never,
      debugRenderer: {} as never,
      mapToCanvas: (x, y) => ({ x, y }),
    },
    detect,
    getRecordedFrame: () => options.recordedFrame ?? null,
    isDetectorReady: () => true,
    onFps,
    renderFrame,
    requestFrame,
  });

  return { loop, source, appState, trailManager, detect, renderFrame, addEffect, onFps, crank, pending };
}

describe('MainLoop lifecycle', () => {
  it('start() is idempotent and schedules exactly one frame', () => {
    const { loop, pending } = setup();
    loop.start();
    loop.start();
    expect(loop.isRunning()).toBe(true);
    expect(pending).toHaveLength(1);
  });

  it('keeps running while the source is attached', async () => {
    const { loop, source, crank, pending } = setup();
    source.attached = true;
    loop.start();
    await crank(T0);
    await crank(T0 + 16);
    expect(loop.isRunning()).toBe(true);
    expect(pending).toHaveLength(1);
  });

  it('stops when the source is detached and no trails remain, and can be restarted', async () => {
    const { loop, source, crank, pending } = setup();
    source.attached = false;
    loop.start();
    await crank(T0);
    expect(loop.isRunning()).toBe(false);
    expect(pending).toHaveLength(0);

    loop.start();
    expect(loop.isRunning()).toBe(true);
    expect(pending).toHaveLength(1);
  });

  it('keeps running after detach until the trails have faded out', async () => {
    const { loop, source, trailManager, crank } = setup({ detections: [detection('A', 0.2, 0.5)] });
    source.attached = true;
    loop.start();
    await crank(T0); // detection -> one trail point
    expect(trailManager.getFencers().get('A')!.trail).toHaveLength(1);

    source.attached = false;
    let t = T0 + 16;
    let frames = 0;
    while (loop.isRunning() && frames < 200) {
      await crank(t);
      t += 16;
      frames++;
    }
    expect(loop.isRunning()).toBe(false);
    expect(frames).toBeGreaterThan(1); // it faded, not stopped instantly
    expect(trailManager.getFencers().get('A')!.trail).toHaveLength(0);
  });
});

describe('MainLoop detection scheduling', () => {
  it('throttles detection to the inference interval', async () => {
    const { loop, source, detect, crank } = setup({ inferenceFps: 10 }); // every 100 ms
    source.attached = true;
    loop.start();
    await crank(T0);       // detect (first)
    await crank(T0 + 50);  // too soon
    await crank(T0 + 99);  // too soon
    await crank(T0 + 100); // detect
    await crank(T0 + 150); // too soon
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('does not detect while the source is not playing (paused), but still renders', async () => {
    const { loop, source, detect, renderFrame, crank } = setup();
    source.attached = true;
    source.playing = false;
    loop.start();
    await crank(T0);
    await crank(T0 + 200);
    expect(detect).not.toHaveBeenCalled();
    expect(renderFrame).toHaveBeenCalledTimes(2);
  });

  it('feeds detections into the trail manager and exposes them', async () => {
    const dets = [detection('A', 0.2, 0.5), detection('B', 0.8, 0.5)];
    const { loop, source, trailManager, crank } = setup({ detections: dets });
    source.attached = true;
    loop.start();
    await crank(T0);
    expect(loop.getDetections()).toEqual(dets);
    expect(trailManager.getFencers().get('A')!.trail).toHaveLength(1);
    expect(trailManager.getFencers().get('B')!.trail).toHaveLength(1);

    loop.clearDetections();
    expect(loop.getDetections()).toEqual([]);
  });

  it('reports fps roughly once per second', async () => {
    const { loop, source, onFps, crank } = setup();
    source.attached = true;
    loop.start();
    for (let t = T0; t <= T0 + 1000; t += 100) await crank(t);
    // Pre-existing quirk: the very first frame reports immediately (lastFpsTime starts at 0),
    // then real counts follow once per second.
    expect(onFps).toHaveBeenCalledTimes(2);
    expect(onFps).toHaveBeenNthCalledWith(1, 1);
    expect(onFps).toHaveBeenNthCalledWith(2, 10);
  });

  it('recorded mode bypasses detector and uses recorded frame snapshot', async () => {
    const fencers = new Map<string, Fencer>([
      ['A', { id: 'A', side: 'left', color: '#00ff00', tip: tip(0.2, 0.2), trail: [] }],
      ['B', { id: 'B', side: 'right', color: '#ff0000', tip: tip(0.8, 0.2), trail: [] }],
    ]);
    const dets = [detection('A', 0.2, 0.2), detection('B', 0.8, 0.2)];
    const { loop, source, appState, detect, crank } = setup({ recordedFrame: { fencers, detections: dets } });
    appState.update({ trackingMode: 'recorded' });
    source.attached = true;
    source.playing = false;
    loop.start();
    await crank(T0);
    expect(detect).not.toHaveBeenCalled();
    expect(loop.getDetections()).toEqual(dets);
  });
});

describe('clash detection', () => {
  it('tipDistance is Infinity with fewer than two detections', () => {
    expect(tipDistance([])).toBe(Infinity);
    expect(tipDistance([detection('A', 0.1, 0.1)])).toBe(Infinity);
  });

  it('fires a flash once when tips touch, then respects the cooldown', async () => {
    const close = [detection('A', 0.50, 0.5), detection('B', 0.51, 0.5)];
    expect(tipDistance(close)).toBeLessThan(CLASH_DISTANCE);

    const { loop, source, addEffect, crank } = setup({ detections: close, inferenceFps: 10 });
    source.attached = true;
    loop.start();
    await crank(T0);        // clash -> flash
    await crank(T0 + 100);  // clash but within cooldown
    await crank(T0 + 500);  // still within 1000 ms cooldown
    expect(addEffect).toHaveBeenCalledTimes(1);
    await crank(T0 + 1100); // cooldown elapsed -> flash again
    expect(addEffect).toHaveBeenCalledTimes(2);
  });

  it('does not fire when tips are apart', async () => {
    const apart = [detection('A', 0.2, 0.5), detection('B', 0.8, 0.5)];
    const { loop, source, addEffect, crank } = setup({ detections: apart });
    source.attached = true;
    loop.start();
    await crank(T0);
    expect(addEffect).not.toHaveBeenCalled();
  });
});
