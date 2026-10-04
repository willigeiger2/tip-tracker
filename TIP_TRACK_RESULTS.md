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
