// Overlay passes drawn after the main render: fencers debug labels and the recorded keyframe
// editor (onion-skin markers, interpolated path, current-frame marker).

import { sampleTrackAt } from '../recorded/interpolator';
import { nearestNeighborFrames } from '../recorded/keyframes';
import type { FrameData } from '../app/render-modes';
import { appState, mapToCanvas, video } from './app';
import { currentFrame, getActiveTrack, getRecordedFps, getTrack, getTrackSet, isEditorActive } from './recorded';
import { hitColor, hitOrigin } from './hit-effects';
import { listHitsWithFrames } from '../recorded/hits';

let showFencersDebugOverlay = false;

export function setFencersDebugOverlay(enabled: boolean): void {
  showFencersDebugOverlay = enabled;
}

export function isFencersDebugOverlayEnabled(): boolean {
  return showFencersDebugOverlay;
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
}

export function drawFencersDebugOverlay(overlayCanvas: HTMLCanvasElement, frame: FrameData): void {
  if (frame.trackingMode !== 'fencers') return;
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;

  const lengthDiagnostics = new Map<'A' | 'B', { raw: number; smooth: number; delta: number }>();
  for (const detection of frame.detections) {
    const raw = detection.rawExtensionLength;
    const smooth = detection.smoothedExtensionLength;
    if (typeof raw !== 'number' || typeof smooth !== 'number') continue;
    if (!Number.isFinite(raw) || !Number.isFinite(smooth)) continue;
    const id: 'A' | 'B' = detection.id === 'B' ? 'B' : 'A';
    lengthDiagnostics.set(id, { raw, smooth, delta: Math.abs(raw - smooth) });
  }

  if (frame.debugMode === 'skeleton' || frame.debugMode === 'all') {
    const state = appState.get();
    const aExt = state.fencerATipExtension.toFixed(1);
    const bExt = state.fencerBTipExtension.toFixed(1);
    const aSmooth = state.fencerALengthSmoothingAlpha.toFixed(2);
    const bSmooth = state.fencerBLengthSmoothingAlpha.toFixed(2);
    const aAlpha = (1 - state.fencerALengthSmoothingAlpha).toFixed(2);
    const bAlpha = (1 - state.fencerBLengthSmoothingAlpha).toFixed(2);
    const aWrist = Math.round(state.fencerAWristWeight * 100);
    const bWrist = Math.round(state.fencerBWristWeight * 100);
    const aAngle = Math.round(state.fencerAAngleOffsetDeg);
    const bAngle = Math.round(state.fencerBAngleOffsetDeg);
    const aDiag = lengthDiagnostics.get('A');
    const bDiag = lengthDiagnostics.get('B');
    const aLen = aDiag
      ? `L${aDiag.raw.toFixed(3)}->${aDiag.smooth.toFixed(3)} d${aDiag.delta.toFixed(3)}`
      : 'L--';
    const bLen = bDiag
      ? `L${bDiag.raw.toFixed(3)}->${bDiag.smooth.toFixed(3)} d${bDiag.delta.toFixed(3)}`
      : 'L--';
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(10, 10, 560, 54);
    ctx.fillStyle = '#f4f4f4';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Blade lines: F=Forearm W=Wrist B=Blend+Angle', 16, 21);
    ctx.fillText(
      `A E${aExt}x S${aSmooth}/a${aAlpha} W${aWrist}% A${aAngle}deg | B E${bExt}x S${bSmooth}/a${bAlpha} W${bWrist}% A${bAngle}deg`,
      16,
      36
    );
    ctx.fillText(`A ${aLen} | B ${bLen}`, 16, 50);
    ctx.restore();
  }

  for (const detection of frame.detections) {
    const color = detection.id === 'B' ? '#ff4d5a' : '#36d67a';
    const confidence = Math.round(detection.tip.confidence * 100);
    const confidenceLabel = `${confidence}%`;
    const armSide = detection.arm;
    const arm = armSide ? armSide[0].toUpperCase() : '?';
    const armMarginLabel =
      typeof detection.armMargin === 'number' ? ` m${detection.armMargin.toFixed(3)}` : '';
    const rawLen = detection.rawExtensionLength;
    const smoothLen = detection.smoothedExtensionLength;
    const delta =
      typeof rawLen === 'number' &&
      typeof smoothLen === 'number' &&
      Number.isFinite(rawLen) &&
      Number.isFinite(smoothLen)
        ? Math.abs(rawLen - smoothLen)
        : null;
    const lenLabel =
      delta !== null && typeof rawLen === 'number' && typeof smoothLen === 'number'
        ? ` L${rawLen.toFixed(3)}->${smoothLen.toFixed(3)} d${delta.toFixed(3)}`
        : '';
    const label =
      `${detection.id} ${arm}${armMarginLabel} ${confidenceLabel}${lenLabel}`;
    const labelAnchor = mapToCanvas(detection.tip.x, detection.tip.y);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.95;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, labelAnchor.x + 7, labelAnchor.y - 8);
    ctx.restore();
  }
}

export function drawRecordedEditorOverlay(overlayCanvas: HTMLCanvasElement): void {
  const recordedTrackSet = getTrackSet();
  if (!isEditorActive() || !recordedTrackSet) return;
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;

  const frame = currentFrame();
  const fps = getRecordedFps();

  const activeTrack = getTrack(getActiveTrack());
  if (activeTrack) {
    const activeNeighbors = nearestNeighborFrames(activeTrack, frame, fps);
    const start = activeNeighbors.previous ?? activeNeighbors.current;
    const end = activeNeighbors.next ?? activeNeighbors.current;
    if (start && end && end.time > start.time) {
      const points: Array<{ x: number; y: number }> = [];
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const t = start.time + ((end.time - start.time) * i) / steps;
        const sample = sampleTrackAt(activeTrack, t, {
          fps,
          maxGapSeconds: recordedTrackSet.maxGapSeconds,
        });
        if (!sample) continue;
        points.push(mapToCanvas(sample.x, sample.y));
      }

      if (points.length >= 2) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
        ctx.restore();
      }
    } else if (activeNeighbors.previous && activeNeighbors.next) {
      const p = mapToCanvas(activeNeighbors.previous.x, activeNeighbors.previous.y);
      const n = mapToCanvas(activeNeighbors.next.x, activeNeighbors.next.y);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
      ctx.restore();
    }

    if (!activeNeighbors.current) {
      const interpolated = sampleTrackAt(activeTrack, video.currentTime, {
        fps,
        maxGapSeconds: recordedTrackSet.maxGapSeconds,
      });
      if (interpolated) {
        const point = mapToCanvas(interpolated.x, interpolated.y);
        ctx.save();
        ctx.fillStyle = activeTrack.color;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  (['A', 'B'] as const).forEach((trackId) => {
    const track = getTrack(trackId);
    if (!track) return;

    const neighbors = nearestNeighborFrames(track, frame, fps);
    const items = [
      { kind: 'previous' as const, keyframe: neighbors.previous },
      { kind: 'next' as const, keyframe: neighbors.next },
      { kind: 'current' as const, keyframe: neighbors.current },
    ];

    for (const item of items) {
      if (!item.keyframe) continue;
      const pos = mapToCanvas(item.keyframe.x, item.keyframe.y);
      const isActiveTrack = trackId === getActiveTrack();
      const alpha = isActiveTrack
        ? item.kind === 'current'
          ? 0.95
          : item.kind === 'previous'
            ? 0.72
            : 0.56
        : 0.35;
      const size = item.kind === 'current' ? 7 : 5;

      ctx.save();
      ctx.fillStyle = track.color;
      ctx.globalAlpha = alpha;
      drawDiamond(ctx, pos.x, pos.y, size);
      ctx.fill();

      if (isActiveTrack && item.kind !== 'current') {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(item.kind === 'previous' ? 'P' : 'N', pos.x, pos.y - size - 3);
      }

      if (item.kind === 'current' && isActiveTrack) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
}


/** Editor marker for hits on the current frame: a ring at the scoring tip and a HIT label. */
export function drawHitMarkers(overlayCanvas: HTMLCanvasElement): void {
  const set = getTrackSet();
  if (!set?.hits?.length) return;
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;
  const frame = currentFrame();
  const hits = listHitsWithFrames(set.hits, getRecordedFps()).filter((h) => h.frame === frame);
  hits.forEach((hit, index) => {
    const color = hitColor(set, hit);
    const origin = hitOrigin(set, hit);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    if (origin) {
      const p = mapToCanvas(origin.x, origin.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`HIT ${hit.trackId}`, p.x, p.y - 20 - index * 16);
    } else {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`HIT ${hit.trackId} (no tip)`, 12, 12 + index * 18);
    }
    ctx.restore();
  });
}
