// Trail Manager Module
// Manages trail buffers for fencers with ring buffer implementation

import type { Fencer, TrailPoint, TipPosition, TrailConfig } from '../types/fencing';

// Default configuration
export const DEFAULT_TRAIL_CONFIG: TrailConfig = {
  maxLength: 30,
  fadeMode: 'linear',
  glowIntensity: 1.0,
  lineWidth: 6,
};

// Fade speed: how quickly trails fade out when no new detections (opacity per frame at 60fps)
const FADE_SPEED = 0.02;

export class TrailManager {
  private fencers: Map<string, Fencer>;
  private config: TrailConfig;
  private lastTips: Map<string, TipPosition> = new Map();
  private lastDetectionTime: number = 0;

  constructor(config: Partial<TrailConfig> = {}) {
    this.config = { ...DEFAULT_TRAIL_CONFIG, ...config };

    // Initialize fencers
    this.fencers = new Map([
      ['A', {
        id: 'A',
        side: 'left',
        color: '#00ff00', // green
        tip: null,
        trail: []
      }],
      ['B', {
        id: 'B',
        side: 'right',
        color: '#ff0000', // red
        tip: null,
        trail: []
      }],
    ]);
  }

  // Distance threshold for matching detections to existing fencers (normalized coords)
  private static readonly PROXIMITY_THRESHOLD = 0.5; // 50% of screen width/height (was 30%)

  /**
   * Assign detections to fencers using proximity-based tracking
   * Existing fencers "stick" to their identity even if they cross sides
   * Only uses position-based assignment for new/unmatched detections
   */
  private assignFencersByProximity(
    detections: Map<string, TipPosition>
  ): Map<string, TipPosition> {
    const assigned = new Map<string, TipPosition>();
    const unassigned = new Map(detections);

    // Get last known positions for each fencer
    const lastPositions = new Map<string, TipPosition>();
    this.fencers.forEach((fencer, id) => {
      if (fencer.tip) {
        lastPositions.set(id, fencer.tip);
      } else if (fencer.trail.length > 0) {
        // Use most recent trail point if no current tip
        const lastPoint = fencer.trail[fencer.trail.length - 1];
        lastPositions.set(id, {
          x: lastPoint.x,
          y: lastPoint.y,
          z: lastPoint.z,
          confidence: 1,
          timestamp: lastPoint.timestamp,
          side: fencer.side,
        });
      }
    });

    // First pass: match detections to existing fencers by proximity
    const matchedDetections = new Set<string>();
    const matchedFencers = new Set<string>();

    lastPositions.forEach((lastPos, fencerId) => {
      let bestMatch: string | null = null;
      let bestDistance = Infinity;

      unassigned.forEach((detection, detectionId) => {
        const dx = detection.x - lastPos.x;
        const dy = detection.y - lastPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < TrailManager.PROXIMITY_THRESHOLD && distance < bestDistance) {
          bestDistance = distance;
          bestMatch = detectionId;
        }
      });

      if (bestMatch) {
        const detection = unassigned.get(bestMatch)!;
        assigned.set(fencerId, detection);
        matchedDetections.add(bestMatch);
        matchedFencers.add(fencerId);
        unassigned.delete(bestMatch);
      }
    });

    // Second pass: assign remaining detections by position (new fencers)
    const remaining = Array.from(unassigned.values());
    
    if (remaining.length > 0) {
      // Multiple detections - sort by position and assign
      remaining.sort((a, b) => a.x - b.x);

      remaining.forEach((detection, index) => {
        // Determine target based on position and availability
        const onLeft = detection.x < 0.5;
        const aAvailable = !assigned.has('A');
        const bAvailable = !assigned.has('B');

        if (onLeft && aAvailable) {
          assigned.set('A', detection);
        } else if (!onLeft && bAvailable) {
          assigned.set('B', detection);
        } else if (aAvailable) {
          assigned.set('A', detection);
        } else if (bAvailable) {
          assigned.set('B', detection);
        }
      });
    }
    
    // Single detection case: if only one detection and fencer A is available, use A
    // This prevents color switching in single-fencer scenarios without breaking two-fencer mode
    if (remaining.length === 1 && !assigned.has('A')) {
      assigned.set('A', remaining[0]);
    }

    return assigned;
  }

  /**
   * Update tip positions from detection
   * Call this when new pose detection results arrive
   * Uses proximity tracking to maintain fencer identity across frames
   */
  updateTips(detections: Map<string, TipPosition>, timestamp: number): void {
    this.lastDetectionTime = timestamp;

    // Assign detections to fencers using proximity-based tracking
    const assigned = this.assignFencersByProximity(detections);
    this.applyAssignedTips(assigned, timestamp);
  }

  /**
   * Update tips using explicit fencer IDs (A/B) from upstream tracking.
   * Use this when IDs have already been associated and should not be re-matched by proximity.
   */
  updateTipsById(detections: Map<string, TipPosition>, timestamp: number): void {
    this.lastDetectionTime = timestamp;

    const assigned = new Map<string, TipPosition>();
    detections.forEach((tip, id) => {
      if (this.fencers.has(id)) {
        assigned.set(id, tip);
      }
    });

    this.applyAssignedTips(assigned, timestamp);
  }

  private applyAssignedTips(assigned: Map<string, TipPosition>, timestamp: number): void {

    // Track which fencers received new points this frame
    const updatedFencers = new Set<string>();

    assigned.forEach((tip, fencerId) => {
      const fencer = this.fencers.get(fencerId);
      if (!fencer) return;

      updatedFencers.add(fencerId);

      // Store previous tip for interpolation
      const prevTip = this.lastTips.get(fencerId);
      if (prevTip) {
        tip.prevX = prevTip.x;
        tip.prevY = prevTip.y;
      }

      this.lastTips.set(fencerId, tip);
      fencer.tip = tip;

      // Calculate velocity for heatmap mode
      let velocity = 0;
      if (prevTip) {
        const dx = tip.x - prevTip.x;
        const dy = tip.y - prevTip.y;
        const dt = timestamp - prevTip.timestamp;
        velocity = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt * 1000 : 0;
      }

      // Add to trail buffer with full opacity
      fencer.trail.push({
        x: tip.x,
        y: tip.y,
        z: tip.z,
        timestamp,
        velocity,
        opacity: 1.0,
      });

      // Trim to max length (ring buffer behavior)
      if (fencer.trail.length > this.config.maxLength) {
        fencer.trail.shift();
      }
    });

    // Fade trails for fencers not detected in this frame
    this.fencers.forEach((fencer, id) => {
      if (!updatedFencers.has(id)) {
        fencer.tip = null;
        // Gradually fade out the trail points
        fencer.trail = fencer.trail.filter(point => {
          point.opacity -= FADE_SPEED;
          return point.opacity > 0;
        });
      }
    });
  }

  /**
   * Continue fading trails even when camera is off (call this in render loop)
   */
  fadeAllTrails(): void {
    this.fencers.forEach((fencer) => {
      fencer.tip = null;
      fencer.trail = fencer.trail.filter(point => {
        point.opacity -= FADE_SPEED;
        return point.opacity > 0;
      });
    });
  }

  /**
   * Get interpolated tip positions for smooth rendering
   * Call this at 60fps to get interpolated positions between detections
   */
  getInterpolatedTips(now: number, detectionInterval: number): Map<string, TipPosition> {
    const interpolated = new Map<string, TipPosition>();
    const t = Math.min(1, Math.max(0, (now - this.lastDetectionTime) / detectionInterval));

    this.lastTips.forEach((tip, id) => {
      if (tip.prevX !== undefined && tip.prevY !== undefined) {
        interpolated.set(id, {
          ...tip,
          x: lerp(tip.prevX, tip.x, t),
          y: lerp(tip.prevY, tip.y, t),
        });
      } else {
        interpolated.set(id, tip);
      }
    });

    return interpolated;
  }

  /**
   * Get all fencer data including trails
   */
  getFencers(): Map<string, Fencer> {
    return this.fencers;
  }

  /**
   * Get trails for rendering
   */
  getTrails(): Map<string, TrailPoint[]> {
    const trails = new Map<string, TrailPoint[]>();
    this.fencers.forEach((fencer, id) => {
      trails.set(id, [...fencer.trail]);
    });
    return trails;
  }

  /**
   * Get current tips
   */
  getTips(): Map<string, TipPosition> {
    const tips = new Map<string, TipPosition>();
    this.fencers.forEach((fencer, id) => {
      if (fencer.tip) {
        tips.set(id, fencer.tip);
      }
    });
    return tips;
  }

  /**
   * Clear all trails
   */
  clear(): void {
    this.fencers.forEach(fencer => {
      fencer.trail = [];
      fencer.tip = null;
    });
    this.lastTips.clear();
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<TrailConfig>): void {
    this.config = { ...this.config, ...config };

    // Trim existing trails if maxLength decreased
    this.fencers.forEach(fencer => {
      if (fencer.trail.length > this.config.maxLength) {
        fencer.trail = fencer.trail.slice(-this.config.maxLength);
      }
    });
  }

  /**
   * Get current configuration
   */
  getConfig(): TrailConfig {
    return { ...this.config };
  }
}

/**
 * Linear interpolation between two values
 */
function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}
