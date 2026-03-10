# Roadmap: Morph.it Video Editor Enhancement

## Overview

This milestone transforms Morph.it from a functional prototype into a professional in-browser NLE. Four phases follow a strict dependency order: fix the broken GPU shader foundation first, then wire in the keyframe engine and compositing pipeline, then build the full text tool on top of that verified foundation, and finally add audio polish and close the export loop. Every phase delivers a coherent, independently verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Effects Foundation** - Working transform + LUT shaders, RGBA16F FBOs, effect reorder/toggle (completed 2026-03-10)
- [x] **Phase 2: Keyframe Engine + Compositing** - Keyframe data model, interpolation engine, graph editor, adjustment layers (completed 2026-03-10)
- [ ] **Phase 3: Text Tool** - Text clips on timeline with Fontsource fonts, live editing, animation via keyframes
- [ ] **Phase 4: Audio, Export, and Polish** - Audio fades/crossfades, WYSIWYG export, effect/text presets

## Phase Details

### Phase 1: Effects Foundation
**Goal**: The existing GPU effect pipeline works correctly — transform, LUT, and multi-pass precision are no longer identity stubs
**Depends on**: Nothing (first phase)
**Requirements**: EFCT-01, EFCT-02, EFCT-03, EFCT-04, EFCT-05
**Success Criteria** (what must be TRUE):
  1. User can apply transform effect to a clip and see position, scale, and rotation rendered correctly in the preview canvas (not an identity pass-through)
  2. User can load a .cube LUT file and see the color grade applied in the preview canvas with smooth trilinear interpolation
  3. User can enable or disable an individual effect in a clip's effect stack and see the change reflected immediately in the preview
  4. User can drag effects in the effects panel to reorder them and the composited result reflects the new order
**Plans:** 4/4 plans complete
Plans:
- [ ] 01-01-PLAN.md — RGBA16F FBO upgrade + transform shader + LUT shader (EffectChain.ts)
- [ ] 01-02-PLAN.md — Effect panel UX: drag reorder, eye toggle, categorized add menu, context menu, toast
- [ ] 01-03-PLAN.md — End-to-end verification (tests + human browser check)

### Phase 2: Keyframe Engine + Compositing
**Goal**: Any property on any clip can be animated over time, and adjustment layers apply grading to all clips beneath them
**Depends on**: Phase 1
**Requirements**: KEYF-01, KEYF-02, KEYF-03, KEYF-04, KEYF-05, KEYF-06, KEYF-07, COMP-01, COMP-02, COMP-03
**Success Criteria** (what must be TRUE):
  1. User can add a keyframe to an effect parameter at the current playhead position, and the parameter interpolates smoothly between keyframes during playback and scrubbing
  2. User can view all keyframes for a property in a visual graph editor and drag bezier handles to change the easing curve
  3. User can create an adjustment layer track with a defined time range, apply effects to it, and those effects are applied to all video clips on tracks beneath it in the preview
  4. Project with keyframes survives save/load and undo/redo without data loss or type errors
  5. Compositing order in preview is: video tracks (bottom to top) → adjustment layer pass → text overlays (even before text clips exist)
**Plans:** 4/4 plans complete
Plans:
- [ ] 02-01-PLAN.md — Keyframe data model + interpolation engine (TDD)
- [ ] 02-02-PLAN.md — Wire keyframe evaluation into PlaybackEngine/Exporter + inspector toggle
- [ ] 02-03-PLAN.md — Adjustment layer compositing (data model + two-phase render + timeline)
- [ ] 02-04-PLAN.md — Graph editor panel with SVG curves and bezier handle drag

### Phase 3: Text Tool
**Goal**: Users can create, style, animate, and position text overlays on the timeline with professional font selection
**Depends on**: Phase 2
**Requirements**: TEXT-01, TEXT-02, TEXT-03, TEXT-04, TEXT-05, TEXT-06, TEXT-07, TEXT-08, TEXT-09, TEXT-10
**Success Criteria** (what must be TRUE):
  1. User can create a text clip on the timeline, double-click to edit its content in-place over the preview canvas, and see the result live
  2. User can search for a font by name in the font picker, select a weight/style variant, and the text clip renders using that font (with the font cached after first download)
  3. User can drag the text position in the preview canvas, and change font size, color, opacity, and alignment via the inspector panel
  4. User can add keyframes to text position, scale, rotation, and opacity, and the text animates correctly between them during playback
  5. User can apply a preset animation (fade in/out, slide in/out, typewriter) to a text clip and see it play back correctly
**Plans:** 4 plans
Plans:
- [ ] 03-01-PLAN.md — TextClip data model + evaluateTextProp + TextRenderer (TDD)
- [ ] 03-02-PLAN.md — Fontsource font picker + caching + preset text animations (TDD)
- [ ] 03-03-PLAN.md — PlaybackEngine/Exporter text compositing + timeline rendering + snapping
- [ ] 03-04-PLAN.md — Text inspector panel + edit overlay + canvas drag + full editor-page.ts wiring

### Phase 4: Audio, Export, and Polish
**Goal**: Audio clips have visual fade controls, the export produces WYSIWYG output matching the preview, and effect/text presets are saveable
**Depends on**: Phase 3
**Requirements**: AUDI-01, AUDI-02, AUDI-03, AUDI-04, EXPT-01, EXPT-02, EXPT-03, EXPT-04, EFCT-06, EFCT-07
**Success Criteria** (what must be TRUE):
  1. User can drag fade handles on audio clip edges in the timeline to create fade-in and fade-out curves, and the audio ramps smoothly during playback
  2. When two audio clips overlap on the same track, an audible equal-power crossfade is applied automatically without any user action
  3. Exported WebM file matches the preview canvas: all effects, adjustment layer grades, and text overlays appear at the correct times and positions
  4. User can save an effect stack as a named preset and apply it to another clip in a single click
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Effects Foundation | 4/4 | Complete   | 2026-03-10 |
| 2. Keyframe Engine + Compositing | 4/4 | Complete   | 2026-03-10 |
| 3. Text Tool | 0/4 | Planning complete | - |
| 4. Audio, Export, and Polish | 0/TBD | Not started | - |
