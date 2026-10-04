#!/usr/bin/env python3

from __future__ import annotations

import argparse
import glob
import json
import math
import statistics
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class Keyframe:
    time: float
    x: float
    y: float


@dataclass
class Metrics:
    count: int
    mean: float
    median: float
    p90: float
    p95: float
    hit8: int
    hit12: int
    hit20: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate exported fencers trace JSON against hand-edited truth")
    parser.add_argument(
        "--truth-json",
        default=str(Path.home() / "Downloads" / "tiptrack-short-clip-hand-edited.json"),
    )
    parser.add_argument(
        "--trace-json",
        action="append",
        default=[],
        help="Path to trace JSON (repeatable)",
    )
    parser.add_argument(
        "--trace-glob",
        default="",
        help="Glob pattern for trace files when --trace-json is not provided",
    )
    parser.add_argument("--track-id", default="all", choices=["all", "A", "B"])
    parser.add_argument("--frame-start", type=int, default=-1, help="Optional lower bound on frameAt30")
    parser.add_argument("--frame-end", type=int, default=-1, help="Optional upper bound on frameAt30")
    parser.add_argument("--fallback-width", type=float, default=1920.0)
    parser.add_argument("--fallback-height", type=float, default=1080.0)
    parser.add_argument("--sort-by", default="A_hit12pct", choices=["A_hit12pct", "A_mean", "B_hit12pct", "B_mean", "exportedAt"])
    return parser.parse_args()


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    idx = (len(ordered) - 1) * p
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return ordered[lo]
    alpha = idx - lo
    return ordered[lo] * (1.0 - alpha) + ordered[hi] * alpha


def load_truth(truth_json: str) -> tuple[dict[str, list[Keyframe]], float]:
    with open(truth_json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    tracks: dict[str, list[Keyframe]] = {}
    for track in payload.get("tracks", []):
        track_id = str(track.get("id"))
        rows = [
            Keyframe(time=float(k["time"]), x=float(k["x"]), y=float(k["y"]))
            for k in track.get("keyframes", [])
        ]
        rows.sort(key=lambda row: row.time)
        tracks[track_id] = rows

    return tracks, float(payload.get("maxGapSeconds", 5.0))


def interpolate(track: list[Keyframe], t: float, max_gap_seconds: float) -> tuple[float, float] | None:
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


def compute_metrics(dists: list[float]) -> Metrics:
    if not dists:
        return Metrics(0, float("nan"), float("nan"), float("nan"), float("nan"), 0, 0, 0)
    return Metrics(
        count=len(dists),
        mean=float(statistics.fmean(dists)),
        median=percentile(dists, 0.5),
        p90=percentile(dists, 0.9),
        p95=percentile(dists, 0.95),
        hit8=sum(1 for d in dists if d <= 8.0),
        hit12=sum(1 for d in dists if d <= 12.0),
        hit20=sum(1 for d in dists if d <= 20.0),
    )


def percent(numerator: int, denominator: int) -> float:
    return (100.0 * numerator / denominator) if denominator > 0 else float("nan")


def select_files(args: argparse.Namespace) -> list[str]:
    if args.trace_json:
        return args.trace_json
    if not args.trace_glob:
        raise ValueError("Provide --trace-json or --trace-glob")
    return sorted(glob.glob(args.trace_glob))


def evaluate_trace(
    trace_json: str,
    truth_tracks: dict[str, list[Keyframe]],
    truth_max_gap: float,
    frame_start: int,
    frame_end: int,
    fallback_width: float,
    fallback_height: float,
) -> dict[str, object]:
    with open(trace_json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    source = payload.get("source", {})
    width = float(source.get("width", fallback_width))
    height = float(source.get("height", fallback_height))

    dists_by_track: dict[str, list[float]] = {"A": [], "B": []}

    for entry in payload.get("trace", []):
        frame_at_30 = entry.get("frameAt30")
        if isinstance(frame_at_30, (int, float)):
            frame_num = int(frame_at_30)
            if frame_start >= 0 and frame_num < frame_start:
                continue
            if frame_end >= 0 and frame_num > frame_end:
                continue

        media_time = entry.get("mediaTime")
        if not isinstance(media_time, (int, float)):
            continue
        t = float(media_time)

        detections = entry.get("detections", [])
        if not isinstance(detections, list):
            continue
        detection_by_id = {
            str(det.get("id")): det
            for det in detections
            if isinstance(det, dict) and isinstance(det.get("id"), str)
        }

        for track_id in ("A", "B"):
            truth_track = truth_tracks.get(track_id)
            if not truth_track:
                continue
            gt = interpolate(truth_track, t, truth_max_gap)
            if gt is None:
                continue
            det = detection_by_id.get(track_id)
            if not det:
                continue
            tip = det.get("tip")
            if not isinstance(tip, dict):
                continue
            x = tip.get("x")
            y = tip.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                continue

            dx = (float(x) - gt[0]) * width
            dy = (float(y) - gt[1]) * height
            dists_by_track[track_id].append(math.hypot(dx, dy))

    exported_at_raw = payload.get("exportedAt")
    exported_at_iso = ""
    if isinstance(exported_at_raw, (int, float)):
        exported_at_iso = datetime.fromtimestamp(float(exported_at_raw) / 1000.0).isoformat(timespec="milliseconds")

    metrics_a = compute_metrics(dists_by_track["A"])
    metrics_b = compute_metrics(dists_by_track["B"])

    return {
        "file": trace_json,
        "exportedAt": exported_at_iso,
        "sessionId": payload.get("sessionId", ""),
        "A": metrics_a,
        "B": metrics_b,
    }


def print_result(result: dict[str, object], track_id: str) -> None:
    file_name = Path(str(result["file"])).name
    exported_at = str(result.get("exportedAt", ""))
    session_id = str(result.get("sessionId", ""))

    print(f"{file_name}")
    print(f"  exportedAt={exported_at} sessionId={session_id}")

    tracks = [track_id] if track_id in {"A", "B"} else ["A", "B"]
    for tid in tracks:
        metrics: Metrics = result[tid]  # type: ignore[assignment]
        print(
            "  "
            f"{tid}: n={metrics.count} mean={metrics.mean:.2f} median={metrics.median:.2f} "
            f"p90={metrics.p90:.2f} p95={metrics.p95:.2f} "
            f"<=8 {metrics.hit8}/{metrics.count} ({percent(metrics.hit8, metrics.count):.1f}%) "
            f"<=12 {metrics.hit12}/{metrics.count} ({percent(metrics.hit12, metrics.count):.1f}%) "
            f"<=20 {metrics.hit20}/{metrics.count} ({percent(metrics.hit20, metrics.count):.1f}%)"
        )


def sort_key(row: dict[str, object], key: str) -> float:
    if key == "exportedAt":
        exported = row.get("exportedAt", "")
        if not isinstance(exported, str) or not exported:
            return float("-inf")
        try:
            return datetime.fromisoformat(exported).timestamp()
        except ValueError:
            return float("-inf")

    if key == "A_hit12pct":
        metrics: Metrics = row["A"]  # type: ignore[assignment]
        return percent(metrics.hit12, metrics.count)
    if key == "A_mean":
        metrics = row["A"]  # type: ignore[assignment]
        return -metrics.mean
    if key == "B_hit12pct":
        metrics = row["B"]  # type: ignore[assignment]
        return percent(metrics.hit12, metrics.count)

    metrics = row["B"]  # type: ignore[assignment]
    return -metrics.mean


def main() -> None:
    args = parse_args()
    truth_tracks, truth_max_gap = load_truth(args.truth_json)
    trace_files = select_files(args)
    if not trace_files:
        raise ValueError("No trace files selected")

    results = [
        evaluate_trace(
            trace_json=trace,
            truth_tracks=truth_tracks,
            truth_max_gap=truth_max_gap,
            frame_start=args.frame_start,
            frame_end=args.frame_end,
            fallback_width=args.fallback_width,
            fallback_height=args.fallback_height,
        )
        for trace in trace_files
    ]

    reverse = args.sort_by != "A_mean" and args.sort_by != "B_mean"
    results.sort(key=lambda row: sort_key(row, args.sort_by), reverse=reverse)

    print(
        "evaluate-fencers-trace "
        f"truth={args.truth_json} track={args.track_id} "
        f"frameRange={args.frame_start if args.frame_start >= 0 else 'all'}-"
        f"{args.frame_end if args.frame_end >= 0 else 'all'} count={len(results)}"
    )
    for result in results:
        print_result(result, args.track_id)


if __name__ == "__main__":
    main()
