// Detector Controller
// Owns the lifecycle of the MediaPipe detector: loading the model for the current tracking mode
// and swapping models when the mode changes. Reports human-readable status via a callback.

import type { TrackingMode } from '../../types/fencing';

export type InferenceTrackingMode = 'hand' | 'pose';

function isInferenceTrackingMode(mode: TrackingMode): mode is InferenceTrackingMode {
  return mode === 'hand' || mode === 'pose';
}

/** The detector operations this controller drives (matches unified-detector's exports). */
export interface DetectorBackend {
  init(
    mode: InferenceTrackingMode,
    options: {
      numTargets: number;
      minDetectionConfidence: number;
      minPresenceConfidence: number;
      minTrackingConfidence: number;
    }
  ): Promise<void>;
  reset(): Promise<void>;
}

export interface DetectorControllerDeps {
  backend: DetectorBackend;
  /** Called with a short status string for the UI ("Loading hand model...", "Running", ...). */
  onStatus: (text: string) => void;
  /** Whether a video source is currently attached; only affects the status wording. */
  isSourceAttached: () => boolean;
  /** Invoked when a mode switch begins, before the new model loads (clear trails/detections). */
  onSwitchStart?: () => void;
}

export const DETECTION_CONFIDENCE = 0.5;

/** Pose and hand modes both track up to two targets. */
export function numTargetsFor(_mode: InferenceTrackingMode): number {
  return 2;
}

export class DetectorController {
  private ready = false;
  private switching = false;

  constructor(private readonly deps: DetectorControllerDeps) {}

  isReady(): boolean {
    return this.ready;
  }

  /** True while a mode switch is tearing down / loading; UI should ignore further switches. */
  isSwitching(): boolean {
    return this.switching;
  }

  /** Load the model for `mode`. Status becomes "Running"/"Ready - start camera" or an error. */
  async load(mode: TrackingMode): Promise<void> {
    const { backend, onStatus, isSourceAttached } = this.deps;

    if (!isInferenceTrackingMode(mode)) {
      this.ready = true;
      onStatus(isSourceAttached() ? 'Recorded mode' : 'Recorded mode - load video');
      return;
    }

    onStatus(`Loading ${mode} model...`);
    try {
      await backend.init(mode, {
        numTargets: numTargetsFor(mode),
        minDetectionConfidence: DETECTION_CONFIDENCE,
        minPresenceConfidence: DETECTION_CONFIDENCE,
        minTrackingConfidence: DETECTION_CONFIDENCE,
      });
      this.ready = true;
      onStatus(isSourceAttached() ? 'Running' : 'Ready - start camera');
    } catch (err) {
      console.error('Failed to initialize detector:', err);
      onStatus('Model failed to load');
    }
  }

  /** Tear down the current detector and load the one for `mode`. */
  async switchTo(mode: TrackingMode): Promise<void> {
    this.switching = true;
    this.ready = false;
    await this.deps.backend.reset();
    this.deps.onSwitchStart?.();
    await this.load(mode);
    this.switching = false;
  }
}
