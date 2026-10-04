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
class Detection:
    tip_x: float
    tip_y: float
    applied: bool
    line_score: float
    endpoint_score: float
    margin: float
    support_count: int
    shift_from_prior: float
    candidate_count: int


@dataclass
class LineHypothesis:
    theta: float
    rho: float
    acc: float
    tip_x: float
    tip_y: float
    line_score: float
    endpoint_score: float
    support_count: int
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
    parser = argparse.ArgumentParser(description="Offline blade-line tip tracking experiment")
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
    parser.add_argument("--frame-start", type=int, default=450)
    parser.add_argument("--frame-end", type=int, default=760)
    parser.add_argument("--fps", type=float, default=30.0)

    parser.add_argument("--wedge-angle-deg", type=float, default=82.0)
    parser.add_argument("--angle-window-deg", type=float, default=68.0)
    parser.add_argument("--angle-step-deg", type=float, default=1.0)
    parser.add_argument("--edge-quantile", type=float, default=0.88)
    parser.add_argument("--min-radius-px", type=float, default=14.0)
    parser.add_argument("--max-radius-px", type=float, default=230.0)
    parser.add_argument("--rho-bin-px", type=float, default=1.0)
    parser.add_argument("--line-dist-tol-px", type=float, default=1.9)
    parser.add_argument("--support-percentile", type=float, default=0.97)
    parser.add_argument("--tip-search-radius", type=int, default=6)

    parser.add_argument("--line-top-k", type=int, default=1)
    parser.add_argument("--line-peaks-per-angle", type=int, default=2)
    parser.add_argument("--line-theta-nms-deg", type=float, default=2.5)
    parser.add_argument("--line-rho-nms-px", type=float, default=3.0)

    parser.add_argument("--endpoint-ridge-weight", type=float, default=1.55)
    parser.add_argument("--endpoint-blob-weight", type=float, default=1.05)
    parser.add_argument("--endpoint-distal-weight", type=float, default=0.09)
    parser.add_argument("--endpoint-edge-weight", type=float, default=0.45)

    parser.add_argument("--hyp-motion-cost", type=float, default=0.028)
    parser.add_argument("--hyp-prior-cost", type=float, default=0.014)
    parser.add_argument("--hyp-line-score-weight", type=float, default=0.42)
    parser.add_argument("--hyp-endpoint-score-weight", type=float, default=0.36)

    parser.add_argument("--min-support", type=int, default=22)
    parser.add_argument("--min-margin", type=float, default=0.02)
    parser.add_argument("--min-line-score", type=float, default=0.085)
    parser.add_argument("--max-shift-from-prior", type=float, default=22.0)
    parser.add_argument("--blend", type=float, default=0.9)

    parser.add_argument("--hit-radius-px", type=float, default=12.0)
    parser.add_argument("--output-csv", default="")

    parser.add_argument("--temporal-enabled", action="store_true")
    parser.add_argument("--temporal-prior-weight", type=float, default=0.55)
    parser.add_argument("--temporal-prior-max-shift", type=float, default=28.0)
    parser.add_argument("--temporal-dir-alpha", type=float, default=0.28)
    parser.add_argument("--temporal-len-alpha", type=float, default=0.3)
    parser.add_argument("--temporal-vel-alpha", type=float, default=0.22)
    parser.add_argument("--temporal-expected-blend", type=float, default=0.2)
    parser.add_argument("--temporal-max-step", type=float, default=18.0)

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


def topk_indices(values: np.ndarray, k: int) -> list[int]:
    if values.size == 0:
        return []
    k = max(1, min(int(k), values.size))
    idx = np.argpartition(values, -k)[-k:]
    idx = idx[np.argsort(values[idx])[::-1]]
    return idx.tolist()


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


def sobel_grad(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = (gray[:, 2:] - gray[:, :-2]) * 0.5
    gy[1:-1, :] = (gray[2:, :] - gray[:-2, :]) * 0.5
    mag = np.hypot(gx, gy)
    return gx, gy, mag


def normalize(dx: float, dy: float) -> tuple[float, float] | None:
    length = math.hypot(dx, dy)
    if not math.isfinite(length) or length < 1e-6:
        return None
    return (dx / length, dy / length)


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
    measured_conf = clamp(
        detection.line_score * 2.4 + detection.endpoint_score * 0.9 + detection.margin * 0.8,
        0.0,
        1.0,
    )
    if not detection.applied:
        measured_conf = max(0.08, measured_conf * 0.45)

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


def detect_tip_with_hough(
    gray: np.ndarray,
    prior: PriorPoint,
    wedge_angle_deg: float,
    angle_window_deg: float,
    angle_step_deg: float,
    edge_quantile: float,
    min_radius_px: float,
    max_radius_px: float,
    rho_bin_px: float,
    line_dist_tol_px: float,
    support_percentile: float,
    tip_search_radius: int,
    min_support: int,
    min_margin: float,
    min_line_score: float,
    max_shift_from_prior: float,
    blend: float,
    line_top_k: int,
    line_peaks_per_angle: int,
    line_theta_nms_deg: float,
    line_rho_nms_px: float,
    endpoint_ridge_weight: float,
    endpoint_blob_weight: float,
    endpoint_distal_weight: float,
    endpoint_edge_weight: float,
    hyp_motion_cost: float,
    hyp_prior_cost: float,
    hyp_line_score_weight: float,
    hyp_endpoint_score_weight: float,
    expected_tip: tuple[float, float] | None,
) -> Detection:
    h, w = gray.shape
    _, _, grad = sobel_grad(gray)

    base_dir = normalize(prior.tip_x - prior.wrist_x, prior.tip_y - prior.wrist_y)
    if not base_dir:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, 0, 0.0, 0)

    bx, by = base_dir
    prior_theta = math.atan2(by, bx)
    cos_wedge = math.cos(math.radians(max(1.0, min(89.0, wedge_angle_deg))))

    roi_x0 = max(0, int(math.floor(prior.wrist_x - max_radius_px - 2)))
    roi_x1 = min(w, int(math.ceil(prior.wrist_x + max_radius_px + 2)))
    roi_y0 = max(0, int(math.floor(prior.wrist_y - max_radius_px - 2)))
    roi_y1 = min(h, int(math.ceil(prior.wrist_y + max_radius_px + 2)))
    if roi_x1 <= roi_x0 or roi_y1 <= roi_y0:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, 0, 0.0, 0)

    roi_grad = grad[roi_y0:roi_y1, roi_x0:roi_x1]
    if roi_grad.size < 25:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, 0, 0.0, 0)
    edge_threshold = float(np.quantile(roi_grad, clamp(edge_quantile, 0.5, 0.995)))
    yy, xx = np.nonzero(roi_grad >= edge_threshold)
    if xx.size < 40:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, 0, 0.0, 0)

    xs = xx.astype(np.float32) + float(roi_x0)
    ys = yy.astype(np.float32) + float(roi_y0)
    ws = roi_grad[yy, xx].astype(np.float32)

    dx = xs - float(prior.wrist_x)
    dy = ys - float(prior.wrist_y)
    dist = np.hypot(dx, dy)
    dot = dx * bx + dy * by
    cos_angle = dot / np.maximum(dist, 1e-6)
    mask = (
        (dist >= float(min_radius_px))
        & (dist <= float(max_radius_px))
        & (dot > 0)
        & (cos_angle >= cos_wedge)
    )
    if np.count_nonzero(mask) < 30:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, int(np.count_nonzero(mask)), 0.0, 0)

    xs = xs[mask]
    ys = ys[mask]
    ws = ws[mask]

    diag = math.hypot(w, h)
    rho_min = -diag
    rho_max = diag
    rho_bin = max(0.5, float(rho_bin_px))
    rho_bins = int(math.ceil((rho_max - rho_min) / rho_bin)) + 1

    theta_offsets = np.arange(-angle_window_deg, angle_window_deg + 1e-6, max(0.25, angle_step_deg), dtype=np.float32)
    raw_candidates: list[tuple[float, float, float]] = []

    for offset_deg in theta_offsets:
        theta = prior_theta + math.radians(float(offset_deg))
        c = math.cos(theta)
        s = math.sin(theta)
        rho = xs * c + ys * s
        rho_idx = np.floor((rho - rho_min) / rho_bin).astype(np.int32)
        rho_idx = np.clip(rho_idx, 0, rho_bins - 1)
        acc = np.bincount(rho_idx, weights=ws, minlength=rho_bins)
        if acc.size == 0:
            continue
        top_rhos = topk_indices(acc, line_peaks_per_angle)
        for rho_i in top_rhos:
            value = float(acc[rho_i])
            if value <= 0:
                continue
            raw_candidates.append((theta, rho_min + rho_i * rho_bin, value))

    if not raw_candidates:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, 0, 0.0, 0)

    raw_candidates.sort(key=lambda item: item[2], reverse=True)
    theta_nms = math.radians(max(0.2, line_theta_nms_deg))
    rho_nms = max(0.5, line_rho_nms_px)

    filtered: list[tuple[float, float, float]] = []
    cap = max(1, line_top_k * 5)
    for theta, rho, acc_value in raw_candidates:
        keep = True
        for t2, r2, _ in filtered:
            if abs(theta - t2) <= theta_nms and abs(rho - r2) <= rho_nms:
                keep = False
                break
        if keep:
            filtered.append((theta, rho, acc_value))
            if len(filtered) >= cap:
                break

    prior_len = math.hypot(prior.tip_x - prior.wrist_x, prior.tip_y - prior.wrist_y)
    t_min = max(float(min_radius_px), prior_len * 0.58)
    t_max = min(float(max_radius_px), prior_len * 1.45)

    hypotheses: list[LineHypothesis] = []
    for theta, rho, acc_value in filtered:
        c = math.cos(theta)
        s = math.sin(theta)
        line_dir = np.array([-s, c], dtype=np.float32)
        if line_dir[0] * bx + line_dir[1] * by < 0:
            line_dir = -line_dir
        line_dir = line_dir * 0.35 + np.array([bx, by], dtype=np.float32) * 0.65
        line_dir_len = float(np.hypot(line_dir[0], line_dir[1]))
        if line_dir_len > 1e-6:
            line_dir = line_dir / line_dir_len
        else:
            line_dir = np.array([bx, by], dtype=np.float32)

        line_dist = np.abs(xs * c + ys * s - rho)
        proj = (xs - prior.wrist_x) * line_dir[0] + (ys - prior.wrist_y) * line_dir[1]
        support_mask = (line_dist <= float(line_dist_tol_px)) & (proj > 0)
        support_count = int(np.count_nonzero(support_mask))
        if support_count < max(4, min_support // 3):
            continue

        support_proj = proj[support_mask]
        tip_proj = float(np.quantile(support_proj, clamp(support_percentile, 0.6, 1.0)))
        best_profile = -1e9

        if t_max > t_min + 2:
            nx, ny = float(c), float(s)
            steps = int(max(8.0, t_max - t_min))
            for j in range(steps + 1):
                t = t_min + (t_max - t_min) * (j / max(1, steps))
                px = prior.wrist_x + line_dir[0] * t
                py = prior.wrist_y + line_dir[1] * t
                ix = int(round(px))
                iy = int(round(py))
                if ix < 4 or ix >= w - 4 or iy < 4 or iy >= h - 4:
                    continue

                center = float(gray[iy, ix])
                side1a = float(gray[int(round(py + ny * 1.6)), int(round(px + nx * 1.6))])
                side1b = float(gray[int(round(py - ny * 1.6)), int(round(px - nx * 1.6))])
                side2a = float(gray[int(round(py + ny * 3.0)), int(round(px + nx * 3.0))])
                side2b = float(gray[int(round(py - ny * 3.0)), int(round(px - nx * 3.0))])
                ridge = center - ((side1a + side1b) * 0.32 + (side2a + side2b) * 0.18)
                edge_term = abs(side1a - side1b) * 0.3 + abs(side2a - side2b) * 0.14
                around = (
                    float(gray[iy, ix + 3])
                    + float(gray[iy, ix - 3])
                    + float(gray[iy + 3, ix])
                    + float(gray[iy - 3, ix])
                ) * 0.25
                blob = center - around
                distal = t / max(prior_len, 1.0)
                profile = (
                    ridge * endpoint_ridge_weight
                    + blob * endpoint_blob_weight
                    + edge_term * endpoint_edge_weight
                    + distal * endpoint_distal_weight
                )
                if profile > best_profile:
                    best_profile = profile
                    tip_proj = t

        tip_x = float(prior.wrist_x + line_dir[0] * tip_proj)
        tip_y = float(prior.wrist_y + line_dir[1] * tip_proj)

        best_tip_x = tip_x
        best_tip_y = tip_y
        best_tip_score = -1e9
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
                pdx = px - prior.wrist_x
                pdy = py - prior.wrist_y
                forward = pdx * line_dir[0] + pdy * line_dir[1]
                if forward <= 0:
                    continue
                center = float(gray[py, px])
                edge = float(grad[py, px])
                around = (
                    float(gray[py, px + 2])
                    + float(gray[py, px - 2])
                    + float(gray[py + 2, px])
                    + float(gray[py - 2, px])
                ) * 0.25
                blob = center - around
                score = center * 0.5 + edge * 1.4 + blob * endpoint_blob_weight + (forward / max(prior_len, 1.0)) * 0.08
                if score > best_tip_score:
                    best_tip_score = score
                    best_tip_x = float(px)
                    best_tip_y = float(py)

        line_score = acc_value / max(float(support_count), 1.0)
        endpoint_score = math.tanh(max(0.0, best_profile) * 2.0)
        hypotheses.append(
            LineHypothesis(
                theta=theta,
                rho=rho,
                acc=acc_value,
                tip_x=best_tip_x,
                tip_y=best_tip_y,
                line_score=line_score,
                endpoint_score=endpoint_score,
                support_count=support_count,
                shift_from_prior=math.hypot(best_tip_x - prior.tip_x, best_tip_y - prior.tip_y),
            )
        )

    if not hypotheses:
        return Detection(prior.tip_x, prior.tip_y, False, 0.0, 0.0, 0.0, 0, 0.0, len(filtered))

    hypotheses.sort(key=lambda item: item.acc, reverse=True)
    top_hypotheses = hypotheses[: max(1, line_top_k)]

    chosen = top_hypotheses[0]
    if expected_tip is not None and len(top_hypotheses) > 1:
        ex, ey = expected_tip
        best_cost = 1e12
        for hyp in top_hypotheses:
            motion = math.hypot(hyp.tip_x - ex, hyp.tip_y - ey)
            cost = (
                motion * hyp_motion_cost
                + hyp.shift_from_prior * hyp_prior_cost
                - hyp.line_score * hyp_line_score_weight
                - hyp.endpoint_score * hyp_endpoint_score_weight
            )
            if cost < best_cost:
                best_cost = cost
                chosen = hyp
    elif len(top_hypotheses) > 1:
        chosen = max(
            top_hypotheses,
            key=lambda hyp: hyp.line_score * hyp_line_score_weight + hyp.endpoint_score * hyp_endpoint_score_weight,
        )

    second_acc = top_hypotheses[1].acc if len(top_hypotheses) > 1 else chosen.acc
    margin = (chosen.acc - second_acc) / max(chosen.acc, 1e-6) if chosen.acc > 1e-6 else 0.0

    score_for_gate = chosen.line_score + chosen.endpoint_score * 0.35
    applied = (
        margin >= min_margin
        and score_for_gate >= min_line_score
        and chosen.shift_from_prior <= max_shift_from_prior
        and chosen.support_count >= min_support
    )

    if not applied:
        return Detection(
            prior.tip_x,
            prior.tip_y,
            False,
            chosen.line_score,
            chosen.endpoint_score,
            margin,
            chosen.support_count,
            chosen.shift_from_prior,
            len(top_hypotheses),
        )

    a = clamp(blend, 0.0, 1.0)
    out_x = prior.tip_x + (chosen.tip_x - prior.tip_x) * a
    out_y = prior.tip_y + (chosen.tip_y - prior.tip_y) * a
    return Detection(
        out_x,
        out_y,
        True,
        chosen.line_score,
        chosen.endpoint_score,
        margin,
        chosen.support_count,
        chosen.shift_from_prior,
        len(top_hypotheses),
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
    applied_count = 0
    improved_count = 0
    compared_count = 0
    temporal_state: TemporalState | None = None

    for frame in range(args.frame_start, args.frame_end + 1):
        prior = prior_map.get(frame)
        if prior is None:
            continue

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

        gt = interpolate_point(truth, frame / args.fps, max_gap)
        if gt is None:
            continue

        fp = frame_path(args.frames_dir, frame)
        if not fp.exists():
            continue
        gray = load_gray(fp)

        expected_tip = None
        if args.temporal_enabled and temporal_state is not None:
            expected_tip = (
                prior.wrist_x + temporal_state.dir_x * temporal_state.length + temporal_state.vel_x,
                prior.wrist_y + temporal_state.dir_y * temporal_state.length + temporal_state.vel_y,
            )

        detection = detect_tip_with_hough(
            gray=gray,
            prior=working_prior,
            wedge_angle_deg=args.wedge_angle_deg,
            angle_window_deg=args.angle_window_deg,
            angle_step_deg=args.angle_step_deg,
            edge_quantile=args.edge_quantile,
            min_radius_px=args.min_radius_px,
            max_radius_px=args.max_radius_px,
            rho_bin_px=args.rho_bin_px,
            line_dist_tol_px=args.line_dist_tol_px,
            support_percentile=args.support_percentile,
            tip_search_radius=args.tip_search_radius,
            min_support=args.min_support,
            min_margin=args.min_margin,
            min_line_score=args.min_line_score,
            max_shift_from_prior=args.max_shift_from_prior,
            blend=args.blend,
            line_top_k=args.line_top_k,
            line_peaks_per_angle=args.line_peaks_per_angle,
            line_theta_nms_deg=args.line_theta_nms_deg,
            line_rho_nms_px=args.line_rho_nms_px,
            endpoint_ridge_weight=args.endpoint_ridge_weight,
            endpoint_blob_weight=args.endpoint_blob_weight,
            endpoint_distal_weight=args.endpoint_distal_weight,
            endpoint_edge_weight=args.endpoint_edge_weight,
            hyp_motion_cost=args.hyp_motion_cost,
            hyp_prior_cost=args.hyp_prior_cost,
            hyp_line_score_weight=args.hyp_line_score_weight,
            hyp_endpoint_score_weight=args.hyp_endpoint_score_weight,
            expected_tip=expected_tip,
        )

        out_tip_x = detection.tip_x
        out_tip_y = detection.tip_y
        temporal_pull = 0.0
        if args.temporal_enabled and temporal_state is not None:
            expected_tip_x = prior.wrist_x + temporal_state.dir_x * temporal_state.length + temporal_state.vel_x
            expected_tip_y = prior.wrist_y + temporal_state.dir_y * temporal_state.length + temporal_state.vel_y
            temporal_pull = clamp(args.temporal_expected_blend * temporal_state.confidence, 0.0, 0.75)
            if detection.applied:
                out_tip_x = out_tip_x * (1.0 - temporal_pull) + expected_tip_x * temporal_pull
                out_tip_y = out_tip_y * (1.0 - temporal_pull) + expected_tip_y * temporal_pull
            else:
                out_tip_x = out_tip_x * (1.0 - temporal_pull * 0.5) + expected_tip_x * (temporal_pull * 0.5)
                out_tip_y = out_tip_y * (1.0 - temporal_pull * 0.5) + expected_tip_y * (temporal_pull * 0.5)

        temporal_state = update_temporal_state(
            state=temporal_state,
            wrist_x=prior.wrist_x,
            wrist_y=prior.wrist_y,
            tip_x=out_tip_x,
            tip_y=out_tip_y,
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
        dist = math.hypot((out_tip_x - gt_x) * scale_x, (out_tip_y - gt_y) * scale_y)
        prior_dist = math.hypot((prior.tip_x - gt_x) * scale_x, (prior.tip_y - gt_y) * scale_y)
        dists.append(dist)
        prior_dists.append(prior_dist)
        compared_count += 1
        if dist < prior_dist:
            improved_count += 1

        rows.append(
            {
                "frame": frame,
                "gt_x": gt_x,
                "gt_y": gt_y,
                "prior_x": prior.tip_x,
                "prior_y": prior.tip_y,
                "working_prior_x": working_prior.tip_x,
                "working_prior_y": working_prior.tip_y,
                "tip_x": out_tip_x,
                "tip_y": out_tip_y,
                "dist": dist,
                "prior_dist": prior_dist,
                "applied": detection.applied,
                "line_score": detection.line_score,
                "endpoint_score": detection.endpoint_score,
                "margin": detection.margin,
                "support_count": detection.support_count,
                "shift_from_prior": detection.shift_from_prior,
                "candidate_count": detection.candidate_count,
                "temporal_pull": temporal_pull,
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

    print("offline-blade-line-experiment")
    print(f"track={args.track_id} frames={args.frame_start}-{args.frame_end} trace={Path(args.trace_json).name}")
    print(
        "params "
        f"wedge={args.wedge_angle_deg:.1f} angleWin={args.angle_window_deg:.1f} step={args.angle_step_deg:.1f} "
        f"edgeQ={args.edge_quantile:.3f} r={args.min_radius_px:.1f}-{args.max_radius_px:.1f} "
        f"rho={args.rho_bin_px:.1f} tol={args.line_dist_tol_px:.1f} supportP={args.support_percentile:.2f}"
    )
    print(
        "endpoint "
        f"ridgeW={args.endpoint_ridge_weight:.2f} blobW={args.endpoint_blob_weight:.2f} "
        f"edgeW={args.endpoint_edge_weight:.2f} distalW={args.endpoint_distal_weight:.2f} tipSearch={args.tip_search_radius}"
    )
    print(
        "hypothesis "
        f"topK={args.line_top_k} peaksPerAngle={args.line_peaks_per_angle} thetaNms={args.line_theta_nms_deg:.1f} rhoNms={args.line_rho_nms_px:.1f} "
        f"motionCost={args.hyp_motion_cost:.3f} priorCost={args.hyp_prior_cost:.3f} lineW={args.hyp_line_score_weight:.2f} endpointW={args.hyp_endpoint_score_weight:.2f}"
    )
    print(
        "gates "
        f"minSupport={args.min_support} minMargin={args.min_margin:.3f} minLineScore={args.min_line_score:.3f} "
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
        f"{improved_count}/{compared_count} ({(100.0 * improved_count / max(1, compared_count)):.1f}%)"
    )
    print(f"appliedFrames {applied_count}/{len(dists)}")


if __name__ == "__main__":
    run()
