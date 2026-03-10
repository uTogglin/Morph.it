---
phase: 02-keyframe-engine-compositing
plan: "02"
subsystem: animation
tags: [keyframe, interpolation, playback, export, inspector, diamond-toggle, dom]

# Dependency graph
requires:
  - phase: 02-keyframe-engine-compositing
    plan: "01"
    provides: KeyframeEngine.ts pure functions (evaluateEffectParam, addKeyframe, removeKeyframe), Clip.keyframeTracks field, Keyframe/KeyframeTrack types
  - phase: 01-effects-foundation
    provides: EffectChain.process() signature, PlaybackEngine renderFrame(), Exporter export loop, ColorGradingPanel slider infrastructure
provides:
  - PlaybackEngine.renderFrame() evaluates keyframe interpolation per frame before effectChain.process
  - Exporter.export() applies same keyframe evaluation as preview (WYSIWYG export)
  - ColorGradingPanel diamond keyframe toggle button on each effect parameter slider
  - ColorGradingPanel.updatePlayheadTime(t) method for host-driven diamond refresh
  - ColorGradingPanel onKeyframeSelect callback contract for graph editor integration (Plan 02-04)
affects:
  - 02-keyframe-engine-compositing (plans 03, 04): adjustment layer compositing and graph editor UI depend on keyframe wiring being in place

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Keyframe fast path in render loops: spread-clone effect only when clip.keyframeTracks has tracks matching effectId prefix — avoids allocation for static effects"
    - "Diamond toggle registered in _diamonds Map keyed by property path — O(1) refresh in updatePlayheadTime without DOM query"
    - "ensureDiamondStyles() injects CSS once per document via id guard — consistent with existing panel pattern of no external CSS files"
    - "KeyframeSelectCallback fires only on second click (track exists + no kf at time) to distinguish initial-add from subsequent-view — matches plan spec for graph editor integration"

key-files:
  created: []
  modified:
    - src/editor/PlaybackEngine.ts
    - src/editor/Exporter.ts
    - src/editor/ColorGradingPanel.ts

key-decisions:
  - "fast path for static effects: spread-clone effect object only when clip.keyframeTracks.some(kt => kt.property.startsWith(e.id + '.')) — avoids structuredClone overhead on every frame for unanimated effects"
  - "LUT opacity slider retains plain makeSliderRow (Float32Array lutData field not amenable to per-field numeric keyframing; handled separately if needed)"
  - "Empty track cleanup: after removeKeyframe, if track.keyframes.length === 0 the track is spliced out of clip.keyframeTracks to keep data model clean"
  - "onKeyframeSelect fires only when track already exists but no keyframe at current time (second+ click) — initial add does not fire it, consistent with plan spec"

patterns-established:
  - "clipRelT = clipSourceTime(clip, t) - clip.sourceStart — consistent computation in both PlaybackEngine and Exporter"
  - "KeyframeSelectCallback type exported from ColorGradingPanel.ts for host wiring"

requirements-completed: [KEYF-03, KEYF-04]

# Metrics
duration: 5min
completed: 2026-03-10
---

# Phase 2 Plan 02: Keyframe Wiring + Diamond Toggle Summary

**Keyframe interpolation wired into PlaybackEngine.renderFrame() and Exporter export loop with fast path for static effects; diamond keyframe toggle buttons added to all numeric parameter sliders in ColorGradingPanel with updatePlayheadTime() refresh and onKeyframeSelect callback contract.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T22:29:32Z
- **Completed:** 2026-03-10T22:34:09Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- PlaybackEngine.renderFrame() now computes clipRelT and builds an interpolated effects array using evaluateEffectParam before passing to effectChain.process — static effects use the fast path (no clone)
- Exporter.export() applies the identical pattern so exported video is frame-accurate WYSIWYG with preview
- ColorGradingPanel has a diamond toggle on every numeric parameter slider (all colorCorrect, blur, sharpen, vignette, transform, crop params); LUT opacity intentionally excluded
- Diamond state (filled/hollow) reflects whether a keyframe exists at the current playhead time; updatePlayheadTime(t) refreshes all diamonds without re-rendering the panel
- onKeyframeSelect callback accepted for future graph editor integration (Plan 02-04)

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire keyframe evaluation into PlaybackEngine and Exporter** - `b7bf105` (feat)
2. **Task 2: Add keyframe diamond toggle to ColorGradingPanel** - `b22e994` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/editor/PlaybackEngine.ts` — Added evaluateEffectParam import; renderFrame() computes clipRelT, builds interpolatedEffects with fast path, passes to effectChain.process
- `src/editor/Exporter.ts` — Added evaluateEffectParam import; export loop computes clipRelT = srcTime - clip.sourceStart, builds interpolatedEffects same pattern as PlaybackEngine
- `src/editor/ColorGradingPanel.ts` — Added Keyframe/KeyframeTrack/addKeyframe/removeKeyframe imports; KeyframeSelectCallback type; constructor accepts onKeyframeSelect; _playheadTime + _diamonds fields; updatePlayheadTime() method; makeKeyframeSliderRow(); buildKeyframeGenericSection(); buildKeyframeColorCorrectSection(); ensureDiamondStyles() CSS injection; diamond click handlers for add/remove/cleanup

## Decisions Made

- Fast path check uses `clip.keyframeTracks.some(kt => kt.property.startsWith(e.id + '.'))` — same fast path pattern from evaluateEffectParam, applied at a higher level to skip even the function call for fully static effects
- Empty track cleanup on last keyframe remove: splice from clip.keyframeTracks to keep the data model lean (no empty arrays accumulating)
- LUT opacity excluded from keyframe toggles: the LUT section uses a plain `buildLutSection()` — Float32Array lutData is not a keyframeable numeric field and opacity-only keyframing can be added later if needed

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Keyframe interpolation is now live in both playback and export — any clips with keyframeTracks will produce animated output
- ColorGradingPanel exposes updatePlayheadTime(t) ready for editor-page.ts to call on every onTimeUpdate event (Plan 02-04 Task 2)
- onKeyframeSelect callback contract established — Plan 02-04 can wire it to open the graph editor panel
- Adjustment layer compositing (Plan 02-03) can proceed independently as it does not depend on keyframe UI

---
*Phase: 02-keyframe-engine-compositing*
*Completed: 2026-03-10*

## Self-Check: PASSED

- FOUND: `src/editor/PlaybackEngine.ts`
- FOUND: `src/editor/Exporter.ts`
- FOUND: `src/editor/ColorGradingPanel.ts`
- FOUND: `.planning/phases/02-keyframe-engine-compositing/02-02-SUMMARY.md`
- FOUND commit `b7bf105` (feat: wire keyframe evaluation into PlaybackEngine and Exporter)
- FOUND commit `b22e994` (feat: add keyframe diamond toggle to ColorGradingPanel)
- All 56 editor tests pass
