// Canvas Renderer Module
// Handles trail rendering and visual effects

import type { TrailPoint, Fencer, EffectMode } from '../types/fencing';

export class TrailRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private coordinateMapper: ((normX: number, normY: number) => { x: number; y: number }) | null = null;
  private effectMode: EffectMode = 'none';
  private glowIntensity = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D context from canvas');
    }
    this.ctx = ctx;
  }

  /**
   * Set the coordinate mapper function to transform normalized video coords to canvas coords
   */
  setCoordinateMapper(mapper: (normX: number, normY: number) => { x: number; y: number }): void {
    this.coordinateMapper = mapper;
  }

  setEffectMode(mode: EffectMode): void {
    this.effectMode = mode;
  }

  setGlowIntensity(intensity: number): void {
    this.glowIntensity = Math.max(0, intensity);
  }

  /**
   * Map normalized coordinates to canvas coordinates
   */
  private map(normX: number, normY: number): { x: number; y: number } {
    if (this.coordinateMapper) {
      return this.coordinateMapper(normX, normY);
    }
    // Fallback to direct mapping (canvas represents full video frame)
    return { x: normX * this.canvas.width, y: normY * this.canvas.height };
  }

  /**
   * Resize canvas to match display size
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  /**
   * Clear the canvas
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Render trails for all fencers
   */
  renderTrails(fencers: Map<string, Fencer>): void {
    fencers.forEach((fencer) => {
      if (fencer.trail.length >= 2) {
        this.renderNeonTrail(fencer.trail, fencer.color);
      }
    });
  }

  /**
   * Calculate control points for cubic bezier spline
   * Uses standard Catmull-Rom to cubic bezier conversion
   * Ensures C1 continuity (smooth curves) between segments
   */
  private getControlPoints(
    p0: TrailPoint,
    p1: TrailPoint,
    p2: TrailPoint,
    p3: TrailPoint,
    tension: number = 0.5
  ): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
    // Convert normalized coordinates to canvas coordinates using mapper
    const c0 = this.map(p0.x, p0.y);
    const c1 = this.map(p1.x, p1.y);
    const c2 = this.map(p2.x, p2.y);
    const c3 = this.map(p3.x, p3.y);

    // Standard Catmull-Rom to cubic bezier conversion
    // This ensures C1 continuity (smooth tangent) at segment joints
    // cp1 = p1 + (p2 - p0) / 6 * tension
    // cp2 = p2 - (p3 - p1) / 6 * tension
    const cp1x = c1.x + (c2.x - c0.x) / 6 * tension;
    const cp1y = c1.y + (c2.y - c0.y) / 6 * tension;
    const cp2x = c2.x - (c3.x - c1.x) / 6 * tension;
    const cp2y = c2.y - (c3.y - c1.y) / 6 * tension;

    return { cp1x, cp1y, cp2x, cp2y };
  }

  /**
   * Render a single neon trail using cubic splines
   * Draws individual segments for maximum opacity control with depth cues
   */
  private renderNeonTrail(trail: TrailPoint[], color: string): void {
    if (trail.length < 2) return;

    let effectColor = color;
    let glowWidthMul = 1;
    let glowBlurMul = 1;
    let glowAlphaMul = 1;
    let coreAlphaMul = 1;
    let coreWidthMul = 1;
    let whiteCoreAlphaMul = 1;
    let whiteCoreFadeExponent = 1;
    let drawOuterColorLayer = false;
    let outerColorWidthMul = 1;
    let outerColorAlpha = 0.16;
    let ageSpreadFactor = 0.2;
    let drawGlowLayer = true;
    let whiteCoreBlurMul = 1;
    let showWhiteCore = true;

    switch (this.effectMode) {
      case 'lightsaber-glow':
        glowWidthMul = 1.25;
        glowBlurMul = 1.35;
        glowAlphaMul = 1.2;
        coreAlphaMul = 1.05;
        break;
      case 'matrix':
        glowWidthMul = 0.9;
        glowBlurMul = 0.65;
        glowAlphaMul = 0.9;
        coreAlphaMul = 0.95;
        ageSpreadFactor = 0.15;
        showWhiteCore = false;
        break;
      case 'motion-blur':
        glowWidthMul = 1.35;
        glowBlurMul = 0.5;
        glowAlphaMul = 0.75;
        coreAlphaMul = 0.95;
        ageSpreadFactor = 0.35;
        break;
      case 'none':
        drawGlowLayer = false;
        whiteCoreBlurMul = 0;
        whiteCoreAlphaMul = 0.9;
        whiteCoreFadeExponent = 1.15;
        coreWidthMul = 2;
        drawOuterColorLayer = true;
        outerColorWidthMul = 1.9;
        outerColorAlpha = 0.17;
        glowWidthMul = 0;
        glowBlurMul = 0;
        glowAlphaMul = 0;
        default:
        break;
    }

    const glowStrengthWidth = 0.6 + this.glowIntensity * 0.8;
    const glowStrengthBlur = 0.2 + this.glowIntensity;
    const glowStrengthAlpha = 0.25 + this.glowIntensity * 0.75;

    // Get average z depth for this trail (closer = more negative z)
    const avgZ = trail.reduce((sum, p) => sum + p.z, 0) / trail.length;

    // Calculate depth scale factor (closer = larger, further = smaller)
    // z is typically in range [-0.5, 0.5] in MediaPipe
    const depthScale = 1 - avgZ * 1.5; // 1.75 when close (z=-0.5), 0.25 when far (z=0.5)

    // Calculate parallax offset (further objects shift more)
    const parallaxX = avgZ * 40; // pixels
    const parallaxY = avgZ * 25;

    // Pre-calculate all canvas coordinates, control points, and depth properties
    const segments: {
      x1: number; y1: number;
      cp1x: number; cp1y: number;
      cp2x: number; cp2y: number;
      x2: number; y2: number;
      opacity: number;
      depthGlow: number;
      widthScale: number; // Per-segment width scale for perspective effect
      progress: number;
    }[] = [];

    for (let i = 0; i < trail.length - 1; i++) {
      const p0 = trail[Math.max(0, i - 1)];
      const p1 = trail[i];
      const p2 = trail[i + 1];
      const p3 = trail[Math.min(trail.length - 1, i + 2)];

      const cp = this.getControlPoints(p0, p1, p2, p3, 1.2);

      const progress = (i + 1) / (trail.length - 1);
      const opacity = (0.18 + 0.82 * smoothstep(0, 1, progress)) * p2.opacity;

      // Average z for this segment (closer = more negative)
      const segmentZ = (p1.z + p2.z) / 2;
      
      // Closer segments get more glow (negative z = closer)
      const depthGlow = Math.max(0, -segmentZ * 0.8);
      
      // Per-segment width scale: closer = wider, further = narrower
      // Tuned: 3.75x at close (z=-0.5), 0.2x at far (z=0.5)
      // Linear interpolation: scale = baseWidth - z * perspectiveWidthScale
      const baseWidth = 0.5;
      const perspectiveWidthScale = 5.0;
      const widthScale = Math.max(0.2, baseWidth - segmentZ * perspectiveWidthScale);

      // Map base coordinates using the coordinate mapper
      const c1 = this.map(p1.x, p1.y);
      const c2 = this.map(p2.x, p2.y);

      segments.push({
        x1: c1.x + parallaxX,
        y1: c1.y + parallaxY,
        cp1x: cp.cp1x + parallaxX,
        cp1y: cp.cp1y + parallaxY,
        cp2x: cp.cp2x + parallaxX,
        cp2y: cp.cp2y + parallaxY,
        x2: c2.x + parallaxX,
        y2: c2.y + parallaxY,
        opacity,
        depthGlow,
        widthScale,
        progress,
      });
    }

    // Draw each segment individually for per-segment width and opacity control
    // Ensure white core always renders for very short trails
    const whiteCoreLength = Math.max(3, Math.floor(segments.length * 0.5));

    segments.forEach((seg, i) => {
      // Per-segment width scale for perspective effect
      const segWidthScale = seg.widthScale;
      const ageSpread = 1 + (1 - seg.progress) * ageSpreadFactor;
      const thicknessBoost = 2.2;
      
      // Depth-adjusted glow: closer segments glow more
      const glowBoost = seg.depthGlow;

      // Base widths scaled by both overall depth and per-segment perspective
      const glow =
        18 * depthScale * segWidthScale * thicknessBoost * ageSpread * glowWidthMul * glowStrengthWidth;
      const core = 5 * depthScale * segWidthScale * thicknessBoost * coreWidthMul;

      // Performance pass: one glow layer + core (instead of 3 glow layers + core).
      if (drawGlowLayer) {
        this.drawSegment(
          seg,
          effectColor,
          glow,
          (18 + glowBoost * 14) * glowBlurMul * glowStrengthBlur,
          Math.min(1, (0.22 + glowBoost * 0.12) * glowAlphaMul * glowStrengthAlpha)
        );
      }
      if (drawOuterColorLayer) {
        this.drawSegment(seg, effectColor, core * outerColorWidthMul, 0, Math.min(0.38, outerColorAlpha + glowBoost * 0.08));
      }
      this.drawSegment(seg, effectColor, core, 0, Math.min(1, Math.max(0.3, 0.5 + glowBoost * 0.2) * coreAlphaMul));

      // White core with smooth fade-in - ensure it renders for all segments in short trails
      if (showWhiteCore && i >= segments.length - whiteCoreLength) {
        const whiteProgress = (i - (segments.length - whiteCoreLength)) / Math.max(1, whiteCoreLength - 1);
        const whiteOpacity = Math.pow(smoothstep(0, 1, whiteProgress), whiteCoreFadeExponent) * whiteCoreAlphaMul;
        this.drawSegment(
          seg,
          '#ffffff',
          2 * depthScale * segWidthScale * thicknessBoost,
          glowBoost * 10 * whiteCoreBlurMul,
          whiteOpacity
        );
      }
    });
  }

  /**
   * Draw a single curve segment with its own opacity
   */
  private drawSegment(
    seg: {
      x1: number; y1: number;
      cp1x: number; cp1y: number;
      cp2x: number; cp2y: number;
      x2: number; y2: number;
      opacity: number;
    },
    color: string,
    lineWidth: number,
    shadowBlur: number,
    baseAlpha: number
  ): void {
    const alpha = seg.opacity * baseAlpha;
    // Skip very transparent segments to avoid black artifacts
    if (alpha <= 0.05) return;

    this.ctx.save();
    this.ctx.strokeStyle = this.colorWithAlpha(color, alpha);
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = 'butt';
    this.ctx.lineJoin = 'miter';
    this.ctx.shadowBlur = shadowBlur;
    this.ctx.shadowColor = color;

    this.ctx.beginPath();
    this.ctx.moveTo(seg.x1, seg.y1);
    this.ctx.bezierCurveTo(seg.cp1x, seg.cp1y, seg.cp2x, seg.cp2y, seg.x2, seg.y2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /**
   * Convert color to rgba string with alpha
   */
  private colorWithAlpha(color: string, alpha: number): string {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Render a small dot at the head (latest point) of each trail
   * Size varies with depth for perspective effect
   */
  renderTipDots(fencers: Map<string, Fencer>): void {
    fencers.forEach((fencer) => {
      if (!fencer.tip) return;

      // Apply same parallax offset as the trail rendering
      const avgZ = fencer.tip.z;
      const parallaxX = avgZ * 40;
      const parallaxY = avgZ * 25;

      // Map coordinates using the coordinate mapper
      const mapped = this.map(fencer.tip.x, fencer.tip.y);
      const x = mapped.x + parallaxX;
      const y = mapped.y + parallaxY;

      // Perspective scale for tip dot: closer = larger
      // Same formula as trail segments: 1.975 - z * 3.55
      const widthScale = Math.max(0.2, 1.975 - avgZ * 3.55);

      this.ctx.save();

      // White tip dot - size varies with depth for perspective
      // Keep this tight so it reads as a tip highlight, not a large marker.
      const radius = Math.max(1.25, Math.min(2.75, 0.95 * widthScale));
      this.ctx.fillStyle = '#ffffff';
      this.ctx.beginPath();
      this.ctx.arc(x, y, radius, 0, Math.PI * 2);
      this.ctx.fill();

      this.ctx.restore();
    });
  }

  /**
   * Render trails only (black background)
   */
  renderTrailsOnly(fencers: Map<string, Fencer>): void {
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.renderTrails(fencers);
  }
}

/**
 * Smoothstep function for smooth interpolation
 * Returns 0 when x <= edge0, 1 when x >= edge1, smooth transition in between
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class DebugRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private coordinateMapper: ((normX: number, normY: number) => { x: number; y: number }) | null = null;
  
  // Store PREVIOUS screen positions for motion trail
  private prevWristScreen: { x: number; y: number } | null = null;
  private prevTipScreen: { x: number; y: number } | null = null;
  // Store CURRENT screen positions (so we can shift to prev on new detection)
  private currWristScreen: { x: number; y: number } | null = null;
  private currTipScreen: { x: number; y: number } | null = null;
  // Track last normalized detection positions to detect changes
  private lastWristNorm: { x: number; y: number } | null = null;
  private lastTipNorm: { x: number; y: number } | null = null;
  // Frame rate and inference rate for interpolation
  private renderFrameRate: number = 60;
  private inferenceRate: number = 15;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D context from canvas');
    }
    this.ctx = ctx;
  }
  
  setRates(renderFps: number, inferenceFps: number): void {
    this.renderFrameRate = renderFps;
    this.inferenceRate = inferenceFps;
  }

  setCoordinateMapper(mapper: (normX: number, normY: number) => { x: number; y: number }): void {
    this.coordinateMapper = mapper;
  }

  private map(normX: number, normY: number): { x: number; y: number } {
    if (this.coordinateMapper) {
      return this.coordinateMapper(normX, normY);
    }
    return { x: normX * this.canvas.width, y: normY * this.canvas.height };
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Render pose landmarks as dots
   */
  renderLandmarks(landmarks: any[], color: string = '#00ff00'): void {
    this.ctx.save();
    this.ctx.fillStyle = color;

    landmarks.forEach((lm) => {
      if (lm.visibility > 0.5) {
        const mapped = this.map(lm.x, lm.y);
        this.ctx.beginPath();
        this.ctx.arc(mapped.x, mapped.y, 4, 0, Math.PI * 2);
        this.ctx.fill();
      }
    });

    this.ctx.restore();
  }

  /**
   * Render skeleton with bones (lines) and joints (outline circles)
   */
  renderSkeleton(landmarks: any[], connections: [number, number][], color: string = '#00ff00'): void {
    this.ctx.save();

    // Helper to check if landmark is valid
    const isValid = (lm: any) => lm && (lm.visibility === undefined || lm.visibility > 0.5);

    // Draw bones (lines)
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    connections.forEach(([start, end]) => {
      const startLm = landmarks[start];
      const endLm = landmarks[end];

      if (isValid(startLm) && isValid(endLm)) {
        const startMapped = this.map(startLm.x, startLm.y);
        const endMapped = this.map(endLm.x, endLm.y);
        this.ctx.beginPath();
        this.ctx.moveTo(startMapped.x, startMapped.y);
        this.ctx.lineTo(endMapped.x, endMapped.y);
        this.ctx.stroke();
      }
    });

    // Draw joints (outline circles) at each connected landmark
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; // Semi-transparent fill

    // Get unique landmark indices from connections
    const uniqueIndices = new Set<number>();
    connections.forEach(([start, end]) => {
      uniqueIndices.add(start);
      uniqueIndices.add(end);
    });

    uniqueIndices.forEach((idx) => {
      const lm = landmarks[idx];
      if (isValid(lm)) {
        const mapped = this.map(lm.x, lm.y);
        this.ctx.beginPath();
        this.ctx.arc(mapped.x, mapped.y, 6, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
      }
    });

    this.ctx.restore();
  }

  /**
   * Render forearm vectors (elbow -> wrist -> tip)
   * For Pose mode: vector starts at hand (tip) and extends back along forearm direction
   */
  renderVectors(
    wrist: any,
    elbow: any,
    tip: { x: number; y: number },
    color: string = '#00ff00',
    startFromHand: boolean = true
  ): void {
    if (wrist.visibility < 0.5 || elbow.visibility < 0.5) return;

    this.ctx.save();

    // Map coordinates
    const elbowMapped = this.map(elbow.x, elbow.y);
    const wristMapped = this.map(wrist.x, wrist.y);
    const tipMapped = this.map(tip.x, tip.y);

    if (startFromHand) {
      // New style: Vector starts at hand and extends back toward elbow
      // Calculate direction from elbow to wrist (forearm direction)
      const dirX = wristMapped.x - elbowMapped.x;
      const dirY = wristMapped.y - elbowMapped.y;
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
      
      // Normalize direction
      const normDirX = dirX / dirLen;
      const normDirY = dirY / dirLen;
      
      // Calculate sword length (0.5x forearm)
      const swordLen = dirLen * 0.5;
      
      // "Cheat": Extend the sword further out from the elbow
      // Move both start and end points outward along the sword direction
      const extension = dirLen * 3.0; // Extend 300% of forearm length beyond tip (very dramatic)
      
      // Starting point (tip of sword) - extended outward
      const handX = tipMapped.x + normDirX * extension;
      const handY = tipMapped.y + normDirY * extension;
      
      // End point (handle of sword) - also extended, keeping same sword length
      const endX = handX - normDirX * swordLen;
      const endY = handY - normDirY * swordLen;
      
      // Draw forearm reference (subtle)
      this.ctx.strokeStyle = 'rgba(255, 255, 0, 0.3)';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([]);
      this.ctx.beginPath();
      this.ctx.moveTo(elbowMapped.x, elbowMapped.y);
      this.ctx.lineTo(wristMapped.x, wristMapped.y);
      this.ctx.stroke();
      
      // Draw sword vector from hand
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 4;
      this.ctx.setLineDash([5, 5]);
      this.ctx.beginPath();
      this.ctx.moveTo(handX, handY);
      this.ctx.lineTo(endX, endY);
      this.ctx.stroke();
      
      // Draw hand/tip marker
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.arc(handX, handY, 8, 0, Math.PI * 2);
      this.ctx.fill();
      
      // Draw end marker
      this.ctx.fillStyle = '#ffffff';
      this.ctx.beginPath();
      this.ctx.arc(endX, endY, 4, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      // Original style: Elbow -> wrist -> tip
      // Elbow to wrist
      this.ctx.strokeStyle = '#ffff00';
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(elbowMapped.x, elbowMapped.y);
      this.ctx.lineTo(wristMapped.x, wristMapped.y);
      this.ctx.stroke();

      // Wrist to tip
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 3;
      this.ctx.setLineDash([5, 5]);
      this.ctx.beginPath();
      this.ctx.moveTo(wristMapped.x, wristMapped.y);
      this.ctx.lineTo(tipMapped.x, tipMapped.y);
      this.ctx.stroke();

      // Draw tip marker
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.arc(tipMapped.x, tipMapped.y, 6, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  /**
   * Render lightsaber blade effect (motion-based quadrilateral)
   * Creates a blade shape connecting previous and current sword positions
   */
  renderLightsaber(
    wrist: any,
    tip: { x: number; y: number },
    color: string
  ): void {
    // Check visibility for pose mode, or just existence for hand mode
    if (wrist.visibility !== undefined && wrist.visibility < 0.5) return;

    // Map current coordinates to screen
    const wristScreenOrig = this.map(wrist.x, wrist.y);
    const tipScreenOrig = this.map(tip.x, tip.y);
    
    // "Cheat": Adjust sword position - move handle outward, shorten sword
    // Calculate direction from wrist to tip
    const dirX = tipScreenOrig.x - wristScreenOrig.x;
    const dirY = tipScreenOrig.y - wristScreenOrig.y;
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    const normDirX = dirX / dirLen;
    const normDirY = dirY / dirLen;
    
    // Move handle OUT toward the tip (away from elbow) - 20% toward tip
    const handleShift = dirLen * 0.2;
    const wristScreen = {
      x: wristScreenOrig.x + normDirX * handleShift,
      y: wristScreenOrig.y + normDirY * handleShift
    };
    
    // Tip 30% beyond original tip
    const tipShift = dirLen * 0.3;
    const tipScreen = {
      x: tipScreenOrig.x + normDirX * tipShift,
      y: tipScreenOrig.y + normDirY * tipShift
    };
    
    // Check if this is new detection data (different from last frame)
    const isNewData = !this.lastWristNorm || 
      Math.abs(wrist.x - this.lastWristNorm.x) > 0.0001 ||
      Math.abs(wrist.y - this.lastWristNorm.y) > 0.0001 ||
      !this.lastTipNorm ||
      Math.abs(tip.x - this.lastTipNorm.x) > 0.0001 ||
      Math.abs(tip.y - this.lastTipNorm.y) > 0.0001;
    
    // Determine previous and current positions for rendering
    let prevWrist: {x: number, y: number};
    let prevTip: {x: number, y: number};
    let currWrist: {x: number, y: number};
    let currTip: {x: number, y: number};
    
    if (isNewData) {
      // New detection arrived!
      // Shift old current to new previous
      if (this.currWristScreen && this.currTipScreen) {
        this.prevWristScreen = { x: this.currWristScreen.x, y: this.currWristScreen.y };
        this.prevTipScreen = { x: this.currTipScreen.x, y: this.currTipScreen.y };
      }
      // Store new current
      this.currWristScreen = { x: wristScreen.x, y: wristScreen.y };
      this.currTipScreen = { x: tipScreen.x, y: tipScreen.y };
      // Update tracking
      this.lastWristNorm = { x: wrist.x, y: wrist.y };
      this.lastTipNorm = { x: tip.x, y: tip.y };
    }
    // else: no new data, keep curr and prev as-is
    
    // Current is always the latest mapped position
    currWrist = this.currWristScreen ?? wristScreen;
    currTip = this.currTipScreen ?? tipScreen;
    
    // Use stored positions for rendering with interpolation
    if (this.prevWristScreen && this.prevTipScreen) {
      // Calculate interpolation factor based on frame rate vs inference rate
      // e.g., 60fps render / 15fps inference = 0.25, but we cheat and make it 0.5 for drama
      const interpolationFactor = (this.inferenceRate / this.renderFrameRate) * 2; // 2x for dramatic effect
      
      // Interpolate previous position: prev = curr + (stored_prev - curr) * factor
      // This makes the trail length proportional to actual time
      prevWrist = {
        x: currWrist.x + (this.prevWristScreen.x - currWrist.x) * interpolationFactor,
        y: currWrist.y + (this.prevWristScreen.y - currWrist.y) * interpolationFactor
      };
      prevTip = {
        x: currTip.x + (this.prevTipScreen.x - currTip.x) * interpolationFactor,
        y: currTip.y + (this.prevTipScreen.y - currTip.y) * interpolationFactor
      };
      
      // Ensure minimum blade thickness (4px perpendicular to sword direction)
      const dx = currTip.x - currWrist.x;
      const dy = currTip.y - currWrist.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = (-dy / len) * 4;
      const perpY = (dx / len) * 4;
      
      // Calculate actual distance between prev and curr wrist
      const wristDist = Math.sqrt(
        Math.pow(prevWrist.x - currWrist.x, 2) + 
        Math.pow(prevWrist.y - currWrist.y, 2)
      );
      
      // If too thin, expand perpendicular to minimum width
      if (wristDist < 4) {
        prevWrist = { x: currWrist.x - perpX, y: currWrist.y - perpY };
        prevTip = { x: currTip.x - perpX, y: currTip.y - perpY };
      }
    } else {
      // First detection - create minimal perpendicular thickness
      const dx = currTip.x - currWrist.x;
      const dy = currTip.y - currWrist.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = (-dy / len) * 4; // 4px minimum thickness
      const perpY = (dx / len) * 4;
      prevWrist = { 
        x: currWrist.x - perpX, 
        y: currWrist.y - perpY 
      };
      prevTip = { 
        x: currTip.x - perpX, 
        y: currTip.y - perpY 
      };
    }

    this.ctx.save();
    
    // Calculate quadrilateral points with some expansion for the glow
    const glowExpand = 8; // pixels to expand for glow effect
    
    // Expanded points for outer glow (offset perpendicular to each edge)
    const expandEdge = (p1: {x: number, y: number}, p2: {x: number, y: number}, amount: number) => {
      const edx = p2.x - p1.x;
      const edy = p2.y - p1.y;
      const elen = Math.sqrt(edx * edx + edy * edy);
      const eperpX = (-edy / elen) * amount;
      const eperpY = (edx / elen) * amount;
      return {
        p1x: p1.x + eperpX, p1y: p1.y + eperpY,
        p2x: p2.x + eperpX, p2y: p2.y + eperpY
      };
    };
    
    // Outer glow - expanded quadrilateral
    const outerEdge1 = expandEdge(prevWrist, prevTip, glowExpand * 2);
    const outerEdge2 = expandEdge(currTip, currWrist, glowExpand * 2);
    
    this.ctx.shadowBlur = 40;
    this.ctx.shadowColor = color;
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = 0.3;
    
    this.ctx.beginPath();
    this.ctx.moveTo(outerEdge1.p1x, outerEdge1.p1y);
    this.ctx.lineTo(outerEdge1.p2x, outerEdge1.p2y);
    this.ctx.lineTo(outerEdge2.p1x, outerEdge2.p1y);
    this.ctx.lineTo(outerEdge2.p2x, outerEdge2.p2y);
    this.ctx.closePath();
    this.ctx.fill();
    
    // Middle glow
    const midEdge1 = expandEdge(prevWrist, prevTip, glowExpand);
    const midEdge2 = expandEdge(currTip, currWrist, glowExpand);
    
    this.ctx.shadowBlur = 20;
    this.ctx.globalAlpha = 0.6;
    
    this.ctx.beginPath();
    this.ctx.moveTo(midEdge1.p1x, midEdge1.p1y);
    this.ctx.lineTo(midEdge1.p2x, midEdge1.p2y);
    this.ctx.lineTo(midEdge2.p1x, midEdge2.p1y);
    this.ctx.lineTo(midEdge2.p2x, midEdge2.p2y);
    this.ctx.closePath();
    this.ctx.fill();
    
    // Inner glow
    const innerEdge1 = expandEdge(prevWrist, prevTip, glowExpand * 0.5);
    const innerEdge2 = expandEdge(currTip, currWrist, glowExpand * 0.5);
    
    this.ctx.shadowBlur = 10;
    this.ctx.globalAlpha = 0.8;
    
    this.ctx.beginPath();
    this.ctx.moveTo(innerEdge1.p1x, innerEdge1.p1y);
    this.ctx.lineTo(innerEdge1.p2x, innerEdge1.p2y);
    this.ctx.lineTo(innerEdge2.p1x, innerEdge2.p1y);
    this.ctx.lineTo(innerEdge2.p2x, innerEdge2.p2y);
    this.ctx.closePath();
    this.ctx.fill();

    // Core (white quadrilateral - the actual blade shape)
    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.globalAlpha = 1.0;

    this.ctx.beginPath();
    this.ctx.moveTo(prevWrist.x, prevWrist.y);
    this.ctx.lineTo(prevTip.x, prevTip.y);
    this.ctx.lineTo(currTip.x, currTip.y);
    this.ctx.lineTo(currWrist.x, currWrist.y);
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }
}
