// Main Loop
// The requestAnimationFrame loop: throttled detection, trail updates, clash detection and
// per-frame rendering. Owns its own lifecycle via `start()` and an explicit running flag.

import type { Store, AppState } from './state';
import { detectionIntervalMs } from './state';
import type { VideoSource } from './sources/source';
import type { TrailManager } from '../trail-manager';
import { EffectManager, FlashEffect } from '../effects';
import { renderFrame as defaultRenderFrame, type RenderContext, type FrameData } from './render-modes';
import type { DetectionResult, Fencer } from '../../types/fencing';

/** Minimum ms between clash flashes. */
export const CLASH_COOLDOWN_MS = 1000;
/** Normalized tip distance below which two tips count as a clash (3% of frame). */
export const CLASH_DISTANCE = 0.03;
/** Flash effect duration on clash. */
export const CLASH_FLASH_MS = 1600;

export interface MainLoopDeps {
  video: HTMLVideoElement;
  /** Getter so the active source can be swapped (camera <-> video) without rebuilding the loop. */
  getSource: () => VideoSource;
  appState: Store<AppState>;
  trailManager: TrailManager;
  effectManager: EffectManager;
  renderContext: RenderContext;
  detect: (video: HTMLVideoElement, timestamp: number) => Promise<DetectionResult[]>;
  getRecordedFrame?: (
    mediaTimeSeconds: number,
    timestamp: number,
    trailSamples: number
  ) => { fencers: Map<string, Fencer>; detections: DetectionResult[] } | null;
  isDetectorReady: () => boolean;
  /** Called about once per second with the measured render frame rate. */
  onFps?: (fps: number) => void;
  /** Injectable for tests; defaults to the real overlay renderer. */
  renderFrame?: (context: RenderContext, frame: FrameData) => void;
  /** Injectable for tests; defaults to window.requestAnimationFrame. */
  requestFrame?: (callback: (timestamp: number) => void) => void;
}

/**
 * Distance between the first two detections' tips, or Infinity if fewer than two.
 */
export function tipDistance(detections: DetectionResult[]): number {
  if (detections.length < 2) return Infinity;
  const dx = detections[0].tip.x - detections[1].tip.x;
  const dy = detections[0].tip.y - detections[1].tip.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export class MainLoop {
  private running = false;
  private lastDetectionTime = 0;
  private lastClashTime = 0;
  private frameCount = 0;
  private lastFpsTime = 0;
  private detections: DetectionResult[] = [];
  private recordedFencers: Map<string, Fencer> | null = null;

  private readonly renderFrame: (context: RenderContext, frame: FrameData) => void;
  private readonly requestFrame: (callback: (timestamp: number) => void) => void;

  constructor(private readonly deps: MainLoopDeps) {
    this.renderFrame = deps.renderFrame ?? defaultRenderFrame;
    this.requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  }

  /** Begin the loop if it is not already running. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.requestFrame(this.tick);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Detections from the most recent inference pass. */
  getDetections(): DetectionResult[] {
    return this.detections;
  }

  /** Forget the last detections (e.g. when switching tracking mode). */
  clearDetections(): void {
    this.detections = [];
    this.recordedFencers = null;
  }

  private tick = async (timestamp: number): Promise<void> => {
    const { getSource, appState, trailManager, isDetectorReady, video, detect, onFps } = this.deps;

    // Measure render fps
    this.frameCount++;
    if (timestamp - this.lastFpsTime >= 1000) {
      onFps?.(this.frameCount);
      this.frameCount = 0;
      this.lastFpsTime = timestamp;
    }

    // Detection (throttled to inferenceFps, only while the source is attached and playing)
    const source = getSource();
    const sourceAttached = source.isAttached();
    const state = appState.get();
    const detectionInterval = detectionIntervalMs(state.inferenceFps);

    const sourcePlaying = source.isPlaying();

    if (state.trackingMode === 'recorded') {
      const snapshot = this.deps.getRecordedFrame?.(video.currentTime, timestamp, state.trailLength) ?? null;
      this.recordedFencers = snapshot?.fencers ?? null;
      this.detections = snapshot?.detections ?? [];
      this.checkClash(timestamp);
    } else {
      this.recordedFencers = null;

      if (sourceAttached && timestamp - this.lastDetectionTime >= detectionInterval) {
        if (isDetectorReady() && sourcePlaying) {
          try {
            this.detections = await detect(video, timestamp);
            const tips = new Map(this.detections.map((d) => [d.id, d.tip]));
            trailManager.updateTips(tips, timestamp);
            this.checkClash(timestamp);
          } catch (err) {
            console.error('Detection error:', err);
          }
        }
        this.lastDetectionTime = timestamp;
      }
    }

    // If the source is not advancing frames (camera off, paused, seeking), fade trails gradually.
    // Recorded mode is deterministic from keyframes and should not fade.
    if (!sourcePlaying && state.trackingMode !== 'recorded') {
      trailManager.fadeAllTrails();
    }

    // Render every frame so fading trails keep animating
    this.render(timestamp);

    // Keep going while the source is on or trails are still visible
    const fencers = state.trackingMode === 'recorded' ? this.recordedFencers : trailManager.getFencers();
    const hasActiveTrails = Array.from(fencers?.values() ?? []).some((f) => f.trail.length > 0);

    if (sourceAttached || hasActiveTrails) {
      this.requestFrame(this.tick);
    } else {
      this.running = false;
    }
  };

  private checkClash(timestamp: number): void {
    if (
      tipDistance(this.detections) < CLASH_DISTANCE &&
      timestamp - this.lastClashTime > CLASH_COOLDOWN_MS
    ) {
      this.deps.effectManager.addEffect(new FlashEffect(CLASH_FLASH_MS));
      this.lastClashTime = timestamp;
    }
  }

  private render(timestamp: number): void {
    const { getSource, appState, trailManager, effectManager, renderContext } = this.deps;
    const { overlay, trailRenderer } = renderContext;

    // Clear canvas (effects draw on top afterwards)
    trailRenderer.clear();

    // Pre-existing behavior: trails are faded again here, so they fade at twice the nominal
    // rate while the source is off. Kept for parity; see the plan backlog.
    if (!getSource().isPlaying() && appState.get().trackingMode !== 'recorded') {
      trailManager.fadeAllTrails();
    }

    const { trackingMode, debugMode } = appState.get();
    const fencers = trackingMode === 'recorded' ? this.recordedFencers ?? new Map() : trailManager.getFencers();
    this.renderFrame(renderContext, {
      trackingMode,
      debugMode,
      fencers,
      detections: this.detections,
    });

    // Effects on top; guard against zero-sized canvas
    effectManager.updateAndRender(timestamp, Math.max(1, overlay.width), Math.max(1, overlay.height));
  }
}
