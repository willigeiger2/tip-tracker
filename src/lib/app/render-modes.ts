// Render Modes
// The per-frame overlay drawing for each debug mode. Moved verbatim from index.astro; the
// function receives everything it needs so it has no hidden dependencies on page state.

import type { TrailRenderer, DebugRenderer } from '../renderer';
import { POSE_LANDMARKS, POSE_CONNECTIONS, HAND_LANDMARKS, HAND_CONNECTIONS } from '../unified-detector';
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
