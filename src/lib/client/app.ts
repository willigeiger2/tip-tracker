// Client app context: the long-lived browser objects (state store, video/overlay elements,
// sources, renderers, detector, main loop) and the session state shared between controllers.
// Imported by component scripts and controllers; module scripts run after the DOM is parsed, so
// the stage elements rendered by VideoStage.astro exist when this module is evaluated.

import {
  initDetector,
  detect,
  resetCurrentDetector,
  setFencerLengthSmoothingAlpha,
  setFencerWeaponArm,
} from '../unified-detector';
import { TrailManager } from '../trail-manager';
import { TrailRenderer, DebugRenderer } from '../renderer';
import { EffectManager } from '../effects';
import { setFencerDirectionTuning, setPoseTipExtension } from '../tip-estimator';
import { DEFAULT_FRAME_RATE } from '../app/frame-rate';
import { createCoordinateMapper, createInverseCoordinateMapper } from '../app/coordinate-mapper';
import { createAppState } from '../app/state';
import type { FrameData, RenderContext } from '../app/render-modes';
import { MainLoop, type MainLoopDeps } from '../app/main-loop';
import { DetectorController } from '../app/detector-controller';
import { CameraSource } from '../app/sources/camera-source';
import { UrlSource } from '../app/sources/url-source';
import type { VideoSource } from '../app/sources/source';
import { byId } from './dom';
import { Emitter } from './events';

export type TrackId = 'A' | 'B';

export interface AppEvents extends Record<string, unknown> {
  /** Detection status line text. */
  status: string;
  /** Measured render frame rate. */
  fps: number;
  /** Active source (camera / video) changed. */
  source: void;
  /** URL to show in the video URL input (library load, ?video= param). */
  'video-url': string;
  /** Transport fps or seek-drag state changed. */
  transport: void;
  /** Recorded track set, active track, or edit mode changed. */
  recorded: void;
  /** A track set was loaded for a newly loaded video. */
  'track-set-loaded': void;
  'recorded-status': string;
  /** Saved-video library list changed. */
  library: void;
  'library-status': string;
  /** Auto-seed sample counts changed. */
  'auto-seed': void;
  /** Fencers trace status changed. */
  trace: { text: string; canExport: boolean };
}

export const events = new Emitter<AppEvents>();
export const appState = createAppState();

export const video = byId<HTMLVideoElement>('video');
export const overlay = byId<HTMLCanvasElement>('overlay');
/** The stage element that contains the video, overlay, panel and transport. */
export const stage = byId<HTMLDivElement>('container');

export const cameraSource = new CameraSource();
export const urlSource = new UrlSource();

/** Mutable session state shared by the controllers. */
export const session: {
  activeSource: VideoSource;
  switchingSource: boolean;
  currentVideoId: string | null;
  currentVideoUrl: string;
  transportFps: number;
  transportFpsApproximate: boolean;
} = {
  activeSource: cameraSource,
  switchingSource: false,
  currentVideoId: null,
  currentVideoUrl: '',
  transportFps: DEFAULT_FRAME_RATE,
  transportFpsApproximate: true,
};

export function isVideoSource(): boolean {
  return session.activeSource.kind === 'video';
}

export function setStatus(text: string): void {
  events.emit('status', text);
}

// Mapper tracks activeSource.fit dynamically (camera: cover, URL video: contain).
export const mapToCanvas = createCoordinateMapper(video, () => session.activeSource.fit);
export const mapToNormalized = createInverseCoordinateMapper(video, () => session.activeSource.fit);

export const trailManager = new TrailManager({ maxLength: appState.get().trailLength });
export const trailRenderer = new TrailRenderer(overlay);
export const debugRenderer = new DebugRenderer(overlay);
export const effectManager = new EffectManager(overlay.getContext('2d')!);
export const renderContext: RenderContext = { overlay, trailRenderer, debugRenderer, mapToCanvas };

trailRenderer.setCoordinateMapper(mapToCanvas);
trailRenderer.setGlowIntensity(appState.get().glowIntensity);
trailRenderer.setEffectMode(appState.get().effectMode);
debugRenderer.setCoordinateMapper(mapToCanvas);
debugRenderer.setRates(60, appState.get().inferenceFps);

/** Clear trails and the loop's last detections (seek, source switch, new track data). */
export function clearTrails(): void {
  trailManager.clear();
  mainLoop.clearDetections();
}

export const detector = new DetectorController({
  backend: { init: initDetector, reset: resetCurrentDetector },
  onStatus: setStatus,
  isSourceAttached: () => session.activeSource.isAttached(),
  onSwitchStart: clearTrails,
});

// ---- Main loop extension points ----
type AfterRenderHook = (context: RenderContext, frame: FrameData) => void;
const afterRenderHooks: AfterRenderHook[] = [];
let recordedFrameProvider: MainLoopDeps['getRecordedFrame'] | null = null;

/** Register an overlay/capture pass run after each rendered frame (in registration order). */
export function addAfterRenderHook(hook: AfterRenderHook): void {
  afterRenderHooks.push(hook);
}

export function setRecordedFrameProvider(provider: NonNullable<MainLoopDeps['getRecordedFrame']>): void {
  recordedFrameProvider = provider;
}

export const mainLoop = new MainLoop({
  video,
  getSource: () => session.activeSource,
  appState,
  trailManager,
  effectManager,
  renderContext,
  detect,
  getRecordedFrame: (mediaTime, timestamp, trailSamples) =>
    recordedFrameProvider ? recordedFrameProvider(mediaTime, timestamp, trailSamples) : null,
  onAfterRender: (context, frame) => {
    for (const hook of afterRenderHooks) hook(context, frame);
  },
  isDetectorReady: () => detector.isReady(),
  onFps: (fps) => events.emit('fps', fps),
});

// ---- Configuration side effects: state -> engine ----
appState.on('trailLength', (value) => trailManager.setConfig({ maxLength: value }));
appState.on('inferenceFps', (value) => debugRenderer.setRates(60, value));
appState.on('glowIntensity', (value) => trailRenderer.setGlowIntensity(value));
appState.on('effectMode', (value) => trailRenderer.setEffectMode(value));
appState.on('trackingMode', (mode) => void detector.switchTo(mode));
appState.on('poseTipExtension', (value) => setPoseTipExtension(value));
appState.on('fencerATipExtension', (value) => setFencerDirectionTuning('A', { extensionMultiplier: value }));
appState.on('fencerBTipExtension', (value) => setFencerDirectionTuning('B', { extensionMultiplier: value }));
appState.on('fencerALengthSmoothingAlpha', (value) => setFencerLengthSmoothingAlpha('A', 1 - value));
appState.on('fencerBLengthSmoothingAlpha', (value) => setFencerLengthSmoothingAlpha('B', 1 - value));
appState.on('fencerAWristWeight', (value) => setFencerDirectionTuning('A', { wristWeight: value }));
appState.on('fencerBWristWeight', (value) => setFencerDirectionTuning('B', { wristWeight: value }));
appState.on('fencerAAngleOffsetDeg', (value) => setFencerDirectionTuning('A', { angleOffsetDeg: value }));
appState.on('fencerBAngleOffsetDeg', (value) => setFencerDirectionTuning('B', { angleOffsetDeg: value }));
appState.on('fencerAWeaponArm', (value) => setFencerWeaponArm('A', value));
appState.on('fencerBWeaponArm', (value) => setFencerWeaponArm('B', value));

{
  const s = appState.get();
  setFencerWeaponArm('A', s.fencerAWeaponArm);
  setFencerWeaponArm('B', s.fencerBWeaponArm);
  setPoseTipExtension(s.poseTipExtension);
  setFencerDirectionTuning('A', {
    extensionMultiplier: s.fencerATipExtension,
    wristWeight: s.fencerAWristWeight,
    angleOffsetDeg: s.fencerAAngleOffsetDeg,
  });
  setFencerDirectionTuning('B', {
    extensionMultiplier: s.fencerBTipExtension,
    wristWeight: s.fencerBWristWeight,
    angleOffsetDeg: s.fencerBAngleOffsetDeg,
  });
  setFencerLengthSmoothingAlpha('A', 1 - s.fencerALengthSmoothingAlpha);
  setFencerLengthSmoothingAlpha('B', 1 - s.fencerBLengthSmoothingAlpha);
}
