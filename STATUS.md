# Tip Track - Status

**Updated**: 2026-10-14

## Where things stand

Working end to end: camera and video sources, frame-accurate transport, hand/pose/fencers live
tracking, auto-seeded recorded drafts, keyframe editor, KV-backed track library, trace export
for evaluation.

**Current focus: source-of-truth (SOT) data.** Run the tool on new videos, auto-seed drafts, and
hand-correct them until they are accurate. These tracks become the yardstick for any future
tracking work (and potential training data for an image-based tip detector).

## Tracking accuracy findings

Measured with `scripts/evaluate_fencers_trace.py` against a hand-edited truth file for clip
`bcbf1e349f2b494a3dfa31deb8928452` (1920x1080), fencers mode, blade length 4.4.

| Fencer | Median error | Within 20 px | Notes |
|---|---|---|---|
| A (right side) | ~31-33 px | ~26% | Usable draft. Wrist-to-tip distance is stable (CV 0.04) and the blade is within ~8 deg of the forearm line, so the pose wrist really is the sword hand. |
| B (left side) | ~140 px | ~0-1% | Not usable. See below. |

- **Blade length matters most.** Default 3.6 scored 0% within 12 px; 4.4 is now the default.
- **Tip refinement didn't help.** Image-based refinement around the pose tip (edge/fan search,
  template matching, adaptive tuning, offline blade-line and ridge-path experiments) never beat
  plain forearm extension by a meaningful margin. Removed from the app; preserved at tag
  `archive/tip-refinement-experiments`.
- **Fencer B: the pose model doesn't see the sword hand.** Only one wrist is confidently detected
  (other wrist visibility ~0.16 in 138/151 frames), and it is mostly not the sword hand: its
  distance to the true tip varies 17% and the implied blade direction is off by 10-90 deg.
  Choosing the weapon arm geometrically (forward-most wrist) can't fix this because there is
  no second candidate. Fixing B needs an image-based hand/blade/tip detector, which is the main
  argument for building SOT data first.
- **Weapon-arm selection** (forward-most wrist with hysteresis) is kept: neutral on this clip,
  should help on footage where MediaPipe swaps left/right labels with both hands visible.

## Next steps

1. **SOT workflow on new videos.** Expect to hand-place most of fencer B on clips like the test
   clip. Note editor pain points as you go; editor improvements (faster hotkeys, nudge, verified
   flags, zoom) likely pay off more than detection tweaks right now.
2. **Version finished truth files** in the repo (e.g. `truth/<videoId>.json`) rather than only
   in KV / Downloads.
3. **Astro-style refactor** of `src/pages/index.astro` (~2,400 lines): move markup, styles and
   client logic into components and lib modules so the page is mostly components and layouts.
   Behaviour-preserving, in reviewable steps.
4. **Known issues** (backlog): occasional `NotSupportedError` playback freeze (mitigated by
   auto-reload on Play failure); occasional frame-step jank on some encodes; `npm audit`
   reports outdated transitive deps (sharp et al.).
5. **Later: tip accuracy, with SOT in hand.** Score candidates offline using trace exports
   (which include upper-body pose landmarks). The parked Playwright trace runner on branch
   `video-mode/step-12-automated-trace-runner` can automate runs once worth reviving.

## History

- Steps 1-7 (foundation refactor, video source, transport, recorded mode, keyframe editor,
  auto-seed, KV storage) followed `docs/history/VIDEO_MODE_PLAN.md`.
- Step 8 added fencers mode (`docs/history/TRACKING_UPGRADE_PLAN.md`); step 9 added per-fencer
  tuning and quality-scored auto-seed.
- Steps 10-12 (tip-refinement experiments, trace runner) are archived; the cleanup on
  2026-10-14 restarted from step 9, removed refinement and added weapon-arm selection.
