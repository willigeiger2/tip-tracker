// Hit effects for recorded playback: a fencer-tinted screen flash and a pseudo-3D burst of
// streaks from the scoring fencer's tip.
//
// Everything is a pure function of media time (seconds since the hit), with per-hit seeded
// randomness, so pausing, scrubbing, frame stepping and frame-by-frame export all show exactly
// the same image for a given frame.
//
// Burst model: streaks fly out from the tip in random directions over the hemisphere facing the
// camera (+z toward the viewer), slowed by drag and pulled down by gravity. Positions are in
// units of the video frame height, projected with a simple pinhole camera so streaks heading
// toward the viewer spread faster and draw thicker and brighter.

import type { Hit } from './types';

export type HitEffectMode = 'off' | 'flash' | 'burst' | 'both';

export const HIT_FLASH_SECONDS = 0.45;
/**
 * Burst physics run at this fraction of real time (0.75 = 75% slow motion, which reads as a
 * slightly bigger explosion). Lifetimes stretch to match.
 */
const BURST_TIME_SCALE = 0.75;
export const HIT_BURST_SECONDS = 0.9 / BURST_TIME_SCALE;
/** Longest effect window: hits older than this draw nothing. */
export const HIT_EFFECT_SECONDS = Math.max(HIT_FLASH_SECONDS, HIT_BURST_SECONDS);

const STREAK_COUNT = 90;
/** Exponential drag rate (1/s). */
const DRAG = 3.2;
/** Gravity in frame heights / s^2 (screen down). */
const GRAVITY = 0.9;
/** Camera distance from the tip plane, in frame heights. */
const CAMERA_DISTANCE = 2.2;
/** Streak tail lags the head by this much time. */
const STREAK_TAIL_SECONDS = 0.075;
const FLASH_PEAK_ALPHA = 0.7;
/** The flash starts this many frames after the hit frame (the burst starts on the hit frame). */
const FLASH_DELAY_FRAMES = 1;
/** The flash starts white and takes on the scorer's tint over this fraction of its duration. */
const FLASH_TINT_FRACTION = 0.35;
/** Streak core width at full size, in frame heights. */
const STREAK_WIDTH = 0.0033;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Streak {
  /** Unit direction; z >= 0 (toward the camera). */
  dir: Vec3;
  /** Initial speed in frame heights / s. */
  speed: number;
  /** Width multiplier. */
  width: number;
  /** Lifetime as a fraction of the burst duration (streaks die at different times). */
  life: number;
}

/** Small fast deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedForHit(hit: Hit): number {
  return (Math.round(hit.time * 1000) * 2654435761 + (hit.trackId === 'A' ? 17 : 91)) >>> 0;
}

export function makeStreaks(seed: number, count = STREAK_COUNT): Streak[] {
  const rand = mulberry32(seed);
  const streaks: Streak[] = [];
  for (let i = 0; i < count; i++) {
    // Uniform over the hemisphere: z uniform in [0, 1], azimuth uniform.
    const z = rand();
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const fast = rand();
    streaks.push({
      dir: { x: r * Math.cos(phi), y: r * Math.sin(phi), z },
      speed: 0.35 + 1.25 * fast * fast,
      width: 0.6 + 0.8 * rand(),
      life: 0.55 + 0.45 * rand(),
    });
  }
  return streaks;
}

/** Streak head position (frame heights, relative to the origin) `age` seconds after the hit. */
export function streakPosition(streak: Streak, age: number): Vec3 {
  const a = Math.max(0, age);
  const dist = (streak.speed * (1 - Math.exp(-DRAG * a))) / DRAG;
  return {
    x: streak.dir.x * dist,
    y: streak.dir.y * dist + 0.5 * GRAVITY * a * a,
    z: streak.dir.z * dist,
  };
}

/** Perspective projection onto the tip plane: screen offset (frame heights) and size scale. */
export function project(p: Vec3, cameraDistance = CAMERA_DISTANCE): { x: number; y: number; scale: number } {
  const depth = Math.max(cameraDistance * 0.25, cameraDistance - p.z);
  const scale = cameraDistance / depth;
  return { x: p.x * scale, y: p.y * scale, scale };
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function flashAlpha(age: number): number {
  if (age < 0 || age >= HIT_FLASH_SECONDS) return 0;
  return FLASH_PEAK_ALPHA * (1 - Math.sqrt(age / HIT_FLASH_SECONDS));
}

/** Flash color at `age`: white on the first frame, blending to the scorer's tint as it fades. */
export function flashColor(tint: [number, number, number], age: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, age / (HIT_FLASH_SECONDS * FLASH_TINT_FRACTION)));
  return mix([255, 255, 255], tint, t);
}

// ---- Drawing ----

export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HitEffectInput {
  hit: Hit;
  /** Seconds since the hit. */
  age: number;
  /** Fencer color (#rrggbb). */
  color: string;
  /** Burst origin in canvas pixels, or null when the tip position is unknown (flash only). */
  origin: { x: number; y: number } | null;
}

function rgb(color: string): [number, number, number] {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color)?.[1] ?? 'ffffff';
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function rgba([r, g, b]: [number, number, number], alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

const streakCache = new Map<number, Streak[]>();

function streaksFor(hit: Hit): Streak[] {
  const seed = seedForHit(hit);
  let streaks = streakCache.get(seed);
  if (!streaks) {
    streaks = makeStreaks(seed);
    if (streakCache.size > 256) streakCache.clear();
    streakCache.set(seed, streaks);
  }
  return streaks;
}

export function drawHitFlash(ctx: CanvasRenderingContext2D, rect: VideoRect, color: string, age: number): void {
  const alpha = flashAlpha(age);
  if (alpha <= 0) return;
  ctx.save();
  ctx.fillStyle = rgba(flashColor(rgb(color), age), alpha);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

export function drawHitBurst(
  ctx: CanvasRenderingContext2D,
  hit: Hit,
  origin: { x: number; y: number },
  frameHeightPx: number,
  color: string,
  age: number
): void {
  if (age < 0 || age >= HIT_BURST_SECONDS) return;
  const base = rgb(color);
  const white: [number, number, number] = [255, 255, 255];
  const unit = frameHeightPx;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  // Bright core at the impact point for the first moments.
  const coreT = age / (0.18 / BURST_TIME_SCALE);
  if (coreT < 1) {
    const radius = unit * (0.015 + 0.05 * coreT);
    const gradient = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, radius);
    gradient.addColorStop(0, rgba(white, 0.95 * (1 - coreT)));
    gradient.addColorStop(0.4, rgba(base, 0.6 * (1 - coreT)));
    gradient.addColorStop(1, rgba(base, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const streak of streaksFor(hit)) {
    const lifetime = HIT_BURST_SECONDS * streak.life;
    if (age >= lifetime) continue;
    const progress = age / lifetime;
    const physicsAge = age * BURST_TIME_SCALE;
    const head = project(streakPosition(streak, physicsAge));
    const tail = project(streakPosition(streak, physicsAge - STREAK_TAIL_SECONDS));
    const hx = origin.x + head.x * unit;
    const hy = origin.y + head.y * unit;
    const tx = origin.x + tail.x * unit;
    const ty = origin.y + tail.y * unit;

    const fade = Math.pow(1 - progress, 1.4);
    const width = unit * STREAK_WIDTH * streak.width * head.scale * (1 - 0.5 * progress);
    // Hot white core cooling to the fencer color.
    const coreColor = mix(white, base, Math.min(1, progress * 1.6));

    // Glow pass
    ctx.strokeStyle = rgba(base, 0.35 * fade);
    ctx.lineWidth = width * 3.2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();

    // Core pass
    ctx.strokeStyle = rgba(coreColor, 0.95 * fade);
    ctx.lineWidth = Math.max(0.75, width);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }

  ctx.restore();
}

/** Draw all active hit effects. Flashes go first so bursts read on top of them. */
export function drawHitEffects(
  ctx: CanvasRenderingContext2D,
  effects: readonly HitEffectInput[],
  mode: HitEffectMode,
  rect: VideoRect,
  fps: number
): void {
  if (mode === 'off' || effects.length === 0) return;
  if (mode === 'flash' || mode === 'both') {
    const flashDelay = FLASH_DELAY_FRAMES / Math.max(1, fps);
    for (const e of effects) drawHitFlash(ctx, rect, e.color, e.age - flashDelay);
  }
  if (mode === 'burst' || mode === 'both') {
    for (const e of effects) {
      if (e.origin) drawHitBurst(ctx, e.hit, e.origin, rect.height, e.color, e.age);
    }
  }
}
