#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


@dataclass
class Keyframe:
    time: float
    x: float
    y: float


@dataclass
class PriorPoint:
    wrist_x: float
    wrist_y: float
    tip_x: float
    tip_y: float
    quality: float


@dataclass
class Candidate:
    tip_x: float
    tip_y: float
    score: float
    margin: float
    support: int
    shift_from_prior: float


@dataclass
class Detection:
    tip_x: float
    tip_y: float
    applied: bool
    score: float
    margin: float
    support: int
    shift_from_prior: float


@dataclass
class TemporalState:
    tip_x: float
    tip_y: float
    vel_x: float
    vel_y: float
    dir_x: float
    dir_y: float
    length: float
    confidence: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline ridge-path blade-tip experiment")
    parser.add_argument(
        "--truth-json",
        default=str(Path.home() / "Downloads" / "tiptrack-short-clip-hand-edited.json"),
    )
    parser.add_argument(
        "--trace-json",
        default=str(Path.home() / "Downloads" / "tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (10).json"),
    )
    parser.add_argument("--track-id", default="A", choices=["A", "B"])
    parser.add_argument(
        "--frames-dir",
        default="/var/folders/66/r7987msj6bq2t5jtzjcwg0jr0000gn/T/opencode/tiptrack-template-exp/frames_960",
    )
    parser.add_argument("--extract-frames", action="store_true")
    parser.add_argument("--frame-start", type=int, default=0)
    parser.add_argument("--frame-end", type=int, default=3000)
    parser.add_argument("--fps", type=float, default=30.0)

    parser.add_argument("--angle-window-deg", type=float, default=70.0)
    parser.add_argument("--angle-step-deg", type=float, default=1.25)
    parser.add_argument("--radius-step", type=float, default=2.0)
    parser.add_argument("--min-radius-px", type=float, default=14.0)
    parser.add_argument("--max-radius-px", type=float, default=230.0)
    parser.add_argument("--edge-quantile", type=float, default=0.90)
    parser.add_argument("--score-threshold", type=float, default=0.012)
    parser.add_argument("--max-angle-step-bins", type=int, default=3)
    parser.add_argument("--angle-step-penalty", type=float, default=0.010)
    parser.add_argument("--continuity-bonus", type=float, default=0.004)
    parser.add_argument("--distal-bias", type=float, default=0.090)
    parser.add_argument("--distal-start-ratio", type=float, default=0.62)
    parser.add_argument("--tip-search-radius", type=int, default=5)

    parser.add_argument("--multi-hyp-k", type=int, default=4)
    parser.add_argument("--hyp-motion-cost", type=float, default=0.022)
    parser.add_argument("--hyp-prior-cost", type=float, default=0.016)
    parser.add_argument("--hyp-score-weight", type=float, default=0.16)

    parser.add_argument("--min-support", type=int, default=24)
    parser.add_argument("--min-margin", type=float, default=0.010)
    parser.add_argument("--min-score", type=float, default=0.064)
    parser.add_argument("--max-shift-from-prior", type=float, default=20.0)
    parser.add_argument("--blend", type=float, default=0.85)

    parser.add_argument("--temporal-enabled", action="store_true")
    parser.add_argument("--temporal-prior-weight", type=float, default=0.86)
    parser.add_argument("--temporal-prior-max-shift", type=float, default=30.0)
    parser.add_argument("--temporal-dir-alpha", type=float, default=0.35)
    parser.add_argument("--temporal-len-alpha", type=float, default=0.20)
    parser.add_argument("--temporal-vel-alpha", type=float, default=0.28)
    parser.add_argument("--temporal-expected-blend", type=float, default=0.28)
    parser.add_argument("--temporal-max-step", type=float, default=10.0)

    parser.add_argument("--output-csv", default="")
    return parser.parse_args()


def parse_float(value: object, fallback: float = 0.0) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    return fallback


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * clamp(q, 0.0, 1.0)))
    return ordered[max(0, min(len(ordered) - 1, idx))]


def normalize(dx: float, dy: float) -> tuple[float, float] | None:
    length = math.hypot(dx, dy)
    if not math.isfinite(length) or length < 1e-6:
        return None
    return (dx / length, dy / length)


def ensure_frames(args: argparse.Namespace, video_url: str) -> None:
    frames_dir = Path(args.frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    if any(frames_dir.glob("f30_*.jpg")) and not args.extract_frames:
        return
    out_pattern = str(frames_dir / "f30_%05d.jpg")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        video_url,
        "-vf",
        "fps=30,scale=960:-1",
        "-q:v",
        "2",
        out_pattern,
    ]
    subprocess.run(cmd, check=True)


def frame_path(frames_dir: str, frame_at_30: int) -> Path:
    return Path(frames_dir) / f"f30_{frame_at_30 + 1:05d}.jpg"


def load_truth(truth_json: str, track_id: str) -> tuple[list[Keyframe], float, str]:
    with open(truth_json, "r", encoding="utf-8") as f:
        payload = json.load(f)
    track = next((t for t in payload.get("tracks", []) if t.get("id") == track_id), None)
    if not track:
        raise ValueError(f"Track {track_id} not found in {truth_json}")

    keyframes = [
        Keyframe(
            time=parse_float(k.get("time")),
            x=parse_float(k.get("x")),
            y=parse_float(k.get("y")),
        )
        for k in track.get("keyframes", [])
    ]
    keyframes.sort(key=lambda row: row.time)
    return keyframes, float(payload.get("maxGapSeconds", 5.0)), str(payload.get("videoUrl", ""))


def interpolate_point(track: list[Keyframe], t: float, max_gap_seconds: float) -> tuple[float, float] | None:
    if not track:
        return None
    if t < track[0].time or t > track[-1].time:
        return None

    for i in range(len(track) - 1):
        a = track[i]
        b = track[i + 1]
        if t < a.time or t > b.time:
            continue
        dt = b.time - a.time
        if dt > max_gap_seconds:
            return None
        if dt <= 1e-9:
            return (a.x, a.y)
        u = (t - a.time) / dt
        return (a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u)

    if abs(t - track[-1].time) <= 1e-9:
        return (track[-1].x, track[-1].y)
    return None


def load_gray(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("L"), dtype=np.float32) / 255.0


def sobel_grad(gray: np.ndarray) -> np.ndarray:
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = (gray[:, 2:] - gray[:, :-2]) * 0.5
    gy[1:-1, :] = (gray[2:, :] - gray[:-2, :]) * 0.5
    return np.hypot(gx, gy)


def load_prior_map(
    trace_json: str,
    track_id: str,
    frame_w: int,
    frame_h: int,
) -> tuple[dict[int, PriorPoint], float, float]:
    with open(trace_json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    source = payload.get("source", {}) if isinstance(payload, dict) else {}
    source_w = parse_float(source.get("width"), 1920.0)
    source_h = parse_float(source.get("height"), 1080.0)

    priors: dict[int, PriorPoint] = {}
    for entry in payload.get("trace", []):
        frame_idx = int(entry.get("frameAt30", -1))
        if frame_idx < 0:
            continue
        det = next((d for d in entry.get("detections", []) if d.get("id") == track_id), None)
        if not isinstance(det, dict):
            continue
        tip = det.get("tip") or {}
        tx = tip.get("x")
        ty = tip.get("y")
        if not isinstance(tx, (int, float)) or not isinstance(ty, (int, float)):
            continue
        refinement = det.get("refinement") or {}
        wrist = refinement.get("wrist") if isinstance(refinement, dict) else None
        wx = wrist.get("x") if isinstance(wrist, dict) else None
        wy = wrist.get("y") if isinstance(wrist, dict) else None
        if not isinstance(wx, (int, float)) or not isinstance(wy, (int, float)):
            continue

        priors[frame_idx] = PriorPoint(
            wrist_x=float(wx) * frame_w,
            wrist_y=float(wy) * frame_h,
            tip_x=float(tx) * frame_w,
            tip_y=float(ty) * frame_h,
            quality=parse_float(det.get("seedQuality"), 0.0),
        )

    return priors, source_w, source_h


def blended_prior_from_state(
    prior: PriorPoint,
    state: TemporalState | None,
    temporal_prior_weight: float,
    temporal_prior_max_shift: float,
) -> PriorPoint:
    if state is None:
        return prior

    pred_x = prior.wrist_x + state.dir_x * state.length + state.vel_x
    pred_y = prior.wrist_y + state.dir_y * state.length + state.vel_y
    shift = math.hypot(pred_x - prior.tip_x, pred_y - prior.tip_y)
    if shift > max(1.0, temporal_prior_max_shift):
        return prior

    w = clamp(temporal_prior_weight * clamp(state.confidence, 0.0, 1.0), 0.0, temporal_prior_weight)
    if w <= 1e-5:
        return prior

    return PriorPoint(
        wrist_x=prior.wrist_x,
        wrist_y=prior.wrist_y,
        tip_x=prior.tip_x * (1.0 - w) + pred_x * w,
        tip_y=prior.tip_y * (1.0 - w) + pred_y * w,
        quality=max(prior.quality, state.confidence),
    )


def update_temporal_state(
    state: TemporalState | None,
    wrist_x: float,
    wrist_y: float,
    tip_x: float,
    tip_y: float,
    detection: Detection,
    dir_alpha: float,
    len_alpha: float,
    vel_alpha: float,
    max_step: float,
) -> TemporalState | None:
    measured_dir = normalize(tip_x - wrist_x, tip_y - wrist_y)
    if measured_dir is None:
        return state

    mdx, mdy = measured_dir
    measured_len = math.hypot(tip_x - wrist_x, tip_y - wrist_y)
    measured_conf = clamp(detection.score * 2.5 + detection.margin * 0.9, 0.0, 1.0)
    if not detection.applied:
        measured_conf = max(0.06, measured_conf * 0.4)

    if state is None:
        return TemporalState(
            tip_x=tip_x,
            tip_y=tip_y,
            vel_x=0.0,
            vel_y=0.0,
            dir_x=mdx,
            dir_y=mdy,
            length=max(1.0, measured_len),
            confidence=measured_conf,
        )

    target_vx = tip_x - state.tip_x
    target_vy = tip_y - state.tip_y
    step = math.hypot(target_vx, target_vy)
    if step > max_step > 1e-6:
        scale = max_step / step
        target_vx *= scale
        target_vy *= scale

    va = clamp(vel_alpha, 0.0, 1.0)
    da = clamp(dir_alpha, 0.0, 1.0)
    la = clamp(len_alpha, 0.0, 1.0)

    next_vx = state.vel_x * (1.0 - va) + target_vx * va
    next_vy = state.vel_y * (1.0 - va) + target_vy * va

    blend_dx = state.dir_x * (1.0 - da) + mdx * da
    blend_dy = state.dir_y * (1.0 - da) + mdy * da
    next_dir = normalize(blend_dx, blend_dy) or (mdx, mdy)

    next_len = max(1.0, state.length * (1.0 - la) + measured_len * la)
    next_conf = clamp(state.confidence * 0.72 + measured_conf * 0.28, 0.0, 1.0)

    return TemporalState(
        tip_x=tip_x,
        tip_y=tip_y,
        vel_x=next_vx,
        vel_y=next_vy,
        dir_x=next_dir[0],
        dir_y=next_dir[1],
        length=next_len,
        confidence=next_conf,
    )


def line_profile_score(
    gray: np.ndarray,
    grad: np.ndarray,
    px: float,
    py: float,
    dir_x: float,
    dir_y: float,
) -> float:
    h, w = gray.shape
    ix = int(round(px))
    iy = int(round(py))
    if ix < 4 or ix >= w - 4 or iy < 4 or iy >= h - 4:
        return -1e9

    nx = -dir_y
    ny = dir_x
    c = float(gray[iy, ix])

    s1a = float(gray[int(round(py + ny * 1.6)), int(round(px + nx * 1.6))])
    s1b = float(gray[int(round(py - ny * 1.6)), int(round(px - nx * 1.6))])
    s2a = float(gray[int(round(py + ny * 3.1)), int(round(px + nx * 3.1))])
    s2b = float(gray[int(round(py - ny * 3.1)), int(round(px - nx * 3.1))])
    ridge = c - ((s1a + s1b) * 0.35 + (s2a + s2b) * 0.15)
    edge = abs(s1a - s1b) * 0.34 + abs(s2a - s2b) * 0.16

    around = (
        float(gray[iy, ix + 2])
        + float(gray[iy, ix - 2])
        + float(gray[iy + 2, ix])
        + float(gray[iy - 2, ix])
    ) * 0.25
    blob = c - around
    g = float(grad[iy, ix])

    return ridge * 1.35 + edge * 0.45 + blob * 0.72 + g * 0.95


def topk_indices(values: np.ndarray, k: int) -> list[int]:
    if values.size == 0:
        return []
    k = max(1, min(int(k), values.size))
    idx = np.argpartition(values, -k)[-k:]
    idx = idx[np.argsort(values[idx])[::-1]]
    return idx.tolist()


def detect_candidates_ridge_dp(
    gray: np.ndarray,
    prior: PriorPoint,
    angle_window_deg: float,
    angle_step_deg: float,
    radius_step: float,
    min_radius_px: float,
    max_radius_px: float,
    edge_quantile: float,
    score_threshold: float,
    max_angle_step_bins: int,
    angle_step_penalty: float,
    continuity_bonus: float,
    distal_bias: float,
    distal_start_ratio: float,
    tip_search_radius: int,
    top_k: int,
) -> list[Candidate]:
    h, w = gray.shape
    grad = sobel_grad(gray)

    base_dir = normalize(prior.tip_x - prior.wrist_x, prior.tip_y - prior.wrist_y)
    if base_dir is None:
        return []
    base_dx, base_dy = base_dir
    base_theta = math.atan2(base_dy, base_dx)

    roi_x0 = max(0, int(math.floor(prior.wrist_x - max_radius_px - 3)))
    roi_x1 = min(w, int(math.ceil(prior.wrist_x + max_radius_px + 3)))
    roi_y0 = max(0, int(math.floor(prior.wrist_y - max_radius_px - 3)))
    roi_y1 = min(h, int(math.ceil(prior.wrist_y + max_radius_px + 3)))
    if roi_x1 <= roi_x0 or roi_y1 <= roi_y0:
        return []

    roi_grad = grad[roi_y0:roi_y1, roi_x0:roi_x1]
    if roi_grad.size < 64:
        return []
    edge_floor = float(np.quantile(roi_grad, clamp(edge_quantile, 0.5, 0.995)))

    angles_deg = np.arange(
        -angle_window_deg,
        angle_window_deg + 1e-6,
        max(0.2, angle_step_deg),
        dtype=np.float32,
    )
    radii = np.arange(
        min_radius_px,
        max_radius_px + 1e-6,
        max(0.5, radius_step),
        dtype=np.float32,
    )
    if angles_deg.size < 3 or radii.size < 4:
        return []

    n_r = int(radii.size)
    n_a = int(angles_deg.size)
    score_map = np.full((n_r, n_a), -1e9, dtype=np.float32)
    px_map = np.full((n_r, n_a), np.nan, dtype=np.float32)
    py_map = np.full((n_r, n_a), np.nan, dtype=np.float32)

    for a_idx, a_off in enumerate(angles_deg):
        theta = base_theta + math.radians(float(a_off))
        dx = math.cos(theta)
        dy = math.sin(theta)
        for r_idx, radius in enumerate(radii):
            px = prior.wrist_x + dx * float(radius)
            py = prior.wrist_y + dy * float(radius)
            ix = int(round(px))
            iy = int(round(py))
            if ix < 4 or ix >= w - 4 or iy < 4 or iy >= h - 4:
                continue
            if grad[iy, ix] < edge_floor:
                continue
            score = line_profile_score(gray, grad, px, py, dx, dy)
            if score < score_threshold:
                continue
            score_map[r_idx, a_idx] = score
            px_map[r_idx, a_idx] = px
            py_map[r_idx, a_idx] = py

    dp = np.full((n_r, n_a), -1e9, dtype=np.float32)
    back = np.full((n_r, n_a), -1, dtype=np.int16)

    valid0 = score_map[0] > -1e8
    dp[0, valid0] = score_map[0, valid0]

    max_step = max(1, int(max_angle_step_bins))
    for r_idx in range(1, n_r):
        for a_idx in range(n_a):
            s = score_map[r_idx, a_idx]
            if s <= -1e8:
                continue
            lo = max(0, a_idx - max_step)
            hi = min(n_a - 1, a_idx + max_step)
            prev = dp[r_idx - 1, lo : hi + 1]
            if prev.size == 0:
                continue
            local_best = int(np.argmax(prev))
            prev_score = float(prev[local_best])
            if prev_score <= -1e8:
                continue
            prev_idx = lo + local_best
            turn_penalty = abs(prev_idx - a_idx) * angle_step_penalty
            dp[r_idx, a_idx] = s + prev_score - turn_penalty + continuity_bonus
            back[r_idx, a_idx] = prev_idx

    start_r = int(clamp(distal_start_ratio, 0.2, 0.95) * (n_r - 1))
    final_scores = np.full(n_a, -1e9, dtype=np.float32)
    final_r = np.full(n_a, -1, dtype=np.int32)
    for a_idx in range(n_a):
        best_local = -1e9
        best_ri = -1
        for r_idx in range(start_r, n_r):
            v = float(dp[r_idx, a_idx])
            if v <= -1e8:
                continue
            distal = (r_idx / max(1, n_r - 1)) * distal_bias
            v2 = v + distal
            if v2 > best_local:
                best_local = v2
                best_ri = r_idx
        final_scores[a_idx] = best_local
        final_r[a_idx] = best_ri

    top_idx = topk_indices(final_scores, top_k)
    if not top_idx:
        return []

    raw_sorted = sorted([float(final_scores[i]) for i in top_idx], reverse=True)
    top0 = raw_sorted[0]
    top1 = raw_sorted[1] if len(raw_sorted) > 1 else top0
    margin = (top0 - top1) / max(abs(top0), 1e-6)

    candidates: list[Candidate] = []
    for a_idx in top_idx:
        r_idx = int(final_r[a_idx])
        score = float(final_scores[a_idx])
        if r_idx < 0 or score <= -1e8:
            continue

        support = 0
        rr = r_idx
        aa = int(a_idx)
        while rr >= 0 and aa >= 0:
            if score_map[rr, aa] > -1e8:
                support += 1
            prev = int(back[rr, aa]) if rr > 0 else -1
            rr -= 1
            aa = prev

        tip_x = float(px_map[r_idx, a_idx])
        tip_y = float(py_map[r_idx, a_idx])
        if not math.isfinite(tip_x) or not math.isfinite(tip_y):
            continue

        theta = base_theta + math.radians(float(angles_deg[a_idx]))
        dir_x = math.cos(theta)
        dir_y = math.sin(theta)

        best_local_score = -1e9
        best_tip_x = tip_x
        best_tip_y = tip_y
        for oy in range(-tip_search_radius, tip_search_radius + 1):
            py = int(round(tip_y + oy))
            if py < 4 or py >= h - 4:
                continue
            for ox in range(-tip_search_radius, tip_search_radius + 1):
                px = int(round(tip_x + ox))
                if px < 4 or px >= w - 4:
                    continue
                if ox * ox + oy * oy > tip_search_radius * tip_search_radius:
                    continue
                forward = (px - prior.wrist_x) * dir_x + (py - prior.wrist_y) * dir_y
                if forward <= 0:
                    continue
                local = line_profile_score(gray, grad, float(px), float(py), dir_x, dir_y) + forward * 0.004
                if local > best_local_score:
                    best_local_score = local
                    best_tip_x = float(px)
                    best_tip_y = float(py)

        shift = math.hypot(best_tip_x - prior.tip_x, best_tip_y - prior.tip_y)
        score_norm = score / max(1.0, support)
        candidates.append(
            Candidate(
                tip_x=best_tip_x,
                tip_y=best_tip_y,
                score=score_norm,
                margin=max(0.0, margin),
                support=support,
                shift_from_prior=shift,
            )
        )

    return candidates


def choose_candidate(
    candidates: list[Candidate],
    prior: PriorPoint,
    temporal_state: TemporalState | None,
    hyp_motion_cost: float,
    hyp_prior_cost: float,
    hyp_score_weight: float,
) -> Candidate | None:
    if not candidates:
        return None

    if temporal_state is None or len(candidates) == 1:
        return max(candidates, key=lambda c: c.score)

    expected_x = prior.wrist_x + temporal_state.dir_x * temporal_state.length + temporal_state.vel_x
    expected_y = prior.wrist_y + temporal_state.dir_y * temporal_state.length + temporal_state.vel_y

    best: Candidate | None = None
    best_cost = 1e12
    for c in candidates:
        d_motion = math.hypot(c.tip_x - expected_x, c.tip_y - expected_y)
        d_prior = math.hypot(c.tip_x - prior.tip_x, c.tip_y - prior.tip_y)
        cost = d_motion * hyp_motion_cost + d_prior * hyp_prior_cost - c.score * hyp_score_weight
        if cost < best_cost:
            best_cost = cost
            best = c
    return best


def apply_gates_and_blend(
    candidate: Candidate | None,
    prior: PriorPoint,
    min_support: int,
    min_margin: float,
    min_score: float,
    max_shift_from_prior: float,
    blend: float,
) -> Detection:
    if candidate is None:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0, 0.0)

    applied = (
        candidate.support >= min_support
        and candidate.margin >= min_margin
        and candidate.score >= min_score
        and candidate.shift_from_prior <= max_shift_from_prior
    )
    if not applied:
        return Detection(
            tip_x=prior.tip_x,
            tip_y=prior.tip_y,
            applied=False,
            score=candidate.score,
            margin=candidate.margin,
            support=candidate.support,
            shift_from_prior=candidate.shift_from_prior,
        )

    a = clamp(blend, 0.0, 1.0)
    out_x = prior.tip_x + (candidate.tip_x - prior.tip_x) * a
    out_y = prior.tip_y + (candidate.tip_y - prior.tip_y) * a
    return Detection(
        tip_x=out_x,
        tip_y=out_y,
        applied=True,
        score=candidate.score,
        margin=candidate.margin,
        support=candidate.support,
        shift_from_prior=candidate.shift_from_prior,
    )


def run() -> None:
    args = parse_args()

    truth, max_gap, video_url = load_truth(args.truth_json, args.track_id)
    ensure_frames(args, video_url)

    first = frame_path(args.frames_dir, args.frame_start)
    if not first.exists():
        raise FileNotFoundError(f"Missing frame image: {first}")
    with Image.open(first) as image:
        frame_w, frame_h = image.size

    prior_map, source_w, source_h = load_prior_map(args.trace_json, args.track_id, frame_w, frame_h)
    scale_x = source_w / max(1.0, frame_w)
    scale_y = source_h / max(1.0, frame_h)

    rows: list[dict[str, object]] = []
    dists: list[float] = []
    prior_dists: list[float] = []
    improved = 0
    compared = 0
    applied_count = 0
    temporal_state: TemporalState | None = None

    for frame in range(args.frame_start, args.frame_end + 1):
        prior = prior_map.get(frame)
        if prior is None:
            continue

        gt = interpolate_point(truth, frame / args.fps, max_gap)
        if gt is None:
            continue

        fp = frame_path(args.frames_dir, frame)
        if not fp.exists():
            continue
        gray = load_gray(fp)

        working_prior = (
            blended_prior_from_state(
                prior=prior,
                state=temporal_state,
                temporal_prior_weight=args.temporal_prior_weight,
                temporal_prior_max_shift=args.temporal_prior_max_shift,
            )
            if args.temporal_enabled
            else prior
        )

        candidates = detect_candidates_ridge_dp(
            gray=gray,
            prior=working_prior,
            angle_window_deg=args.angle_window_deg,
            angle_step_deg=args.angle_step_deg,
            radius_step=args.radius_step,
            min_radius_px=args.min_radius_px,
            max_radius_px=args.max_radius_px,
            edge_quantile=args.edge_quantile,
            score_threshold=args.score_threshold,
            max_angle_step_bins=args.max_angle_step_bins,
            angle_step_penalty=args.angle_step_penalty,
            continuity_bonus=args.continuity_bonus,
            distal_bias=args.distal_bias,
            distal_start_ratio=args.distal_start_ratio,
            tip_search_radius=args.tip_search_radius,
            top_k=args.multi_hyp_k,
        )
        selected = choose_candidate(
            candidates,
            prior=working_prior,
            temporal_state=temporal_state,
            hyp_motion_cost=args.hyp_motion_cost,
            hyp_prior_cost=args.hyp_prior_cost,
            hyp_score_weight=args.hyp_score_weight,
        )
        detection = apply_gates_and_blend(
            selected,
            prior=working_prior,
            min_support=args.min_support,
            min_margin=args.min_margin,
            min_score=args.min_score,
            max_shift_from_prior=args.max_shift_from_prior,
            blend=args.blend,
        )

        out_x = detection.tip_x
        out_y = detection.tip_y
        temporal_pull = 0.0
        if args.temporal_enabled and temporal_state is not None:
            expected_x = prior.wrist_x + temporal_state.dir_x * temporal_state.length + temporal_state.vel_x
            expected_y = prior.wrist_y + temporal_state.dir_y * temporal_state.length + temporal_state.vel_y
            temporal_pull = clamp(args.temporal_expected_blend * temporal_state.confidence, 0.0, 0.75)
            if detection.applied:
                out_x = out_x * (1.0 - temporal_pull) + expected_x * temporal_pull
                out_y = out_y * (1.0 - temporal_pull) + expected_y * temporal_pull
            else:
                out_x = out_x * (1.0 - temporal_pull * 0.5) + expected_x * (temporal_pull * 0.5)
                out_y = out_y * (1.0 - temporal_pull * 0.5) + expected_y * (temporal_pull * 0.5)

        temporal_state = update_temporal_state(
            state=temporal_state,
            wrist_x=prior.wrist_x,
            wrist_y=prior.wrist_y,
            tip_x=out_x,
            tip_y=out_y,
            detection=detection,
            dir_alpha=args.temporal_dir_alpha,
            len_alpha=args.temporal_len_alpha,
            vel_alpha=args.temporal_vel_alpha,
            max_step=args.temporal_max_step,
        )

        if detection.applied:
            applied_count += 1

        gt_x = gt[0] * frame_w
        gt_y = gt[1] * frame_h
        dist = math.hypot((out_x - gt_x) * scale_x, (out_y - gt_y) * scale_y)
        prior_dist = math.hypot((prior.tip_x - gt_x) * scale_x, (prior.tip_y - gt_y) * scale_y)

        dists.append(dist)
        prior_dists.append(prior_dist)
        compared += 1
        if dist < prior_dist:
            improved += 1

        rows.append(
            {
                "frame": frame,
                "gt_x": gt_x,
                "gt_y": gt_y,
                "prior_x": prior.tip_x,
                "prior_y": prior.tip_y,
                "working_prior_x": working_prior.tip_x,
                "working_prior_y": working_prior.tip_y,
                "tip_x": out_x,
                "tip_y": out_y,
                "dist": dist,
                "prior_dist": prior_dist,
                "applied": detection.applied,
                "score": detection.score,
                "margin": detection.margin,
                "support": detection.support,
                "shift_from_prior": detection.shift_from_prior,
                "temporal_pull": temporal_pull,
                "candidate_count": len(candidates),
            }
        )

    if args.output_csv and rows:
        with open(args.output_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

    hit8 = sum(1 for d in dists if d <= 8)
    hit12 = sum(1 for d in dists if d <= 12)
    hit20 = sum(1 for d in dists if d <= 20)
    prior_hit12 = sum(1 for d in prior_dists if d <= 12)

    print("offline-ridge-path-experiment")
    print(f"track={args.track_id} frames={args.frame_start}-{args.frame_end} trace={Path(args.trace_json).name}")
    print(
        "params "
        f"angleWin={args.angle_window_deg:.1f} angleStep={args.angle_step_deg:.2f} radiusStep={args.radius_step:.2f} "
        f"r={args.min_radius_px:.1f}-{args.max_radius_px:.1f} edgeQ={args.edge_quantile:.3f}"
    )
    print(
        "dp "
        f"scoreThr={args.score_threshold:.3f} maxAngleBins={args.max_angle_step_bins} anglePenalty={args.angle_step_penalty:.3f} "
        f"contBonus={args.continuity_bonus:.3f} distalBias={args.distal_bias:.3f} distalStart={args.distal_start_ratio:.2f}"
    )
    print(
        "select "
        f"topK={args.multi_hyp_k} motionCost={args.hyp_motion_cost:.3f} priorCost={args.hyp_prior_cost:.3f} "
        f"scoreWeight={args.hyp_score_weight:.3f}"
    )
    print(
        "gates "
        f"minSupport={args.min_support} minMargin={args.min_margin:.3f} minScore={args.min_score:.3f} "
        f"maxShift={args.max_shift_from_prior:.1f} blend={args.blend:.2f}"
    )
    if args.temporal_enabled:
        print(
            "temporal "
            f"priorW={args.temporal_prior_weight:.2f} priorMaxShift={args.temporal_prior_max_shift:.1f} "
            f"dirA={args.temporal_dir_alpha:.2f} lenA={args.temporal_len_alpha:.2f} velA={args.temporal_vel_alpha:.2f} "
            f"expectedBlend={args.temporal_expected_blend:.2f} maxStep={args.temporal_max_step:.1f}"
        )

    print(
        "distPx "
        f"mean={float(np.mean(dists)) if dists else float('nan'):.2f} "
        f"median={percentile(dists, 0.5):.2f} p90={percentile(dists, 0.9):.2f} p95={percentile(dists, 0.95):.2f}"
    )
    print(
        "hitRate "
        f"<=8 {hit8}/{len(dists)} ({(100.0 * hit8 / max(1, len(dists))):.1f}%), "
        f"<=12 {hit12}/{len(dists)} ({(100.0 * hit12 / max(1, len(dists))):.1f}%), "
        f"<=20 {hit20}/{len(dists)} ({(100.0 * hit20 / max(1, len(dists))):.1f}%)"
    )
    print(
        "priorDistPx "
        f"mean={float(np.mean(prior_dists)) if prior_dists else float('nan'):.2f} "
        f"median={percentile(prior_dists, 0.5):.2f} p90={percentile(prior_dists, 0.9):.2f} p95={percentile(prior_dists, 0.95):.2f}"
    )
    print(
        "priorHit<=12 "
        f"{prior_hit12}/{len(prior_dists)} ({(100.0 * prior_hit12 / max(1, len(prior_dists))):.1f}%)"
    )
    print(
        "improvedVsPrior "
        f"{improved}/{compared} ({(100.0 * improved / max(1, compared)):.1f}%)"
    )
    print(f"appliedFrames {applied_count}/{len(dists)}")


if __name__ == "__main__":
    run()
