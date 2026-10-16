// Recorded (keyframed) tracks for the current video: loading, editing, autosave, import/export.

import { buildRecordedFrameSnapshot } from '../recorded/playback';
import { inRanges, mergeDraftKeyframes, type TimeRange } from '../recorded/auto-seed';
import {
  createEmptyTrackSet,
  exportTrackSetToJson,
  importTrackSetFromJson,
  keyframeCount,
  loadTrackSet,
  saveTrackSet,
  trackSetToSummary,
} from '../recorded/track-store';
import type { Hit, Keyframe, RecordedTrackSet } from '../recorded/types';
import { removeHit, toggleHitAtFrame } from '../recorded/hits';
import { fetchTrackSetFromKv, saveTrackSetToKv } from '../recorded/kv-client';
import {
  deleteKeyframeAtFrame,
  keyframeAtFrame,
  nearestNeighborFrames,
  upsertKeyframeAtFrame,
} from '../recorded/keyframes';
import { deriveVideoId } from '../recorded/video-id';
import { frameIndex, seekTimeForFrame } from '../app/frame-rate';
import {
  appState,
  clearTrails,
  events,
  isVideoSource,
  session,
  setRecordedFrameProvider,
  video,
  type TrackId,
} from './app';
import { downloadJson } from './download';
import { formatClockTime } from './format';
import { upsertSummary } from './library';

export type AutoAdvanceMode = 0 | 1 | 2 | 5 | 10 | 'next';
const AUTO_ADVANCE_FRAME_VALUES: Array<Exclude<AutoAdvanceMode, 'next'>> = [0, 1, 2, 5, 10];
const AUTO_ADVANCE_STORAGE_KEY = 'tiptrack:v1:editor:auto-advance';
const AUTOSAVE_MS = 500;

let trackSet: RecordedTrackSet | null = null;
let activeTrack: TrackId = 'A';
let editMode = false;
let autoAdvanceMode: AutoAdvanceMode = parseAutoAdvanceMode(localStorage.getItem(AUTO_ADVANCE_STORAGE_KEY)) ?? 2;
let saveTimer: number | null = null;
let saveSequence = 0;
let statusNote: string | null = null;

export function parseAutoAdvanceMode(raw: string | null): AutoAdvanceMode | null {
  if (raw === 'next') return 'next';
  const value = Number.parseInt(raw ?? '', 10);
  if (AUTO_ADVANCE_FRAME_VALUES.includes(value as Exclude<AutoAdvanceMode, 'next'>)) {
    return value as Exclude<AutoAdvanceMode, 'next'>;
  }
  return null;
}

function changed(): void {
  events.emit('recorded');
}

// ---- Accessors ----

export function getTrackSet(): RecordedTrackSet | null {
  return trackSet;
}

export function getActiveTrack(): TrackId {
  return activeTrack;
}

export function setActiveTrack(track: TrackId): void {
  activeTrack = track;
  changed();
}

export function isEditMode(): boolean {
  return editMode;
}

export function setEditMode(enabled: boolean): void {
  editMode = enabled;
  changed();
}

export function getAutoAdvanceMode(): AutoAdvanceMode {
  return autoAdvanceMode;
}

export function setAutoAdvanceMode(mode: AutoAdvanceMode): void {
  autoAdvanceMode = mode;
  localStorage.setItem(AUTO_ADVANCE_STORAGE_KEY, String(mode));
}

export function isRecordedPanelVisible(): boolean {
  return isVideoSource() && appState.get().trackingMode === 'recorded';
}

export function isEditorActive(): boolean {
  return isRecordedPanelVisible() && editMode && trackSet !== null;
}

/** Frame math always uses the video's reported fps (or the manual override). */
export function getRecordedFps(): number {
  return session.transportFps;
}

/**
 * Keep the stored fps of the loaded track set equal to the video's fps. Keyframes are stored
 * by time, so this only changes frame numbering. Persisted with the next save.
 */
function syncTrackSetFps(): void {
  if (!trackSet || session.transportFpsApproximate) return;
  trackSet.fps = session.transportFps;
}

export function getTrack(trackId: TrackId) {
  return trackSet?.tracks.find((track) => track.id === trackId) ?? null;
}

function replaceTrack(trackId: TrackId, nextTrack: NonNullable<ReturnType<typeof getTrack>>): void {
  if (!trackSet) return;
  trackSet.tracks = trackSet.tracks.map((track) => (track.id === trackId ? nextTrack : track));
}

export function activeTrackHasKeyframes(): boolean {
  const track = getTrack(activeTrack);
  return appState.get().trackingMode === 'recorded' && !!track && track.keyframes.length > 0;
}

// ---- Status ----

/** Publish the recorded status line: a one-off message, or the computed summary. */
export function publishStatus(customMessage?: string): void {
  if (customMessage) {
    events.emit('recorded-status', customMessage);
    return;
  }
  if (!isVideoSource()) {
    events.emit('recorded-status', 'Recorded mode is available in video source only.');
    return;
  }
  if (!trackSet) {
    events.emit('recorded-status', 'No recorded keyframes loaded.');
    return;
  }
  const count = keyframeCount(trackSet);
  const base = `${count} keyframe${count === 1 ? '' : 's'} loaded for playback.`;
  events.emit('recorded-status', statusNote ? `${base} ${statusNote}` : base);
}

// ---- Persistence ----

async function flushAutosave(sequence: number): Promise<void> {
  if (!trackSet) return;

  const snapshot = JSON.parse(JSON.stringify(trackSet)) as RecordedTrackSet;
  const snapshotVideoId = snapshot.videoId;
  saveTrackSet(snapshot);

  try {
    const saved = await saveTrackSetToKv(snapshot);
    if (sequence !== saveSequence) return;
    if (!trackSet || saved.videoId !== trackSet.videoId) return;

    trackSet = saved;
    saveTrackSet(saved, { touchUpdatedAt: false });
    upsertSummary(trackSetToSummary(saved));
    statusNote = `Saved ${formatClockTime(saved.updatedAt)}`;
  } catch (error) {
    if (sequence !== saveSequence) return;
    if (!trackSet || trackSet.videoId !== snapshotVideoId) return;
    console.warn('Failed to save track set to KV:', error);
    statusNote = 'Saved locally (offline).';
  }

  if (sequence === saveSequence && trackSet && trackSet.videoId === snapshotVideoId) {
    publishStatus();
  }
}

export function scheduleAutosave(delayMs = AUTOSAVE_MS): void {
  if (!trackSet) return;

  statusNote = 'Unsaved changes...';
  publishStatus();

  const sequence = ++saveSequence;
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushAutosave(sequence);
  }, delayMs);
}

/** Load the track set for `url` (KV, then localStorage, then empty). */
export async function loadOrCreateTrackSet(url: string): Promise<void> {
  const videoId = deriveVideoId(url);
  session.currentVideoId = videoId;
  session.currentVideoUrl = url;

  const local = loadTrackSet(videoId, url, session.transportFps);
  let remote: RecordedTrackSet | null = null;
  let remoteUnavailable = false;
  try {
    remote = await fetchTrackSetFromKv(videoId);
  } catch (error) {
    remoteUnavailable = true;
    console.warn('Failed to load track set from KV, falling back to local store:', error);
  }

  if (remote) {
    upsertSummary(trackSetToSummary(remote));
  }

  const chosen =
    remote && local
      ? remote.updatedAt >= local.updatedAt
        ? remote
        : local
      : remote ?? local ?? createEmptyTrackSet(videoId, url, session.transportFps, 1.0);

  chosen.videoId = videoId;
  chosen.videoUrl = url;
  trackSet = chosen;
  syncTrackSetFps();
  saveTrackSet(trackSet, { touchUpdatedAt: false });

  if (remote && local) {
    statusNote =
      remote.updatedAt >= local.updatedAt ? 'Loaded from library.' : 'Loaded local copy (newer than library).';
  } else if (remote) {
    statusNote = 'Loaded from library.';
  } else if (local && remoteUnavailable) {
    statusNote = 'Loaded local copy (library unavailable).';
  } else {
    statusNote = null;
  }

  activeTrack = 'A';
  changed();
  events.emit('track-set-loaded');
  publishStatus();
}

/** Drop the current track set (source switch). Cancels any pending autosave. */
export function resetForSourceSwitch(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  trackSet = null;
  statusNote = null;
  editMode = false;
  changed();
}

/**
 * Import a track-set JSON string for the current video. Returns false (and publishes
 * `failMessage`) when nothing was imported.
 */
export function importTrackSet(text: string, successMessage: string, failMessage: string): boolean {
  if (!session.currentVideoId || !session.currentVideoUrl) {
    publishStatus('Load a video first.');
    return false;
  }

  const imported = importTrackSetFromJson(text, session.currentVideoId, session.currentVideoUrl, session.transportFps);
  if (!imported) {
    publishStatus(failMessage);
    return false;
  }

  imported.videoId = session.currentVideoId;
  imported.videoUrl = session.currentVideoUrl;
  imported.fps = imported.fps || session.transportFps;
  trackSet = imported;
  statusNote = null;
  scheduleAutosave(0);
  changed();
  clearTrails();
  publishStatus(successMessage);
  return true;
}

function exportFilenameForVideo(url: string, fallbackId: string): string {
  try {
    const parsed = new URL(url);
    const base = `${parsed.hostname}${parsed.pathname}`
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 140)
      .replace(/^_+|_+$/g, '');
    if (base) return `tiptrack-${base}.json`;
  } catch {
    // Fall through to id-based name.
  }
  return `tiptrack-${fallbackId}.json`;
}

export function exportTrackSet(): void {
  if (!trackSet || !session.currentVideoId) {
    publishStatus('Nothing to export yet.');
    return;
  }
  downloadJson(exportTrackSetToJson(trackSet), exportFilenameForVideo(session.currentVideoUrl, session.currentVideoId));
  publishStatus('Exported recorded track set.');
}

/** Range-edge padding when replacing keyframes with a draft: half a frame. */
function draftPadSeconds(fps: number): number {
  return 0.5 / Math.max(1, fps);
}

/** Existing keyframes (both tracks) that a draft over `ranges` would replace. */
export function keyframesInRanges(ranges: readonly TimeRange[], fps: number): number {
  if (!trackSet) return 0;
  const pad = draftPadSeconds(fps);
  return trackSet.tracks.reduce(
    (sum, track) => sum + track.keyframes.filter((kf) => inRanges(kf.time, ranges, pad)).length,
    0
  );
}

/**
 * Merge an auto-seeded draft into both tracks: existing keyframes inside the captured time
 * ranges are replaced; keyframes outside them (e.g. earlier hand corrections) are kept.
 */
export function applyDraft(
  a: Keyframe[],
  b: Keyframe[],
  options: { fps: number; ranges: readonly TimeRange[]; maxGapSeconds?: number; note: string }
): void {
  if (!session.currentVideoId || !session.currentVideoUrl) return;
  const base = trackSet ?? createEmptyTrackSet(session.currentVideoId, session.currentVideoUrl, options.fps, 1.0);
  trackSet = {
    ...base,
    videoId: session.currentVideoId,
    videoUrl: session.currentVideoUrl,
    fps: options.fps,
    maxGapSeconds: options.maxGapSeconds ?? base.maxGapSeconds,
    tracks: base.tracks.map((track) => {
      const draft = track.id === 'A' ? a : track.id === 'B' ? b : null;
      if (!draft) return track;
      const merged = mergeDraftKeyframes(track.keyframes, draft, options.ranges, draftPadSeconds(options.fps));
      return { ...track, keyframes: merged.keyframes };
    }),
  };
  statusNote = options.note;
  editMode = false;
  scheduleAutosave(0);
  changed();
  publishStatus();
}

/** Set the fps stored with the track set (follows the video's fps; saves only on change). */
export function setTrackSetFps(fps: number): void {
  if (!trackSet || trackSet.fps === fps) return;
  trackSet.fps = fps;
  scheduleAutosave(0);
  changed();
}

// ---- Frame navigation ----

export function currentFrame(): number {
  return frameIndex(video.currentTime, getRecordedFps());
}

export function seekToFrame(frame: number): void {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  video.currentTime = seekTimeForFrame(frame, getRecordedFps(), duration);
}

export function jumpToFrame(frame: number): void {
  video.pause();
  seekToFrame(frame);
}

function stepFrames(delta: number): void {
  video.pause();
  seekToFrame(currentFrame() + delta);
}

export function jumpNeighborKeyframe(direction: -1 | 1): void {
  const track = getTrack(activeTrack);
  if (!track) return;
  const neighbors = nearestNeighborFrames(track, currentFrame(), getRecordedFps());
  const target = direction < 0 ? neighbors.previous : neighbors.next;
  if (!target) return;
  video.pause();
  seekToFrame(target.frame);
}

export function applyAutoAdvance(): void {
  if (autoAdvanceMode === 'next') {
    jumpNeighborKeyframe(1);
    return;
  }
  if (autoAdvanceMode > 0) {
    stepFrames(autoAdvanceMode);
  }
}

// ---- Keyframe editing ----

export function upsertActiveKeyframe(x: number, y: number): void {
  const track = getTrack(activeTrack);
  if (!track) return;
  replaceTrack(activeTrack, upsertKeyframeAtFrame(track, currentFrame(), x, y, getRecordedFps()));
  changed();
  scheduleAutosave();
}

export function deleteActiveKeyframeAtCurrentFrame(): boolean {
  const track = getTrack(activeTrack);
  if (!track) return false;

  const frame = currentFrame();
  if (!keyframeAtFrame(track, frame, getRecordedFps())) return false;

  replaceTrack(activeTrack, deleteKeyframeAtFrame(track, frame, getRecordedFps()));
  changed();
  scheduleAutosave();
  return true;
}

export function deleteActiveKeyframeAtFrame(frame: number): void {
  const track = getTrack(activeTrack);
  if (!track) return;
  replaceTrack(activeTrack, deleteKeyframeAtFrame(track, frame, getRecordedFps()));
  changed();
  scheduleAutosave();
}

export function activeTrackLabel(): string {
  return activeTrack === 'A' ? 'Track A (green)' : 'Track B (red)';
}

// ---- Hits ----

export function getHits(): readonly Hit[] {
  return trackSet?.hits ?? [];
}

/** Toggle a hit for the active track at the current frame (X). Returns true if added. */
export function toggleActiveHitAtCurrentFrame(): boolean {
  if (!trackSet) return false;
  const result = toggleHitAtFrame(getHits(), activeTrack, currentFrame(), getRecordedFps());
  trackSet.hits = result.hits;
  changed();
  scheduleAutosave();
  publishStatus(`${result.added ? 'Added' : 'Removed'} hit for ${activeTrackLabel()} at f${currentFrame()}.`);
  return result.added;
}

export function deleteHit(hit: Hit): void {
  if (!trackSet) return;
  trackSet.hits = removeHit(getHits(), hit);
  changed();
  scheduleAutosave();
}

export function clearActiveTrack(): void {
  const track = getTrack(activeTrack);
  if (!track) return;
  replaceTrack(activeTrack, { ...track, keyframes: [] });
  changed();
  scheduleAutosave();
  publishStatus(`Cleared ${activeTrackLabel()}.`);
}

// ---- Playback ----

/** Trails and tips of the loaded track set at `mediaTime` (used by playback and MP4 export). */
export function recordedSnapshotAt(mediaTime: number, timestamp: number, trailSamples: number) {
  if (!trackSet) return null;
  const trailWindowSeconds = Math.max(0.25, trailSamples / Math.max(1, trackSet.fps));
  return buildRecordedFrameSnapshot(trackSet, mediaTime, timestamp, trailSamples, trailWindowSeconds);
}

setRecordedFrameProvider((mediaTime, timestamp, trailSamples) => {
  if (appState.get().trackingMode !== 'recorded') return null;
  return recordedSnapshotAt(mediaTime, timestamp, trailSamples);
});
