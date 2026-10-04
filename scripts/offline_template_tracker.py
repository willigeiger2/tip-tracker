#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import math
import os
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Offline template-based blade-tip tracker experiment harness"
    )
    parser.add_argument(
        "--truth-json",
        default=str(Path.home() / "Downloads" / "tiptrack-short-clip-hand-edited.json"),
    )
    parser.add_argument(
        "--track-id",
        default="A",
        choices=["A", "B"],
    )
    parser.add_argument(
        "--frames-dir",
        default="/var/folders/66/r7987msj6bq2t5jtzjcwg0jr0000gn/T/opencode/tiptrack-template-exp/frames_960",
    )
    parser.add_argument("--extract-frames", action="store_true")
    parser.add_argument("--init-frame", type=int, default=602)
    parser.add_argument("--frame-start", type=int, default=450)
    parser.add_argument("--frame-end", type=int, default=760)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--template-w", type=int, default=39)
    parser.add_argument("--template-h", type=int, default=17)
    parser.add_argument(
        "--feature",
        default="gray",
        choices=["gray", "grad"],
        help="Template feature space",
    )
    parser.add_argument("--tip-anchor-x", type=float, default=-1.0)
    parser.add_argument("--tip-anchor-y", type=float, default=0.5)
    parser.add_argument("--search-rx", type=int, default=68)
    parser.add_argument("--search-ry", type=int, default=32)
    parser.add_argument("--search-rx-max", type=int, default=220)
    parser.add_argument("--search-ry-max", type=int, default=110)
    parser.add_argument("--min-score", type=float, default=0.24)
    parser.add_argument("--update-score", type=float, default=0.42)
    parser.add_argument("--template-alpha", type=float, default=0.18)
    parser.add_argument("--hit-radius-px", type=float, default=12.0)
    parser.add_argument("--output-csv", default="")
    parser.add_argument("--overlay-dir", default="")
    parser.add_argument(
        "--prior-trace-json",
        default="",
        help="Optional fencers trace JSON to provide per-frame prior tip locations",
    )
    parser.add_argument(
        "--prior-weight",
        type=float,
        default=0.85,
        help="0..1 blend of prior tip vs internal motion prediction",
    )
    parser.add_argument(
        "--max-shift-from-prior",
        type=float,
        default=52.0,
        help="Max accepted shift from prior tip unless score is very strong",
    )
    parser.add_argument(
        "--prior-refine-min-score",
        type=float,
        default=0.72,
        help="Minimum NCC score required to apply a refinement over prior",
    )
    parser.add_argument(
        "--prior-refine-min-margin",
        type=float,
        default=0.025,
        help="Minimum (best-second) score margin to apply refinement over prior",
    )
    parser.add_argument(
        "--prior-blend",
        type=float,
        default=0.35,
        help="Blend weight of template match when refining over prior",
    )
    parser.add_argument(
        "--prior-max-gap",
        type=float,
        default=0.6,
        help="Gap tolerance used when deriving priors from draft tracks",
    )
    parser.add_argument(
        "--overlay-frames",
        default="482,562,571,599,602,624,645,652,684",
        help="Comma-separated frameAt30 indices to render overlays for",
    )
    return parser.parse_args()


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
        data = json.load(f)
    track = next((t for t in data["tracks"] if t["id"] == track_id), None)
    if not track:
        raise ValueError(f"Track {track_id} not found in truth JSON")
    keyframes = [Keyframe(float(k["time"]), float(k["x"]), float(k["y"])) for k in track["keyframes"]]
    keyframes.sort(key=lambda k: k.time)
    max_gap = float(data.get("maxGapSeconds", 5.0))
    video_url = str(data["videoUrl"])
    return keyframes, max_gap, video_url


def interpolate_point(track: list[Keyframe], t: float, max_gap: float) -> tuple[float, float] | None:
    if not track:
        return None
    if t < track[0].time or t > track[-1].time:
        return None
    for i in range(len(track) - 1):
        a = track[i]
        b = track[i + 1]
        if t < a.time or t > b.time:
            continue
        if b.time - a.time > max_gap:
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


def load_frame_feature(path: Path, feature: str) -> np.ndarray:
    with Image.open(path) as image:
        gray = np.array(image.convert("L"), dtype=np.float32) / 255.0
    if feature == "gray":
        return gray
    if feature != "grad":
        raise ValueError(f"Unsupported feature type: {feature}")
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = (gray[:, 2:] - gray[:, :-2]) * 0.5
    gy[1:-1, :] = (gray[2:, :] - gray[:-2, :]) * 0.5
    mag = np.hypot(gx, gy)
    return mag


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


def match_template_ncc(
    image: np.ndarray,
    template: np.ndarray,
    tip_x: float,
    tip_y: float,
    rx: int,
    ry: int,
    anchor_x: float,
    anchor_y: float,
) -> tuple[float, float, float, float]:
    h, w = template.shape

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
        return tip_x, tip_y, -1.0, -1.0

    windows = sliding_window_view(roi, (h, w))
    tpl_centered = template - float(template.mean())
    tpl_norm = float(np.sqrt(np.sum(tpl_centered * tpl_centered))) + 1e-6

    means = windows.mean(axis=(-2, -1), keepdims=True)
    centered = windows - means
    norms = np.sqrt(np.sum(centered * centered, axis=(-2, -1))) + 1e-6
    scores = np.sum(centered * tpl_centered, axis=(-2, -1)) / (norms * tpl_norm)

    yi, xi = np.unravel_index(int(np.argmax(scores)), scores.shape)
    score = float(scores[yi, xi])
    flat = scores.ravel()
    if flat.size > 1:
        second = float(np.partition(flat, -2)[-2])
    else:
        second = -1.0
    out_x = float(x0 + xi + anchor_px)
    out_y = float(y0 + yi + anchor_py)
    return out_x, out_y, score, second


def adaptive_radius(base: int, maximum: int, score: float, lost: int) -> int:
    score_penalty = int(max(0.0, 0.5 - score) * 190)
    lost_penalty = lost * 14
    return min(maximum, base + score_penalty + lost_penalty)


def safe_int_list(values: str) -> set[int]:
    out: set[int] = set()
    for part in values.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.add(int(part))
        except ValueError:
            pass
    return out


def load_prior_trace(
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
        frame_at_30 = int(entry.get("frameAt30", -1))
        if frame_at_30 < 0:
            continue
        detections = entry.get("detections", [])
        det = next((d for d in detections if d.get("id") == track_id), None)
        if not det:
            continue
        tip = det.get("tip") or {}
        x = tip.get("x")
        y = tip.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        q = det.get("seedQuality")
        quality = float(q) if isinstance(q, (int, float)) else 0.0
        priors[frame_at_30] = (float(x) * frame_w, float(y) * frame_h, quality)

    scored_tracks = payload.get("draftFromScoredSamples", {}).get("tracks", [])
    scored_track = next((t for t in scored_tracks if t.get("id") == track_id), None)
    if scored_track:
        keyframes = scored_track.get("keyframes", [])
        points = [
            (float(k["time"]), float(k["x"]) * frame_w, float(k["y"]) * frame_h)
            for k in keyframes
            if isinstance(k, dict)
            and isinstance(k.get("time"), (int, float))
            and isinstance(k.get("x"), (int, float))
            and isinstance(k.get("y"), (int, float))
        ]
        points.sort(key=lambda row: row[0])
        if len(points) >= 2:
            for i in range(len(points) - 1):
                t0, x0, y0 = points[i]
                t1, x1, y1 = points[i + 1]
                dt = t1 - t0
                if dt <= 1e-9 or dt > prior_max_gap:
                    continue
                f0 = int(round(t0 * fps))
                f1 = int(round(t1 * fps))
                span = max(1, f1 - f0)
                for frame in range(f0, f1 + 1):
                    u = (frame - f0) / span
                    x = x0 + (x1 - x0) * u
                    y = y0 + (y1 - y0) * u
                    if frame not in priors:
                        priors[frame] = (x, y, 0.72)
    return priors


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return float("nan")
    idx = int(round((len(sorted_values) - 1) * p))
    return sorted_values[max(0, min(len(sorted_values) - 1, idx))]


def run() -> None:
    args = parse_args()
    keyframes, max_gap, video_url = load_truth(args.truth_json, args.track_id)
    ensure_frames(args, video_url)

    overlay_frames = safe_int_list(args.overlay_frames)
    overlay_dir = Path(args.overlay_dir) if args.overlay_dir else None
    if overlay_dir:
        overlay_dir.mkdir(parents=True, exist_ok=True)

    # establish dimensions from first existing frame
    first_path = frame_path(args.frames_dir, args.frame_start)
    if not first_path.exists():
        raise FileNotFoundError(f"Missing frame file: {first_path}")
    with Image.open(first_path) as first_im:
        frame_w, frame_h = first_im.size

    prior_map = load_prior_trace(
        args.prior_trace_json,
        args.track_id,
        frame_w,
        frame_h,
        args.fps,
        args.prior_max_gap,
    )

    init_t = args.init_frame / args.fps
    init_truth = interpolate_point(keyframes, init_t, max_gap)
    if not init_truth:
        raise ValueError(f"No truth point available for init frame {args.init_frame}")
    init_px = init_truth[0] * frame_w
    init_py = init_truth[1] * frame_h

    anchor_x = args.tip_anchor_x
    if anchor_x < 0:
        anchor_x = 0.2 if args.track_id == "A" else 0.8
    anchor_y = max(0.0, min(1.0, args.tip_anchor_y))

    init_img = load_frame_feature(frame_path(args.frames_dir, args.init_frame), args.feature)
    template = crop_patch(
        init_img,
        init_px,
        init_py,
        args.template_w,
        args.template_h,
        anchor_x,
        anchor_y,
    )
    if template is None:
        raise ValueError("Template crop would be out of bounds; try a different init frame or template size")

    state = TrackerState(x=init_px, y=init_py, vx=0.0, vy=0.0, score=1.0, lost=0)

    rows: list[dict[str, float | int | bool]] = []
    distances: list[float] = []
    hits = 0
    truth_count = 0

    prior_distances: list[float] = []
    prior_hits = 0
    prior_truth_count = 0

    for frame in range(args.frame_start, args.frame_end + 1):
        frame_file = frame_path(args.frames_dir, frame)
        if not frame_file.exists():
            continue
        image = load_frame_feature(frame_file, args.feature)

        motion_x = state.x + state.vx
        motion_y = state.y + state.vy
        prior = prior_map.get(frame)
        prior_x = prior_y = float("nan")
        prior_q = 0.0
        if prior is not None:
            prior_x, prior_y, prior_q = prior
            blend = max(0.0, min(1.0, args.prior_weight))
            pred_x = motion_x * (1.0 - blend) + prior_x * blend
            pred_y = motion_y * (1.0 - blend) + prior_y * blend
        else:
            pred_x = motion_x
            pred_y = motion_y

        rx = adaptive_radius(args.search_rx, args.search_rx_max, state.score, state.lost)
        ry = adaptive_radius(args.search_ry, args.search_ry_max, state.score, state.lost)
        if prior is not None and prior_q < 0.8:
            rx = min(args.search_rx_max, rx + int((0.8 - prior_q) * 120))
            ry = min(args.search_ry_max, ry + int((0.8 - prior_q) * 60))

        match_x, match_y, score, second_score = match_template_ncc(
            image,
            template,
            pred_x,
            pred_y,
            rx,
            ry,
            anchor_x,
            anchor_y,
        )

        force_accept = False
        if prior is not None:
            shift_from_prior = math.hypot(match_x - prior_x, match_y - prior_y)
            score_margin = score - second_score
            should_refine = (
                score >= args.prior_refine_min_score
                and score_margin >= args.prior_refine_min_margin
                and shift_from_prior <= args.max_shift_from_prior
            )
            if should_refine:
                blend = max(0.0, min(1.0, args.prior_blend))
                match_x = prior_x + (match_x - prior_x) * blend
                match_y = prior_y + (match_y - prior_y) * blend
            else:
                match_x = prior_x
                match_y = prior_y
                force_accept = True

        if score >= args.min_score or force_accept:
            new_vx = match_x - state.x
            new_vy = match_y - state.y
            state = TrackerState(
                x=match_x,
                y=match_y,
                vx=0.6 * state.vx + 0.4 * new_vx,
                vy=0.6 * state.vy + 0.4 * new_vy,
                score=score,
                lost=0,
            )
            if score >= args.update_score:
                patch = crop_patch(
                    image,
                    match_x,
                    match_y,
                    args.template_w,
                    args.template_h,
                    anchor_x,
                    anchor_y,
                )
                if patch is not None:
                    template = (1.0 - args.template_alpha) * template + args.template_alpha * patch
        else:
            state = TrackerState(
                x=state.x + state.vx,
                y=state.y + state.vy,
                vx=state.vx * 0.7,
                vy=state.vy * 0.7,
                score=score,
                lost=state.lost + 1,
            )

        t = frame / args.fps
        truth = interpolate_point(keyframes, t, max_gap)
        has_truth = truth is not None
        gt_x = gt_y = float("nan")
        dist = float("nan")
        hit = False
        if has_truth:
            truth_count += 1
            gt_x = truth[0] * frame_w
            gt_y = truth[1] * frame_h
            dist = math.hypot(state.x - gt_x, state.y - gt_y)
            distances.append(dist)
            hit = dist <= args.hit_radius_px
            if hit:
                hits += 1

            if prior is not None:
                prior_truth_count += 1
                prior_dist = math.hypot(prior_x - gt_x, prior_y - gt_y)
                prior_distances.append(prior_dist)
                if prior_dist <= args.hit_radius_px:
                    prior_hits += 1

        row = {
            "frame": frame,
            "pred_x": state.x,
            "pred_y": state.y,
            "score": score,
            "search_rx": rx,
            "search_ry": ry,
            "lost": state.lost,
            "prior_x": prior_x,
            "prior_y": prior_y,
            "prior_q": prior_q,
            "has_truth": has_truth,
            "gt_x": gt_x,
            "gt_y": gt_y,
            "dist_px": dist,
            "hit": hit,
        }
        rows.append(row)

        if overlay_dir and frame in overlay_frames:
            with Image.open(frame_file) as base:
                draw = ImageDraw.Draw(base)
                draw.ellipse(
                    [state.x - 6, state.y - 6, state.x + 6, state.y + 6],
                    outline=(255, 0, 0),
                    width=3,
                )
                if has_truth:
                    draw.ellipse(
                        [gt_x - 6, gt_y - 6, gt_x + 6, gt_y + 6],
                        outline=(0, 255, 0),
                        width=3,
                    )
                    draw.line([(state.x, state.y), (gt_x, gt_y)], fill=(255, 255, 0), width=2)
                draw.rectangle(
                    [
                        state.x - rx,
                        state.y - ry,
                        state.x + rx,
                        state.y + ry,
                    ],
                    outline=(255, 128, 0),
                    width=2,
                )
                out = overlay_dir / f"overlay_f{frame:04d}.png"
                base.save(out)

    if args.output_csv:
        with open(args.output_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

    distances_sorted = sorted(distances)
    mean_dist = float(np.mean(distances)) if distances else float("nan")
    median_dist = percentile(distances_sorted, 0.5)
    p90 = percentile(distances_sorted, 0.9)
    p95 = percentile(distances_sorted, 0.95)

    hit8 = sum(1 for d in distances if d <= 8.0)
    hit12 = sum(1 for d in distances if d <= 12.0)
    hit20 = sum(1 for d in distances if d <= 20.0)

    print("offline-template-tracker")
    print(f"track={args.track_id} frames={args.frame_start}-{args.frame_end} init={args.init_frame}")
    print(
        "params "
        f"feature={args.feature} tpl={args.template_w}x{args.template_h} "
        f"anchor=({anchor_x:.2f},{anchor_y:.2f}) baseSearch={args.search_rx}x{args.search_ry} "
        f"minScore={args.min_score:.2f} updateScore={args.update_score:.2f} alpha={args.template_alpha:.2f}"
    )
    print(f"truthFrames={truth_count} matchedFrames={len(distances)}")
    print(
        "distPx "
        f"mean={mean_dist:.2f} median={median_dist:.2f} p90={p90:.2f} p95={p95:.2f}"
    )
    print(
        "hitRate "
        f"<=8px {hit8}/{len(distances)} ({(100.0 * hit8 / max(1, len(distances))):.1f}%), "
        f"<=12px {hit12}/{len(distances)} ({(100.0 * hit12 / max(1, len(distances))):.1f}%), "
        f"<=20px {hit20}/{len(distances)} ({(100.0 * hit20 / max(1, len(distances))):.1f}%)"
    )
    print(
        "primaryHit "
        f"<= {args.hit_radius_px:.1f}px {hits}/{truth_count} "
        f"({(100.0 * hits / max(1, truth_count)):.1f}%)"
    )

    if prior_distances:
        prior_sorted = sorted(prior_distances)
        print(
            "priorDistPx "
            f"mean={float(np.mean(prior_distances)):.2f} "
            f"median={percentile(prior_sorted, 0.5):.2f} "
            f"p90={percentile(prior_sorted, 0.9):.2f} "
            f"p95={percentile(prior_sorted, 0.95):.2f}"
        )
        print(
            "priorHit "
            f"<= {args.hit_radius_px:.1f}px {prior_hits}/{prior_truth_count} "
            f"({(100.0 * prior_hits / max(1, prior_truth_count)):.1f}%)"
        )


if __name__ == "__main__":
    run()
