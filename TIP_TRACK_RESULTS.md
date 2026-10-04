# Tip Track Results Log

This file tracks the best measured results per session and ties them to artifacts
(trace exports, commands, and git refs).

## Measurement Protocol

- Truth file: `/Users/willi/Downloads/tiptrack-short-clip-hand-edited.json`
- App-trace evaluator: `python3 scripts/evaluate_fencers_trace.py ...`
- Offline template experiment: `python3 scripts/offline_template_bank_experiment.py ...`
- Pixel space: trace-native source dimensions (fallback `1920x1080`)
- Commit correlation: record `git rev-parse --short HEAD` plus `+dirty` if uncommitted changes are present

## Session Bests

| Date | Kind | Git Ref | Artifact | Window | Key Result | Notes |
|---|---|---|---|---|---|---|
| 2026-10-02 | App trace | unknown | `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (1).json` (`exportedAt=2026-10-02T14:46:21.809`) | full overlap | `A <=12: 17/153 (11.1%)`, `A mean: 39.94px`; `B <=12: 1/146 (0.7%)` | Best A hit-rate among current trace exports in Downloads. |
| 2026-10-03 | App trace | unknown | `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (9).json` (`exportedAt=2026-10-03T20:50:21.848`) | full overlap | `A <=12: 15/162 (9.3%)`, `A mean: 39.99px`; `B <=12: 3/155 (1.9%)` | Latest trace before template-in-app test export. |
| 2026-10-03 | App trace (template-enabled test) | `e9375f9+dirty-step10` | `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (10).json` (`exportedAt=2026-10-03T22:49:19.594`) | full overlap | `A <=12: 12/166 (7.2%)`, `A mean: 41.49px`; `B <=12: 6/156 (3.8%)` | A regressed vs (9), B improved. In `450-760`: `A <=12: 6/136 (4.4%)`, mean `45.00px`. |
| 2026-10-04 | App trace (temporal trial) | `b6ce42b+dirty-temporal-app` | `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (11).json` (`exportedAt=2026-10-04T16:10:11.648`) | full overlap | `A <=12: 18/163 (11.0%)`, `A mean: 39.42px`; `B <=12: 7/154 (4.5%)` | Strong recovery vs (10); near best historic A hit-rate. In `450-760`: `A <=12: 8/134 (6.0%)`, mean `41.36px`. |
| 2026-10-04 | App trace (manual tuned params) | `b6ce42b+dirty-temporal-app` | `tweakedBladeLengthAndWristBlend.json` (`exportedAt=2026-10-04T16:12:14.906`) | full overlap | `A <=12: 25/164 (15.2%)`, `A mean: 38.96px`; `B <=12: 2/157 (1.3%)` | Settings: `A ext=4.4`, `B ext=4.0`, `B wrist=1.0`. In `450-760`: `A <=12: 19/133 (14.3%)`, `B <=12: 2/126 (1.6%)`. |
| 2026-10-04 | App trace (defaults) | `b6ce42b+dirty-temporal-app` | `defaultValues.json` (`exportedAt=2026-10-04T16:15:47.944`) | full overlap | `A <=12: 0/162 (0.0%)`, `A mean: 73.18px`; `B <=12: 0/156 (0.0%)` | Defaults (`A/B ext=3.6`, `B wrist=0.35`) performed dramatically worse. In `450-760`: both tracks `0.0%` at `<=12`. |
| 2026-10-04 | App trace (adaptive on, equal ext start) | `b6ce42b+dirty-adaptive-equal44` | `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (12).json` (`exportedAt=2026-10-04T16:34:14.338`) | full overlap | `A <=12: 23/162 (14.2%)`, `A mean: 35.59px`; `B <=12: 1/155 (0.6%)` | Settings exported: `adaptiveTuningEnabled=true`, `A ext=4.4`, `B ext=4.4`, `A/B wrist=0.35`. In `450-760`: `A <=12: 11/132 (8.3%)`, `B <=12: 1/125 (0.8%)`. |
| 2026-10-03 | Offline template refinement | `e9375f9+dirty-step10` | prior trace: `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (9).json` | frames `450-760`, track `A`, require prior | refined `<=12: 91/279 (32.6%)`, mean `19.65px` vs prior `<=12: 71/279 (25.4%)`, mean `20.31px` | Template experiment enabled config below. |

## Commands Used For 2026-10-03 Entry

```bash
python3 scripts/evaluate_fencers_trace.py \
  --trace-glob "/Users/willi/Downloads/tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452*.json" \
  --track-id all

python3 scripts/offline_template_bank_experiment.py \
  --track-id A \
  --feature gray \
  --template-w 27 \
  --template-h 11 \
  --tip-anchor-x 0.5 \
  --tip-anchor-y 0.5 \
  --use-weight-mask \
  --search-rx 28 \
  --search-ry 16 \
  --search-rx-max 84 \
  --search-ry-max 48 \
  --prior-trace-json "/Users/willi/Downloads/tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (9).json" \
  --require-prior \
  --prior-refine-min-score 0.58 \
  --prior-refine-min-margin 0.004 \
  --max-shift-from-prior 28 \
  --prior-blend 0.8 \
  --bank-nearest-k 9
```

## Update Rule

- Add one row per session-best result (not every run).
- Always include artifact path and timestamp (`exportedAt` for traces).
- If evaluating uncommitted code, keep `+dirty` in `Git Ref`.

## Current Start Defaults For This Video

- Recommended starting settings:
  - `fencerATipExtension=4.4`
  - `fencerBTipExtension=4.4`
  - `fencerAWristWeight=0.35`
  - `fencerBWristWeight=0.35` (conservative start; let adaptive tuning raise if needed)
- Basis: use equal blade-length prior for both tracks to avoid reinforcing likely B-side wrist/pose mislocalization artifacts; adaptive tuning can adjust from this start. `B wrist=1.0` remains a tested candidate, not a proven universal default.

## Blade-Line Experiment Notes (2026-10-03)

- Harness: `scripts/offline_blade_line_experiment.py` (Hough-style line vote in a wrist-anchored forward wedge + distal tip search).
- Metrics note: distances/hit-rate are now reported in source-video pixel space (same basis as trace evaluator), even though detection runs on 960px extracted frames.
- Dataset: track `A`, frames `450-760`, trace prior `tiptrack-fencers-trace-bcbf1e349f2b494a3dfa31deb8928452 (9).json`.
- Baseline (no temporal) was weak: prior `<=12 10/132 (7.6%)` and refined remained `10/132 (7.6%)` with default strict gates.
- Aggressive gates increased applied frames but regressed quality (example on same window: `appliedFrames 100/132`, `<=12 4/132 (3.0%)`, mean `108.52px`).
- Spot-check on track `B` in the same period was also weak with line-only mode (little/no `<=12` lift).

## Temporal + Blade-Line Follow-up (2026-10-03)

- Added temporal state to `scripts/offline_blade_line_experiment.py`: prior blending from previous frame state (direction/length/velocity) plus optional pull toward temporal expectation.
- With tuned config on `A` (`wedge=66.1`, `angleWin=79.9`, `edgeQ=0.92`, `tol=1.4`, `minSupport=23`, `minMargin=0.009`, `minLineScore=0.060`, `maxShift=20.2`, `blend=0.86`, temporal prior weight `0.86`), results improved:
  - Trace `(9)`, frames `450-760`: prior `<=12 10/132 (7.6%)` -> refined `12/132 (9.1%)`; mean `43.12px` -> `41.80px`.
  - Trace `(10)`, frames `450-760`: prior `<=12 9/135 (6.7%)` -> refined `15/135 (11.1%)`; mean `44.72px` -> `43.09px`.
  - Full available overlap also improved for `A`:
    - Trace `(9)`: prior `18/161 (11.2%)` -> refined `22/161 (13.7%)`.
    - Trace `(10)`: prior `15/164 (9.1%)` -> refined `24/164 (14.6%)`.
- `B` remained mostly flat on `<=12` with this config (no clear deterioration in tested traces).

## Ridge-Path Attempt (Approach 1)

- New harness: `scripts/offline_ridge_path_experiment.py` (single-frame ridge-path DP over angle/radius lattice).
- Result: no robust lift over prior tips in tested sweeps; either no-op under strict gates or severe degradation under permissive gates.
- Decision: keep as exploratory/reference, not a promoted direction.

## Endpoint + Multi-Hypothesis + Temporal (Approaches 2+3)

- Extended `scripts/offline_blade_line_experiment.py` with:
  - endpoint-weighted scoring (`ridge/blob/edge/distal`),
  - multi-hypothesis line candidates (`topK`, per-angle peaks, theta/rho NMS),
  - temporal-aware hypothesis selection (motion/prior cost),
  - temporal prior blending and expected-tip pull.
- Best robust config found so far:
  - Temporal: `priorW=0.1739`, `priorMaxShift=34.9883`, `dirA=0.052`, `lenA=0.366`, `velA=0.4928`, `expectedBlend=0.3555`, `maxStep=10.0663`
  - Line/endpoint/hypothesis: `wedge=87.624`, `angleWin=74.923`, `edgeQ=0.9473`, `tol=1.908`, `topK=3`, `peaksPerAngle=3`, `thetaNms=1.601`, `rhoNms=4.156`, `ridgeW=1.201`, `blobW=1.115`, `edgeW=0.344`, `distalW=0.156`, `motionCost=0.023`, `priorCost=0.026`, `lineW=0.511`, `endpointW=0.342`, `minSupport=13`, `minMargin=0.0173`, `minLineScore=0.0782`, `maxShift=18.984`, `blend=0.803`
- A-track results (full overlap):
  - Trace `(9)`: prior `<=12 18/161 (11.2%)` -> refined `24/161 (14.9%)`; mean `40.38px` -> `38.03px`.
  - Trace `(10)`: prior `<=12 15/164 (9.1%)` -> refined `26/164 (15.9%)`; mean `41.87px` -> `39.34px`.
- A-track results (frames `450-760`):
  - Trace `(9)`: prior `10/132 (7.6%)` -> refined `11/132 (8.3%)`; mean `43.12px` -> `41.89px`.
  - Trace `(10)`: prior `9/135 (6.7%)` -> refined `10/135 (7.4%)`; mean `44.72px` -> `43.03px`.
- B-track impact (full overlap):
  - Trace `(9)`: prior `3/154 (1.9%)` -> refined `5/154 (3.2%)`.
  - Trace `(10)`: prior `7/155 (4.5%)` -> refined `7/155 (4.5%)` (neutral), mean improved.
- Interim status: this is the most promising non-ML direction so far and worth controlled app integration behind a flag (starting with A-only if needed).
