// Render Modes
// The per-frame overlay drawing for each debug mode. Moved verbatim from index.astro; the
// function receives everything it needs so it has no hidden dependencies on page state.

import type { TrailRenderer, DebugRenderer } from '../renderer';
import { POSE_LANDMARKS, POSE_CONNECTIONS, HAND_LANDMARKS, HAND_CONNECTIONS } from '../unified-detector';
import { getFencerDirectionTuning, type TrackId } from '../tip-estimator';
import type { CoordinateMapper } from './coordinate-mapper';
import type { DebugMode, DetectionResult, Fencer, TrackingMode } from '../../types/fencing';

/** Long-lived drawing dependencies, created once at startup. */
export interface RenderContext {
  overlay: HTMLCanvasElement;
  trailRenderer: TrailRenderer;
  debugRenderer: DebugRenderer;
  mapToCanvas: CoordinateMapper;
}

/** Everything that changes frame to frame. */
export interface FrameData {
  trackingMode: TrackingMode;
  debugMode: DebugMode;
  fencers: Map<string, Fencer>;
  detections: DetectionResult[];
}

type PoseArmSide = 'left' | 'right';

type Direction2D = { x: number; y: number };

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeDirection(dx: number, dy: number): Direction2D | null {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: dx / len, y: dy / len };
}

function rotateDirection(dir: Direction2D, angleDeg: number): Direction2D {
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 1e-4) return dir;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: dir.x * cos - dir.y * sin,
    y: dir.x * sin + dir.y * cos,
  };
}

function selectPoseArmForDetection(detection: DetectionResult): PoseArmSide | null {
  if (detection.arm) {
    return detection.arm;
  }

  if (detection.refinement?.arm) {
    return detection.refinement.arm;
  }

  const leftWrist = detection.landmarks[POSE_LANDMARKS.LEFT_WRIST];
  const rightWrist = detection.landmarks[POSE_LANDMARKS.RIGHT_WRIST];

  if (!leftWrist && !rightWrist) return null;
  if (leftWrist && !rightWrist) return 'left';
  if (rightWrist && !leftWrist) return 'right';

  const tip = detection.tip;
  const leftDx = (leftWrist!.x ?? 0) - tip.x;
  const leftDy = (leftWrist!.y ?? 0) - tip.y;
  const rightDx = (rightWrist!.x ?? 0) - tip.x;
  const rightDy = (rightWrist!.y ?? 0) - tip.y;
  const leftDist = Math.sqrt(leftDx * leftDx + leftDy * leftDy);
  const rightDist = Math.sqrt(rightDx * rightDx + rightDy * rightDy);
  return leftDist <= rightDist ? 'left' : 'right';
}

function drawEstimatedBladeLine(
  overlay: HTMLCanvasElement,
  mapToCanvas: CoordinateMapper,
  detection: DetectionResult,
  color: string
): void {
  const arm = selectPoseArmForDetection(detection);
  if (!arm) return;

  const wrist =
    arm === 'left'
      ? detection.landmarks[POSE_LANDMARKS.LEFT_WRIST]
      : detection.landmarks[POSE_LANDMARKS.RIGHT_WRIST];
  const elbow =
    arm === 'left'
      ? detection.landmarks[POSE_LANDMARKS.LEFT_ELBOW]
      : detection.landmarks[POSE_LANDMARKS.RIGHT_ELBOW];
  if (!wrist || !elbow) return;

  const forearmDir = normalizeDirection(wrist.x - elbow.x, wrist.y - elbow.y);
  if (!forearmDir) return;

  const forearmLength = Math.sqrt(
    (wrist.x - elbow.x) * (wrist.x - elbow.x) + (wrist.y - elbow.y) * (wrist.y - elbow.y)
  );
  const trackId: TrackId = detection.id === 'B' ? 'B' : 'A';
  const tuning = getFencerDirectionTuning(trackId);
  const rawBladeLength = Math.max(0.03, forearmLength * tuning.extensionMultiplier);
  const smoothedBladeLength =
    typeof detection.smoothedExtensionLength === 'number' &&
    Number.isFinite(detection.smoothedExtensionLength)
      ? Math.max(0.03, detection.smoothedExtensionLength)
      : rawBladeLength;

  const forearmEnd = {
    x: clamp01(wrist.x + forearmDir.x * rawBladeLength),
    y: clamp01(wrist.y + forearmDir.y * rawBladeLength),
  };

  const index =
    arm === 'left'
      ? detection.landmarks[POSE_LANDMARKS.LEFT_INDEX]
      : detection.landmarks[POSE_LANDMARKS.RIGHT_INDEX];
  const thumb =
    arm === 'left'
      ? detection.landmarks[POSE_LANDMARKS.LEFT_THUMB]
      : detection.landmarks[POSE_LANDMARKS.RIGHT_THUMB];
  const pinky =
    arm === 'left'
      ? detection.landmarks[POSE_LANDMARKS.LEFT_PINKY]
      : detection.landmarks[POSE_LANDMARKS.RIGHT_PINKY];

  let wristHintDx = 0;
  let wristHintDy = 0;
  let wristHintWeight = 0;
  const addWristHint = (lm: { x: number; y: number; visibility?: number } | undefined, weight: number) => {
    if (!lm) return;
    if (lm.visibility !== undefined && lm.visibility < 0.2) return;
    wristHintDx += (lm.x - wrist.x) * weight;
    wristHintDy += (lm.y - wrist.y) * weight;
    wristHintWeight += weight;
  };
  addWristHint(index, 0.65);
  addWristHint(thumb, 0.25);
  addWristHint(pinky, 0.1);

  const wristDir =
    wristHintWeight > 0 ? normalizeDirection(wristHintDx / wristHintWeight, wristHintDy / wristHintWeight) : null;

  const wristEnd = wristDir
    ? {
        x: clamp01(wrist.x + wristDir.x * rawBladeLength),
        y: clamp01(wrist.y + wristDir.y * rawBladeLength),
      }
    : null;

  const wristWeight = clamp01(tuning.wristWeight);
  const forearmWeight = 1 - wristWeight;

  const unrotatedBlendDir = wristDir
    ? normalizeDirection(
        forearmDir.x * forearmWeight + wristDir.x * wristWeight,
        forearmDir.y * forearmWeight + wristDir.y * wristWeight
      )
    : forearmDir;
  const blendDir = unrotatedBlendDir ? rotateDirection(unrotatedBlendDir, tuning.angleOffsetDeg) : forearmDir;
  const blendEnd = blendDir
    ? {
        x: clamp01(wrist.x + blendDir.x * smoothedBladeLength),
        y: clamp01(wrist.y + blendDir.y * smoothedBladeLength),
      }
    : forearmEnd;

  const ctx = overlay.getContext('2d');
  if (!ctx) return;

  const wristPos = mapToCanvas(wrist.x, wrist.y);
  const forearmTipPos = mapToCanvas(forearmEnd.x, forearmEnd.y);
  const wristTipPos = wristEnd ? mapToCanvas(wristEnd.x, wristEnd.y) : null;
  const blendTipPos = mapToCanvas(blendEnd.x, blendEnd.y);

  const drawHypothesis = (
    tipPos: { x: number; y: number },
    stroke: string,
    lineWidth: number,
    label: string,
    dashed: boolean
  ) => {
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(wristPos.x, wristPos.y);
    ctx.lineTo(tipPos.x, tipPos.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.arc(tipPos.x, tipPos.y, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tipPos.x + 6, tipPos.y - 6);
    ctx.restore();
  };

  ctx.save();
  drawHypothesis(forearmTipPos, '#ffd64d', 2.2, 'F', true);
  if (wristTipPos) {
    drawHypothesis(wristTipPos, '#5dd7ff', 2.2, 'W', true);
  }
  drawHypothesis(blendTipPos, color, 3, 'B', false);

  ctx.fillStyle = '#ffffff';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(arm === 'left' ? 'L' : 'R', wristPos.x, wristPos.y - 6);
  ctx.restore();
}

/**
 * Draw the overlay for the current frame according to the selected debug mode.
 * Assumes the caller has already cleared the canvas; effects are drawn by the caller afterwards.
 */
export function renderFrame(context: RenderContext, frame: FrameData): void {
  const { overlay, trailRenderer, debugRenderer, mapToCanvas } = context;
  const { trackingMode, debugMode, fencers, detections } = frame;
  const isPoseLike = trackingMode === 'pose' || trackingMode === 'fencers';

  if (trackingMode === 'recorded') {
    // Recorded mode has no landmarks/skeletons; unsupported debug modes degrade to trails+tips.
    switch (debugMode) {
      case 'tips-only':
        trailRenderer.renderTipDots(fencers);
        return;
      case 'trails-only':
        trailRenderer.renderTrailsOnly(fencers);
        return;
      case 'heatmap':
        trailRenderer.renderTrails(fencers);
        return;
      default:
        trailRenderer.renderTrails(fencers);
        trailRenderer.renderTipDots(fencers);
        return;
    }
  }

  // Render based on debug mode
  switch (debugMode) {
    case 'none':
      trailRenderer.renderTrails(fencers);
      trailRenderer.renderTipDots(fencers);
      break;

    case 'landmarks':
      if (isPoseLike) {
        detections.forEach(detection => {
          const fencer = fencers.get(detection.id);
          debugRenderer.renderLandmarks(detection.landmarks, fencer?.color ?? '#00ff00');
        });
      } else {
        detections.forEach(detection => {
          const fencer = fencers.get(detection.id);
          debugRenderer.renderLandmarks(detection.landmarks, fencer?.color ?? '#00ffff');
        });
      }
      break;

    case 'skeleton':
      if (isPoseLike) {
        detections.forEach(detection => {
          const fencer = fencers.get(detection.id);
          debugRenderer.renderSkeleton(detection.landmarks, POSE_CONNECTIONS, fencer?.color ?? '#00ff00');
          if (trackingMode === 'fencers' && fencer) {
            drawEstimatedBladeLine(overlay, mapToCanvas, detection, fencer.color);
          }
        });
      } else {
        detections.forEach(detection => {
          const fencer = fencers.get(detection.id);
          debugRenderer.renderSkeleton(detection.landmarks, HAND_CONNECTIONS, fencer?.color ?? '#00ffff');
        });
      }
      break;

    case 'vectors':
      if (isPoseLike) {
        detections.forEach(detection => {
          const lm = detection.landmarks;
          const wrist = lm[POSE_LANDMARKS.RIGHT_WRIST];
          const elbow = lm[POSE_LANDMARKS.RIGHT_ELBOW];
          if (wrist && elbow && detection.tip) {
            const fencer = fencers.get(detection.id);
            if (fencer) {
              // Use new hand-starting vector for Pose mode
              debugRenderer.renderVectors(wrist, elbow, detection.tip, fencer.color, true);
            }
          }
        });
      } else {
        const ctx = overlay.getContext('2d')!;
        
        ctx.save();
        detections.forEach(detection => {
          const lm = detection.landmarks;
          const wrist = lm[HAND_LANDMARKS.WRIST];
          const indexMcp = lm[HAND_LANDMARKS.INDEX_FINGER_MCP];
          const tip = lm[HAND_LANDMARKS.INDEX_FINGER_TIP];
          const fencer = fencers.get(detection.id);
          
          if (wrist && indexMcp && tip && fencer) {
            // Use mapToCanvas for coordinate transformation
            const wristPos = mapToCanvas(wrist.x, wrist.y);
            const mcpPos = mapToCanvas(indexMcp.x, indexMcp.y);
            const tipPos = mapToCanvas(tip.x, tip.y);
            
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(wristPos.x, wristPos.y);
            ctx.lineTo(mcpPos.x, mcpPos.y);
            ctx.stroke();
            
            ctx.strokeStyle = fencer.color;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(mcpPos.x, mcpPos.y);
            ctx.lineTo(tipPos.x, tipPos.y);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.fillStyle = fencer.color;
            ctx.beginPath();
            ctx.arc(tipPos.x, tipPos.y, 6, 0, Math.PI * 2);
            ctx.fill();
          }
        });
        ctx.restore();
      }
      
      // Draw calibration grid in vectors mode to help diagnose alignment
      drawCalibrationGrid(overlay, mapToCanvas);
      break;

    case 'tips-only':
      trailRenderer.renderTipDots(fencers);
      break;

    case 'trails-only':
      trailRenderer.renderTrailsOnly(fencers);
      break;

    case 'lightsaber':
      detections.forEach(detection => {
        const fencer = fencers.get(detection.id);
        if (!fencer) return;

        if (isPoseLike) {
          const wrist = detection.landmarks[POSE_LANDMARKS.RIGHT_WRIST];
          if (wrist && detection.tip) {
            debugRenderer.renderLightsaber(wrist, detection.tip, fencer.color);
          }
        } else {
          const indexMcp = detection.landmarks[HAND_LANDMARKS.INDEX_FINGER_MCP];
          if (indexMcp && detection.tip) {
            debugRenderer.renderLightsaber(indexMcp, detection.tip, fencer.color);
          }
        }
      });
      break;

    case 'heatmap':
      trailRenderer.renderTrails(fencers);
      break;

    case 'all':
      if (isPoseLike) {
        detections.forEach(detection => {
          const fencer = fencers.get(detection.id);
          debugRenderer.renderLandmarks(detection.landmarks, fencer?.color ?? '#00ff00');
          debugRenderer.renderSkeleton(detection.landmarks, POSE_CONNECTIONS, fencer?.color ?? '#00ff00');
          if (trackingMode === 'fencers' && fencer) {
            drawEstimatedBladeLine(overlay, mapToCanvas, detection, fencer.color);
          }
        });
      } else {
        detections.forEach(detection => {
          const fencer = fencers.get(detection.id);
          debugRenderer.renderLandmarks(detection.landmarks, fencer?.color ?? '#00ffff');
          debugRenderer.renderSkeleton(detection.landmarks, HAND_CONNECTIONS, fencer?.color ?? '#00ffff');
        });
      }
      trailRenderer.renderTrails(fencers);
      trailRenderer.renderTipDots(fencers);
      break;
  }
}

/**
 * Draw a 10% grid plus the mapped video corners (TL/TR/BL/BR) to diagnose alignment issues.
 */
export function drawCalibrationGrid(overlay: HTMLCanvasElement, mapToCanvas: CoordinateMapper): void {
  const ctx = overlay.getContext('2d')!;
  const width = overlay.width;
  const height = overlay.height;
  
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  
  // Draw 10% grid lines
  for (let i = 1; i < 10; i++) {
    const x = (width * i) / 10;
    const y = (height * i) / 10;
    
    // Vertical lines
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    
    // Horizontal lines
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  
  // Draw corner markers at mapped video corners
  const tl = mapToCanvas(0, 0);
  const tr = mapToCanvas(1, 0);
  const bl = mapToCanvas(0, 1);
  const br = mapToCanvas(1, 1);
  
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  
  // Draw video bounds
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.stroke();
  
  // Draw corner markers
  const corners = [tl, tr, bl, br];
  corners.forEach((corner, i) => {
    ctx.fillStyle = '#00ffff';
    ctx.beginPath();
    ctx.arc(corner.x, corner.y, 8, 0, Math.PI * 2);
    ctx.fill();
    
    // Label
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px monospace';
    const labels = ['TL', 'TR', 'BL', 'BR'];
    ctx.fillText(labels[i], corner.x + 10, corner.y - 10);
  });
  
  ctx.restore();
}
