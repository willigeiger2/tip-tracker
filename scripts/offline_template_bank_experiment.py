#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from PIL import Image, ImageDraw


@dataclass
class Keyframe:
    time: float
    x: float
    y: float


@dataclass
class TrackerState:
    x: float
    y: float
    vx: float
    vy: float
    score: float
    lost: int


@dataclass
class MatchResult:
    x: float
    y: float
    score: float
    second_score: float
    template_index: int
    gt_score: float
    gt_rank: float


@dataclass
class DiscriminantModel:
    center: np.ndarray
    weights: np.ndarray


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline template-bank blade-tip tracking experiment")
    parser.add_argument(
        "--truth-json",
        default=str(Path.home() / "Downloads" / "tiptrack-short-clip-hand-edited.json"),
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

    parser.add_argument("--init-frame", type=int, default=602)
    parser.add_argument("--bank-frames", default="482,562,571,599,602,624,645,652,684")
    parser.add_argument("--bank-nearest-k", type=int, default=4)
    parser.add_argument(
        "--manual-template-glob",
        default="",
        help="Optional glob for hand-picked template images",
    )
    parser.add_argument(
        "--manual-tip-points",
        default="",
        help="Optional per-image tip pixels: filename:x:y,filename2:x:y",
    )
    parser.add_argument("--feature", default="gray", choices=["gray", "grad"])
    parser.add_argument("--template-w", type=int, default=39)
    parser.add_argument("--template-h", type=int, default=17)
    parser.add_argument("--tip-anchor-x", type=float, default=-1.0)
    parser.add_argument("--tip-anchor-y", type=float, default=0.5)

    parser.add_argument("--use-weight-mask", action="store_true")
    parser.add_argument("--tip-focus-weight", type=float, default=2.0)
    parser.add_argument("--tip-focus-radius", type=float, default=5.0)
    parser.add_argument("--blade-focus-weight", type=float, default=1.0)
    parser.add_argument("--blade-focus-sigma-y", type=float, default=1.5)

    parser.add_argument("--disc-weight", type=float, default=0.0)
    parser.add_argument("--disc-neg-samples", type=int, default=20)
    parser.add_argument("--disc-neg-min-radius", type=float, default=6.0)
    parser.add_argument("--disc-neg-max-radius", type=float, default=28.0)
    parser.add_argument("--disc-seed", type=int, default=42)
    parser.add_argument("--blade-line-weight", type=float, default=0.0)
    parser.add_argument("--blade-line-length", type=int, default=28)
    parser.add_argument("--blade-line-half-width", type=int, default=1)

    parser.add_argument("--search-rx", type=int, default=26)
    parser.add_argument("--search-ry", type=int, default=13)
    parser.add_argument("--search-rx-max", type=int, default=84)
    parser.add_argument("--search-ry-max", type=int, default=42)
    parser.add_argument(
        "--search-center-mode",
        default="prior_or_motion",
        choices=["prior_or_motion", "truth"],
    )

    parser.add_argument("--min-score", type=float, default=0.24)
    parser.add_argument("--update-score", type=float, default=0.42)
    parser.add_argument("--template-alpha", type=float, default=0.18)

    parser.add_argument("--prior-trace-json", default="")
    parser.add_argument("--require-prior", action="store_true")
    parser.add_argument("--prior-weight", type=float, default=0.85)
    parser.add_argument("--prior-max-gap", type=float, default=0.6)
    parser.add_argument("--max-shift-from-prior", type=float, default=18.0)
    parser.add_argument("--prior-refine-min-score", type=float, default=0.62)
    parser.add_argument("--prior-refine-min-margin", type=float, default=0.01)
    parser.add_argument("--prior-blend", type=float, default=0.8)

    parser.add_argument("--hit-radius-px", type=float, default=12.0)
    parser.add_argument("--output-csv", default="")
    parser.add_argument("--overlay-dir", default="")
    parser.add_argument("--overlay-frames", default="482,562,571,599,602,624,645,652,684")
    return parser.parse_args()


def parse_int_csv(raw: str) -> list[int]:
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            pass
    return out


def parse_manual_tip_points(raw: str) -> dict[str, tuple[float, float]]:
    points: dict[str, tuple[float, float]] = {}
    if not raw:
        return points
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        tokens = part.split(":")
        if len(tokens) != 3:
            continue
        name = tokens[0].strip()
        try:
            x = float(tokens[1].strip())
            y = float(tokens[2].strip())
        except ValueError:
            continue
        points[name] = (x, y)
    return points


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


def load_truth(truth_json: str, track_id: str) -> tuple[list[Keyframe], float, str]:
    with open(truth_json, "r", encoding="utf-8") as f:
        payload = json.load(f)
    track = next((t for t in payload["tracks"] if t["id"] == track_id), None)
    if not track:
        raise ValueError(f"Track {track_id} not found in {truth_json}")
    keyframes = [Keyframe(float(k["time"]), float(k["x"]), float(k["y"])) for k in track["keyframes"]]
    keyframes.sort(key=lambda row: row.time)
    return keyframes, float(payload.get("maxGapSeconds", 5.0)), str(payload["videoUrl"])


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
        if b.time - a.time > max_gap_seconds:
            return None
        dt = b.time - a.time
        if dt <= 1e-9:
            return (a.x, a.y)
        u = (t - a.time) / dt
        return (a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u)
    if abs(t - track[-1].time) <= 1e-9:
        return (track[-1].x, track[-1].y)
    return None


def frame_path(frames_dir: str, frame_at_30: int) -> Path:
    return Path(frames_dir) / f"f30_{frame_at_30 + 1:05d}.jpg"


def load_feature_image(path: Path, feature: str) -> np.ndarray:
    with Image.open(path) as image:
        gray = np.array(image.convert("L"), dtype=np.float32) / 255.0
    if feature == "gray":
        return gray
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = (gray[:, 2:] - gray[:, :-2]) * 0.5
    gy[1:-1, :] = (gray[2:, :] - gray[:-2, :]) * 0.5
    return np.hypot(gx, gy)


def image_to_feature(gray: np.ndarray, feature: str) -> np.ndarray:
    if feature == "gray":
        return gray
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = (gray[:, 2:] - gray[:, :-2]) * 0.5
    gy[1:-1, :] = (gray[2:, :] - gray[:-2, :]) * 0.5
    return np.hypot(gx, gy)


def load_manual_templates(
    pattern: str,
    feature: str,
    template_w: int,
    template_h: int,
    anchor_x: float,
    anchor_y: float,
    tip_points: dict[str, tuple[float, float]],
) -> list[np.ndarray]:
    if not pattern:
        return []
    templates: list[np.ndarray] = []
    for path in sorted(glob.glob(pattern)):
        p = Path(path)
        with Image.open(p) as image:
            gray = np.array(image.convert("L"), dtype=np.float32) / 255.0
        tip = tip_points.get(p.name) or tip_points.get(str(p))
        if tip is not None:
            arr = crop_patch_padded(
                gray,
                tip[0],
                tip[1],
                template_w,
                template_h,
                anchor_x,
                anchor_y,
            )
        else:
            fallback = Image.fromarray((gray * 255.0).astype(np.uint8), mode="L")
            arr = np.array(
                fallback.resize((template_w, template_h), Image.Resampling.BICUBIC),
                dtype=np.float32,
            ) / 255.0
        templates.append(image_to_feature(arr, feature))
    return templates


def crop_patch(
    image: np.ndarray,
    tip_x: float,
    tip_y: float,
    w: int,
    h: int,
    anchor_x: float,
    anchor_y: float,
) -> np.ndarray | None:
    x0 = int(round(tip_x - anchor_x * (w - 1)))
    y0 = int(round(tip_y - anchor_y * (h - 1)))
    x1 = x0 + w
    y1 = y0 + h
    if x0 < 0 or y0 < 0 or x1 > image.shape[1] or y1 > image.shape[0]:
        return None
    return image[y0:y1, x0:x1].copy()


def crop_patch_padded(
    image: np.ndarray,
    tip_x: float,
    tip_y: float,
    w: int,
    h: int,
    anchor_x: float,
    anchor_y: float,
) -> np.ndarray:
    x0 = int(round(tip_x - anchor_x * (w - 1)))
    y0 = int(round(tip_y - anchor_y * (h - 1)))
    x1 = x0 + w
    y1 = y0 + h

    pad_left = max(0, -x0)
    pad_top = max(0, -y0)
    pad_right = max(0, x1 - image.shape[1])
    pad_bottom = max(0, y1 - image.shape[0])

    if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
        image = np.pad(
            image,
            ((pad_top, pad_bottom), (pad_left, pad_right)),
            mode="edge",
        )
        x0 += pad_left
        y0 += pad_top
        x1 += pad_left
        y1 += pad_top

    return image[y0:y1, x0:x1].copy()


def build_weight_mask(
    w: int,
    h: int,
    anchor_x: float,
    anchor_y: float,
    track_id: str,
    tip_focus_weight: float,
    tip_focus_radius: float,
    blade_focus_weight: float,
    blade_focus_sigma_y: float,
) -> np.ndarray:
    ys, xs = np.mgrid[0:h, 0:w]
    tip_x = anchor_x * (w - 1)
    tip_y = anchor_y * (h - 1)

    weights = np.ones((h, w), dtype=np.float32)

    tip_r2 = max(1.0, tip_focus_radius * tip_focus_radius)
    tip_blob = np.exp(-((xs - tip_x) ** 2 + (ys - tip_y) ** 2) / (2.0 * tip_r2))
    weights += tip_focus_weight * tip_blob

    direction = 1.0 if track_id == "A" else -1.0
    x_end = tip_x + direction * (w * 0.65)
    dx = x_end - tip_x
    t = np.where(abs(dx) > 1e-6, (xs - tip_x) / dx, 0.0)
    on_segment = (t >= 0.0) & (t <= 1.0)
    blade_profile = np.exp(-((ys - tip_y) ** 2) / (2.0 * max(0.25, blade_focus_sigma_y**2)))
    weights += blade_focus_weight * blade_profile * on_segment

    weights *= (h * w) / float(np.sum(weights) + 1e-6)
    return weights.astype(np.float32)


def ncc_score_map(windows: np.ndarray, template: np.ndarray, weights: np.ndarray | None) -> np.ndarray:
    if weights is None:
        tpl_centered = template - float(template.mean())
        tpl_norm = float(np.sqrt(np.sum(tpl_centered * tpl_centered))) + 1e-6
        means = windows.mean(axis=(-2, -1), keepdims=True)
        centered = windows - means
        norms = np.sqrt(np.sum(centered * centered, axis=(-2, -1))) + 1e-6
        return np.sum(centered * tpl_centered, axis=(-2, -1)) / (norms * tpl_norm)

    wsum = float(np.sum(weights)) + 1e-6
    tpl_mean = float(np.sum(template * weights) / wsum)
    tpl_centered = template - tpl_mean
    tpl_energy = float(np.sum(weights * tpl_centered * tpl_centered)) + 1e-6

    means = np.sum(windows * weights, axis=(-2, -1), keepdims=True) / wsum
    centered = windows - means
    num = np.sum(weights * centered * tpl_centered, axis=(-2, -1))
    den = np.sqrt(np.sum(weights * centered * centered, axis=(-2, -1)) * tpl_energy) + 1e-6
    return num / den


def build_discriminant_model(
    frames_dir: str,
    feature: str,
    anchor_frames: list[int],
    keyframes: list[Keyframe],
    fps: float,
    max_gap: float,
    frame_w: int,
    frame_h: int,
    template_w: int,
    template_h: int,
    anchor_x: float,
    anchor_y: float,
    neg_samples_per_frame: int,
    neg_min_radius: float,
    neg_max_radius: float,
    seed: int,
) -> DiscriminantModel | None:
    rng = np.random.default_rng(seed)
    positives: list[np.ndarray] = []
    negatives: list[np.ndarray] = []

    for frame in anchor_frames:
        truth = interpolate_point(keyframes, frame / fps, max_gap)
        if truth is None:
            continue
        fp = frame_path(frames_dir, frame)
        if not fp.exists():
            continue
        image = load_feature_image(fp, feature)
        tip_x = truth[0] * frame_w
        tip_y = truth[1] * frame_h
        pos = crop_patch(image, tip_x, tip_y, template_w, template_h, anchor_x, anchor_y)
        if pos is None:
            continue
        positives.append(pos)

        for _ in range(max(0, neg_samples_per_frame)):
            radius = rng.uniform(neg_min_radius, neg_max_radius)
            angle = rng.uniform(0.0, 2.0 * math.pi)
            nx = tip_x + radius * math.cos(angle)
            ny = tip_y + radius * math.sin(angle)
            neg = crop_patch(image, nx, ny, template_w, template_h, anchor_x, anchor_y)
            if neg is not None:
                negatives.append(neg)

    if not positives or not negatives:
        return None

    pos_mean = np.mean(np.stack(positives, axis=0), axis=0)
    neg_mean = np.mean(np.stack(negatives, axis=0), axis=0)
    center = (pos_mean + neg_mean) * 0.5
    weights = pos_mean - neg_mean
    norm = float(np.sqrt(np.sum(weights * weights))) + 1e-6
    weights = weights / norm
    return DiscriminantModel(center=center.astype(np.float32), weights=weights.astype(np.float32))


def discriminant_score_map(windows: np.ndarray, model: DiscriminantModel) -> np.ndarray:
    centered = windows - model.center
    raw = np.tensordot(centered, model.weights, axes=([2, 3], [0, 1]))
    median = float(np.median(raw))
    std = float(np.std(raw)) + 1e-6
    return np.tanh((raw - median) / (2.0 * std)).astype(np.float32)


def blade_line_score_map(
    image: np.ndarray,
    x0: int,
    y0: int,
    nx: int,
    ny: int,
    anchor_px: int,
    anchor_py: int,
    track_id: str,
    line_length: int,
    half_width: int,
) -> np.ndarray:
    direction = 1 if track_id == "A" else -1
    rows = (y0 + np.arange(ny, dtype=np.int32) + anchor_py).astype(np.int32)
    cols = (x0 + np.arange(nx, dtype=np.int32) + anchor_px).astype(np.int32)
    rows = np.clip(rows, 0, image.shape[0] - 1)
    cols = np.clip(cols, 0, image.shape[1] - 1)

    acc = np.zeros((ny, nx), dtype=np.float32)
    samples = 0

    for dy in range(-half_width, half_width + 1):
        row_idx = np.clip(rows + dy, 0, image.shape[0] - 1)
        for step in range(2, max(3, line_length + 1)):
            col_idx = np.clip(cols + direction * step, 0, image.shape[1] - 1)
            acc += image[row_idx[:, None], col_idx[None, :]]
            samples += 1

    if samples > 0:
        acc /= float(samples)
    median = float(np.median(acc))
    std = float(np.std(acc)) + 1e-6
    return np.tanh((acc - median) / (2.0 * std)).astype(np.float32)


def match_template_bank(
    image: np.ndarray,
    templates: list[np.ndarray],
    tip_x: float,
    tip_y: float,
    rx: int,
    ry: int,
    anchor_x: float,
    anchor_y: float,
    weight_mask: np.ndarray | None,
    discriminant: DiscriminantModel | None,
    disc_weight: float,
    blade_line_weight: float,
    blade_line_length: int,
    blade_line_half_width: int,
    track_id: str,
    gt_x: float | None,
    gt_y: float | None,
) -> MatchResult:
    if not templates:
        return MatchResult(tip_x, tip_y, -1.0, -1.0, -1, float("nan"), float("nan"))

    h, w = templates[0].shape
    anchor_px = int(round(anchor_x * (w - 1)))
    anchor_py = int(round(anchor_y * (h - 1)))

    left_min = int(round(tip_x)) - rx - anchor_px
    left_max = int(round(tip_x)) + rx - anchor_px
    top_min = int(round(tip_y)) - ry - anchor_py
    top_max = int(round(tip_y)) + ry - anchor_py

    x0 = max(0, left_min)
    y0 = max(0, top_min)
    x1 = min(image.shape[1], left_max + w + 1)
    y1 = min(image.shape[0], top_max + h + 1)

    roi = image[y0:y1, x0:x1]
    if roi.shape[0] < h or roi.shape[1] < w:
        return MatchResult(tip_x, tip_y, -1.0, -1.0, -1, float("nan"), float("nan"))

    windows = sliding_window_view(roi, (h, w))

    max_map: np.ndarray | None = None
    idx_map: np.ndarray | None = None
    for idx, template in enumerate(templates):
        scores = ncc_score_map(windows, template, weight_mask)
        if max_map is None:
            max_map = scores.astype(np.float32)
            idx_map = np.zeros(scores.shape, dtype=np.int32)
            continue
        replace = scores > max_map
        max_map = np.where(replace, scores, max_map)
        idx_map = np.where(replace, idx, idx_map)

    assert max_map is not None and idx_map is not None

    score_map = max_map
    if discriminant is not None and disc_weight > 1e-6:
        dmap = discriminant_score_map(windows, discriminant)
        score_map = max_map + dmap * float(disc_weight)
    if blade_line_weight > 1e-6:
        lmap = blade_line_score_map(
            image,
            x0,
            y0,
            max_map.shape[1],
            max_map.shape[0],
            anchor_px,
            anchor_py,
            track_id,
            blade_line_length,
            blade_line_half_width,
        )
        score_map = score_map + lmap * float(blade_line_weight)

    yi, xi = np.unravel_index(int(np.argmax(score_map)), score_map.shape)
    best = float(score_map[yi, xi])
    flat = score_map.ravel()
    second = float(np.partition(flat, -2)[-2]) if flat.size > 1 else -1.0
    out_x = float(x0 + xi + anchor_px)
    out_y = float(y0 + yi + anchor_py)
    tpl_idx = int(idx_map[yi, xi])

    gt_score = float("nan")
    gt_rank = float("nan")
    if gt_x is not None and gt_y is not None:
        gxi = int(round(gt_x)) - anchor_px - x0
        gyi = int(round(gt_y)) - anchor_py - y0
        if 0 <= gxi < max_map.shape[1] and 0 <= gyi < max_map.shape[0]:
            gt_score = float(score_map[gyi, gxi])
            gt_rank = float(np.mean(score_map <= gt_score))

    return MatchResult(out_x, out_y, best, second, tpl_idx, gt_score, gt_rank)


def adaptive_radius(base: int, maximum: int, score: float, lost: int) -> int:
    score_penalty = int(max(0.0, 0.5 - score) * 170)
    lost_penalty = lost * 12
    return min(maximum, base + score_penalty + lost_penalty)


def load_prior_map(
    trace_json_path: str,
    track_id: str,
    frame_w: int,
    frame_h: int,
    fps: float,
    prior_max_gap: float,
) -> dict[int, tuple[float, float, float]]:
    if not trace_json_path:
        return {}
    with open(trace_json_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    priors: dict[int, tuple[float, float, float]] = {}

    for entry in payload.get("trace", []):
        frame_idx = int(entry.get("frameAt30", -1))
        if frame_idx < 0:
            continue
        det = next((d for d in entry.get("detections", []) if d.get("id") == track_id), None)
        if not det:
            continue
        tip = det.get("tip") or {}
        x = tip.get("x")
        y = tip.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        q = det.get("seedQuality")
        quality = float(q) if isinstance(q, (int, float)) else 0.0
        priors[frame_idx] = (float(x) * frame_w, float(y) * frame_h, quality)

    scored_tracks = payload.get("draftFromScoredSamples", {}).get("tracks", [])
    scored_track = next((t for t in scored_tracks if t.get("id") == track_id), None)
    if scored_track:
        points = [
            (float(k["time"]), float(k["x"]) * frame_w, float(k["y"]) * frame_h)
            for k in scored_track.get("keyframes", [])
            if isinstance(k, dict)
            and isinstance(k.get("time"), (int, float))
            and isinstance(k.get("x"), (int, float))
            and isinstance(k.get("y"), (int, float))
        ]
        points.sort(key=lambda row: row[0])
        for i in range(len(points) - 1):
            t0, x0, y0 = points[i]
            t1, x1, y1 = points[i + 1]
            dt = t1 - t0
            if dt <= 1e-9 or dt > prior_max_gap:
                continue
            f0 = int(round(t0 * fps))
            f1 = int(round(t1 * fps))
            span = max(1, f1 - f0)
            for frame_idx in range(f0, f1 + 1):
                u = (frame_idx - f0) / span
                x = x0 + (x1 - x0) * u
                y = y0 + (y1 - y0) * u
                if frame_idx not in priors:
                    priors[frame_idx] = (x, y, 0.72)

    return priors


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * q))
    return ordered[max(0, min(len(ordered) - 1, idx))]


def run() -> None:
    args = parse_args()
    keyframes, max_gap, video_url = load_truth(args.truth_json, args.track_id)
    ensure_frames(args, video_url)

    first_path = frame_path(args.frames_dir, args.frame_start)
    if not first_path.exists():
        raise FileNotFoundError(f"Missing frame {first_path}")
    with Image.open(first_path) as first_image:
        frame_w, frame_h = first_image.size

    anchor_x = args.tip_anchor_x
    if anchor_x < 0:
        anchor_x = 0.2 if args.track_id == "A" else 0.8
    anchor_y = max(0.0, min(1.0, args.tip_anchor_y))
    manual_tip_points = parse_manual_tip_points(args.manual_tip_points)

    prior_map = load_prior_map(
        args.prior_trace_json,
        args.track_id,
        frame_w,
        frame_h,
        args.fps,
        args.prior_max_gap,
    )

    init_truth = interpolate_point(keyframes, args.init_frame / args.fps, max_gap)
    if init_truth is None:
        raise ValueError(f"No truth point at init frame {args.init_frame}")

    init_image = load_feature_image(frame_path(args.frames_dir, args.init_frame), args.feature)
    dynamic_template = crop_patch(
        init_image,
        init_truth[0] * frame_w,
        init_truth[1] * frame_h,
        args.template_w,
        args.template_h,
        anchor_x,
        anchor_y,
    )
    if dynamic_template is None:
        raise ValueError("Unable to crop initial template")

    static_template_entries: list[tuple[int, np.ndarray]] = []
    bank_frames = parse_int_csv(args.bank_frames)
    for frame in bank_frames:
        point = interpolate_point(keyframes, frame / args.fps, max_gap)
        if point is None:
            continue
        fp = frame_path(args.frames_dir, frame)
        if not fp.exists():
            continue
        image = load_feature_image(fp, args.feature)
        patch = crop_patch(
            image,
            point[0] * frame_w,
            point[1] * frame_h,
            args.template_w,
            args.template_h,
            anchor_x,
            anchor_y,
        )
        if patch is not None:
            static_template_entries.append((frame, patch))

    manual_templates = load_manual_templates(
        args.manual_template_glob,
        args.feature,
        args.template_w,
        args.template_h,
        anchor_x,
        anchor_y,
        manual_tip_points,
    )

    discriminant = build_discriminant_model(
        args.frames_dir,
        args.feature,
        bank_frames,
        keyframes,
        args.fps,
        max_gap,
        frame_w,
        frame_h,
        args.template_w,
        args.template_h,
        anchor_x,
        anchor_y,
        args.disc_neg_samples,
        args.disc_neg_min_radius,
        args.disc_neg_max_radius,
        args.disc_seed,
    )

    weight_mask = None
    if args.use_weight_mask:
        weight_mask = build_weight_mask(
            args.template_w,
            args.template_h,
            anchor_x,
            anchor_y,
            args.track_id,
            args.tip_focus_weight,
            args.tip_focus_radius,
            args.blade_focus_weight,
            args.blade_focus_sigma_y,
        )

    state = TrackerState(
        x=init_truth[0] * frame_w,
        y=init_truth[1] * frame_h,
        vx=0.0,
        vy=0.0,
        score=1.0,
        lost=0,
    )

    overlay_frames = set(parse_int_csv(args.overlay_frames))
    overlay_dir = Path(args.overlay_dir) if args.overlay_dir else None
    if overlay_dir:
        overlay_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, float | int | bool]] = []

    dists: list[float] = []
    prior_dists: list[float] = []
    gt_ranks: list[float] = []
    score_margins: list[float] = []
    improved_vs_prior = 0
    compared_vs_prior = 0
    refined_frames = 0
    refined_improved_vs_prior = 0
    refined_compared_vs_prior = 0

    for frame in range(args.frame_start, args.frame_end + 1):
        fp = frame_path(args.frames_dir, frame)
        if not fp.exists():
            continue
        image = load_feature_image(fp, args.feature)

        truth = interpolate_point(keyframes, frame / args.fps, max_gap)
        gt_x = truth[0] * frame_w if truth else None
        gt_y = truth[1] * frame_h if truth else None

        prior = prior_map.get(frame)
        if args.require_prior and prior is None:
            continue
        prior_x = prior[0] if prior else float("nan")
        prior_y = prior[1] if prior else float("nan")
        prior_q = prior[2] if prior else 0.0

        motion_x = state.x + state.vx
        motion_y = state.y + state.vy
        if args.search_center_mode == "truth" and truth:
            pred_x = gt_x
            pred_y = gt_y
        elif prior:
            w = max(0.0, min(1.0, args.prior_weight))
            pred_x = motion_x * (1.0 - w) + prior_x * w
            pred_y = motion_y * (1.0 - w) + prior_y * w
        else:
            pred_x = motion_x
            pred_y = motion_y

        rx = adaptive_radius(args.search_rx, args.search_rx_max, state.score, state.lost)
        ry = adaptive_radius(args.search_ry, args.search_ry_max, state.score, state.lost)
        if prior and prior_q < 0.8:
            rx = min(args.search_rx_max, rx + int((0.8 - prior_q) * 70))
            ry = min(args.search_ry_max, ry + int((0.8 - prior_q) * 36))

        match = match_template_bank(
            image,
            [
                dynamic_template,
                *manual_templates,
                *[
                    item[1]
                    for item in sorted(
                        static_template_entries,
                        key=lambda item: abs(item[0] - frame),
                    )[: max(0, args.bank_nearest_k)]
                ],
            ],
            pred_x,
            pred_y,
            rx,
            ry,
            anchor_x,
            anchor_y,
            weight_mask,
            discriminant,
            args.disc_weight,
            args.blade_line_weight,
            args.blade_line_length,
            args.blade_line_half_width,
            args.track_id,
            gt_x,
            gt_y,
        )

        force_accept = False
        out_x = match.x
        out_y = match.y
        refined_this_frame = False

        if prior:
            shift = math.hypot(match.x - prior_x, match.y - prior_y)
            margin = match.score - match.second_score
            refine = (
                match.score >= args.prior_refine_min_score
                and margin >= args.prior_refine_min_margin
                and shift <= args.max_shift_from_prior
            )
            if refine:
                b = max(0.0, min(1.0, args.prior_blend))
                out_x = prior_x + (match.x - prior_x) * b
                out_y = prior_y + (match.y - prior_y) * b
                refined_this_frame = True
                refined_frames += 1
            else:
                out_x = prior_x
                out_y = prior_y
                force_accept = True

        accepted = match.score >= args.min_score or force_accept
        if accepted:
            vx = out_x - state.x
            vy = out_y - state.y
            state = TrackerState(
                x=out_x,
                y=out_y,
                vx=0.6 * state.vx + 0.4 * vx,
                vy=0.6 * state.vy + 0.4 * vy,
                score=match.score,
                lost=0,
            )
            if match.score >= args.update_score:
                patch = crop_patch(
                    image,
                    state.x,
                    state.y,
                    args.template_w,
                    args.template_h,
                    anchor_x,
                    anchor_y,
                )
                if patch is not None:
                    dynamic_template = (1.0 - args.template_alpha) * dynamic_template + args.template_alpha * patch
        else:
            state = TrackerState(
                x=state.x + state.vx,
                y=state.y + state.vy,
                vx=state.vx * 0.7,
                vy=state.vy * 0.7,
                score=match.score,
                lost=state.lost + 1,
            )

        dist = float("nan")
        hit = False
        if truth:
            dist = math.hypot(state.x - gt_x, state.y - gt_y)
            dists.append(dist)
            hit = dist <= args.hit_radius_px

            if prior:
                pd = math.hypot(prior_x - gt_x, prior_y - gt_y)
                prior_dists.append(pd)
                compared_vs_prior += 1
                if dist < pd:
                    improved_vs_prior += 1
                if refined_this_frame:
                    refined_compared_vs_prior += 1
                    if dist < pd:
                        refined_improved_vs_prior += 1

            if not math.isnan(match.gt_rank):
                gt_ranks.append(match.gt_rank)
                score_margins.append(match.score - match.gt_score)

        rows.append(
            {
                "frame": frame,
                "pred_x": state.x,
                "pred_y": state.y,
                "score": match.score,
                "score_margin": match.score - match.second_score,
                "template_index": match.template_index,
                "gt_score": match.gt_score,
                "gt_rank": match.gt_rank,
                "search_rx": rx,
                "search_ry": ry,
                "lost": state.lost,
                "prior_x": prior_x,
                "prior_y": prior_y,
                "prior_q": prior_q,
                "gt_x": gt_x if truth else float("nan"),
                "gt_y": gt_y if truth else float("nan"),
                "dist_px": dist,
                "hit": hit,
            }
        )

        if overlay_dir and frame in overlay_frames:
            with Image.open(fp) as base:
                draw = ImageDraw.Draw(base)
                draw.rectangle([state.x - rx, state.y - ry, state.x + rx, state.y + ry], outline=(255, 128, 0), width=2)
                draw.ellipse([state.x - 6, state.y - 6, state.x + 6, state.y + 6], outline=(255, 0, 0), width=3)
                if prior:
                    draw.ellipse([prior_x - 5, prior_y - 5, prior_x + 5, prior_y + 5], outline=(0, 128, 255), width=2)
                if truth:
                    draw.ellipse([gt_x - 6, gt_y - 6, gt_x + 6, gt_y + 6], outline=(0, 255, 0), width=3)
                    draw.line([(state.x, state.y), (gt_x, gt_y)], fill=(255, 255, 0), width=2)
                base.save(overlay_dir / f"overlay_f{frame:04d}.png")

    if args.output_csv and rows:
        with open(args.output_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

    hit8 = sum(1 for d in dists if d <= 8)
    hit12 = sum(1 for d in dists if d <= 12)
    hit20 = sum(1 for d in dists if d <= 20)

    print("offline-template-bank-experiment")
    print(f"track={args.track_id} frames={args.frame_start}-{args.frame_end} init={args.init_frame}")
    print(
        "params "
        f"feature={args.feature} templates=1+manual{len(manual_templates)}+auto{len(static_template_entries)}(k={args.bank_nearest_k}) "
        f"tpl={args.template_w}x{args.template_h} "
        f"anchor=({anchor_x:.2f},{anchor_y:.2f}) search={args.search_rx}x{args.search_ry}"
    )
    print(
        "models "
        f"mask={'on' if weight_mask is not None else 'off'} disc={'on' if discriminant is not None and args.disc_weight > 1e-6 else 'off'} "
        f"discWeight={args.disc_weight:.2f} bladeLineWeight={args.blade_line_weight:.2f}"
    )
    print(
        "scores "
        f"min={args.min_score:.2f} upd={args.update_score:.2f} priorRef={args.prior_refine_min_score:.2f}/m{args.prior_refine_min_margin:.3f}"
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
    if prior_dists:
        prior_hit12 = sum(1 for d in prior_dists if d <= 12)
        print(
            "priorDistPx "
            f"mean={float(np.mean(prior_dists)):.2f} median={percentile(prior_dists, 0.5):.2f} "
            f"p90={percentile(prior_dists, 0.9):.2f} p95={percentile(prior_dists, 0.95):.2f}"
        )
        print(
            "priorHit<=12 "
            f"{prior_hit12}/{len(prior_dists)} ({(100.0 * prior_hit12 / max(1, len(prior_dists))):.1f}%)"
        )
    if compared_vs_prior > 0:
        print(
            "improvedVsPrior "
            f"{improved_vs_prior}/{compared_vs_prior} ({(100.0 * improved_vs_prior / compared_vs_prior):.1f}%)"
        )
    if refined_frames > 0:
        print(f"refinedFrames {refined_frames}")
    if refined_compared_vs_prior > 0:
        print(
            "refinedImprovedVsPrior "
            f"{refined_improved_vs_prior}/{refined_compared_vs_prior} "
            f"({(100.0 * refined_improved_vs_prior / refined_compared_vs_prior):.1f}%)"
        )

    if gt_ranks:
        top90 = sum(1 for r in gt_ranks if r >= 0.9)
        top99 = sum(1 for r in gt_ranks if r >= 0.99)
        print(
            "signalAtTruth "
            f"rankMean={float(np.mean(gt_ranks)):.3f} rankMedian={percentile(gt_ranks, 0.5):.3f} "
            f"rank>=0.9 {top90}/{len(gt_ranks)} ({(100.0 * top90 / len(gt_ranks)):.1f}%) "
            f"rank>=0.99 {top99}/{len(gt_ranks)} ({(100.0 * top99 / len(gt_ranks)):.1f}%)"
        )
        print(
            "bestVsTruthScoreGap "
            f"mean={float(np.mean(score_margins)):.3f} median={percentile(score_margins, 0.5):.3f}"
        )


if __name__ == "__main__":
    run()
