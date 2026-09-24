// Application State
// A minimal typed store for user-facing configuration. UI controls write to it; the main loop and
// renderers read from it; side effects (reinitialize detector, resize trail buffer) subscribe.
// Runtime/loop internals (timestamps, current detections) deliberately do not live here.

import type { DebugMode, EffectMode, TrackingMode } from '../../types/fencing';

export interface AppState {
  trackingMode: TrackingMode;
  debugMode: DebugMode;
  effectMode: EffectMode;
  /** Detection rate in frames per second (rendering is always as fast as rAF allows). */
  inferenceFps: number;
  /** Trail ring-buffer length in points. */
  trailLength: number;
  glowIntensity: number;
}

export const DEFAULT_APP_STATE: AppState = {
  trackingMode: 'hand',
  debugMode: 'none',
  effectMode: 'none',
  inferenceFps: 15,
  trailLength: 30,
  glowIntensity: 1.0,
};

export type StateListener<T> = (state: Readonly<T>, changed: ReadonlySet<keyof T>) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<StateListener<T>>();

  constructor(initial: T) {
    this.state = { ...initial };
  }

  get(): Readonly<T> {
    return this.state;
  }

  /**
   * Shallow-merge a patch. Listeners are notified once, with the set of keys whose value
   * actually changed (strict inequality). A patch that changes nothing notifies nobody.
   */
  update(patch: Partial<T>): void {
    const changed = new Set<keyof T>();
    for (const key of Object.keys(patch) as (keyof T)[]) {
      const next = patch[key] as T[keyof T];
      if (this.state[key] !== next) {
        this.state[key] = next;
        changed.add(key);
      }
    }
    if (changed.size === 0) return;
    for (const listener of this.listeners) {
      listener(this.state, changed);
    }
  }

  /** Subscribe to all changes. Returns an unsubscribe function. */
  subscribe(listener: StateListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to changes of a single key. Returns an unsubscribe function. */
  on<K extends keyof T>(key: K, callback: (value: T[K], state: Readonly<T>) => void): () => void {
    return this.subscribe((state, changed) => {
      if (changed.has(key)) callback(state[key], state);
    });
  }
}

export function createAppState(overrides: Partial<AppState> = {}): Store<AppState> {
  return new Store<AppState>({ ...DEFAULT_APP_STATE, ...overrides });
}

/** Milliseconds between detections for a given inference rate. */
export function detectionIntervalMs(inferenceFps: number): number {
  return 1000 / inferenceFps;
}
