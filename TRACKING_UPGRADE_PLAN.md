# Tip Track - Tracking Upgrade Plan

**Created**: 2026-09-26
**Status**: Draft
**Scope**: Improve live two-fencer tracking quality (identity stability + tip accuracy) before KV storage.

---

## 1. Goals

1. Keep stable A/B identities through crossings and brief occlusions.
2. Improve tip accuracy beyond raw pose/wrist extrapolation.
3. Produce reliability-aware auto-seed drafts for manual refinement.
4. Preserve current recorded/manual editing workflow and file schema compatibility.

## 2. Constraints

- Two fencers tracked simultaneously from one video feed.
- Pose detector runs with `numPoses = 2` (single model pass, not two separate detector graphs).
- A/B colors stay consistent in-app, but side mapping (red-left vs red-right footage) must be configurable.
- Camera and recorded modes must keep current behavior.

## 3. Architecture (proposed)

### 3.1 Fencer Tracker Layer

Add `src/lib/app/fencer-tracker.ts` as a stateful association layer between detector outputs and app IDs.

- Input: per-person tip candidates from current inference frame.
- State: last A/B positions, velocities, confidence, last-seen timestamps.
- Output: stable `DetectionResult[]` with IDs `A` and `B`.

Matching strategy (phase 1):

- Cost = motion distance to predicted position + soft side prior + confidence penalty.
- Solve 2x2 assignment each frame; allow unmatched tracks.
- Maintain identity across centerline crossings (left/right is a prior, not identity truth).

### 3.2 Tip Refinement Layer

Use pose-derived tip as a prior; refine in a local ROI.

Phase 1: no extra model, lightweight geometric refinement only.

- Search along forearm direction with edge/line cues.
- Constrain movement by temporal velocity and plausible arm geometry.

Future phase: dedicated tip model can replace/augment refinement.

### 3.3 Reliability Scoring

Compute per-track reliability score each inference frame from:

- landmark visibility/confidence
- temporal consistency (position/velocity residual)
- geometric plausibility (forearm->tip distance/angle)
- refinement evidence strength

Use score for:

- UI diagnostics
- auto-seed gating/thinning (skip low-reliability points)

### 3.4 Depth Handling

- Keep current 2.5D depth as a rendering signal, not identity truth.
- Manual keyframes remain x/y authoritative.
- If depth is needed later in labels, add as derived/optional metadata, not required input.

## 4. Phases

### Phase A - Identity Stability Foundation

1. Add `FencerTracker` with deterministic two-target assignment.
2. Integrate into pose detection path first; keep hand path unchanged initially.
3. Add side-mapping control (`A-left/B-right` vs `A-right/B-left`, plus quick swap action).
4. Unit tests: crossing sequences, missed detections, re-acquisition without ID swap.

### Phase B - Tip Accuracy Improvement

1. Add local refinement pass around pose prior.
2. Add reliability score calculation.
3. Feed reliability into auto-seed conversion (threshold + optional thinning).

### Phase C - Validation / Hardening

1. Compare live vs generated draft on real fencing clips.
2. Tune thresholds for false swap rate and jitter.
3. Document recommended settings and known limitations.

## 5. Success Criteria

- Crossings no longer frequently swap A/B IDs.
- Auto-seed drafts require noticeably less manual cleanup.
- Pose mode tip traces are less jittery and closer to blade tip.
- System remains real-time on target hardware.

## 6. Immediate Next Tasks

1. Implement Phase A skeleton (`FencerTracker`) and wire into pose path.
2. Add first-pass tests for assignment behavior.
3. Add side mapping control in UI/state.
