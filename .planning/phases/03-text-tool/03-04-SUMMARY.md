---
phase: 03-text-tool
plan: "04"
subsystem: ui
tags: [fabric.js, text, inspector, overlay, in-place-editing, canvas-drag, font-picker]

requires:
  - phase: 03-01
    provides: TextClip data model, createTextTrack, createTextClip
  - phase: 03-02
    provides: FontPicker (fetchFontsourceList, loadFontsourceFont), TextPresets, TextPresets.applyTextPreset
  - phase: 03-03
    provides: TextRenderer (canvas compositing), PlaybackEngine text rendering integration

provides:
  - TextInspectorPanel class: font family datalist, weight, style, size, color, opacity, alignment, position (x/y), animation preset controls
  - TextEditOverlay class: Fabric.js IText overlay for in-place text editing with pointer-events toggling
  - editor-page.ts: Add Text button creates text track+clip at playhead; inspector, overlay, drag, and delete all wired
  - index.ts: exports TextInspectorPanel and TextEditOverlay

affects: [export, preview-rendering, undo-history]

tech-stack:
  added: [fabric ^6.6.1 (already bundled, dynamically imported in TextEditOverlay)]
  patterns:
    - Dynamic import of fabric.js in TextEditOverlay.startEdit() keeps it code-split friendly
    - pointer-events toggled on overlay canvas (none by default, all during edit)
    - Capture-phase keydown listener for text clip deletion to preempt the existing Delete handler

key-files:
  created:
    - src/editor/TextInspectorPanel.ts
    - src/editor/TextEditOverlay.ts
  modified:
    - src/editor/index.ts
    - src/editor-page.ts
    - index.html

key-decisions:
  - "Fabric.js dynamically imported inside startEdit() — avoids top-level import overhead and keeps bundle split-friendly"
  - "Capture-phase keydown listener for text clip delete — stopImmediatePropagation() prevents the existing deleteSelectedClips() from also firing"
  - "Font datalist capped to 500 entries on render — full Fontsource list (thousands of fonts) would bloat DOM; search UX still works via typed input"
  - "hitTestTextClip uses approximate bounding box (fontSize * content.length * 0.5) — sufficient for click/drag hit detection without measuring actual text"
  - "textInspectorPanel.update() called during pointermove drag — keeps x/y inputs live without rebuilding the full panel"

requirements-completed: [TEXT-03, TEXT-06, TEXT-07]

duration: 7min
completed: 2026-03-11
---

# Phase 3 Plan 04: Text Inspector, Edit Overlay, and editor-page Wiring Summary

**Fabric.js IText in-place editing overlay + TextInspectorPanel with font/size/color/opacity/alignment/position/preset controls, all wired into editor-page.ts with canvas drag, undo history, and Add Text toolbar button**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-03-11T00:00:00Z
- **Completed:** 2026-03-11T00:02:03Z
- **Tasks:** 2 of 3 (Task 3 is human-verify checkpoint)
- **Files modified:** 5

## Accomplishments

- TextInspectorPanel renders full style controls for selected TextClip with live onChange wiring to pushHistory + engine.seekTo re-render
- TextEditOverlay wraps Fabric.js IText as an absolutely-positioned canvas overlay; pointer-events toggled between none/all; dynamically imports fabric to keep bundle clean
- editor-page.ts wired: "Add Text" toolbar button creates a text track+3-second clip at playhead; preview canvas pointerdown/move/up drags text position with rAF throttle and undo on release; dblclick activates edit overlay; capture-phase Delete handler removes selected text clip

## Task Commits

1. **Task 1: TextInspectorPanel and TextEditOverlay** - `52aa6f6` (feat)
2. **Task 2: Wire text creation, inspector, edit overlay, canvas drag into editor-page.ts** - `347429b` (feat)

**Plan metadata:** (committed after checkpoint)

## Files Created/Modified

- `src/editor/TextInspectorPanel.ts` - Full inspector UI: font datalist, weight/style selects, size input, color picker, opacity range, align buttons, x/y position inputs, animation preset dropdown
- `src/editor/TextEditOverlay.ts` - Fabric.js IText overlay for in-place editing; startEdit/stopEdit/isEditing/dispose API
- `src/editor/index.ts` - Added exports for TextInspectorPanel and TextEditOverlay
- `src/editor-page.ts` - Add Text button, TextInspectorPanel init, TextEditOverlay init, canvas pointer events for drag+dblclick, capture Delete handler
- `index.html` - Added "Add Text" button with text icon to editor toolbar

## Decisions Made

- Fabric.js dynamically imported inside startEdit() — avoids top-level import overhead and keeps bundle code-split friendly
- Capture-phase keydown listener for text clip deletion — stopImmediatePropagation() prevents the existing deleteSelectedClips() from firing when a text clip is selected
- Font datalist capped to 500 entries — full Fontsource list would bloat DOM; typed input search still works correctly
- hitTestTextClip uses approximate bounding box (fontSize * content.length * 0.5) — sufficient for drag/click detection without layout measurement
- textInspectorPanel.update() called during drag pointermove — keeps x/y fields in sync without rebuilding the full panel DOM

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `bun` not in PATH in this shell session; used `npx bun` as workaround — 110 tests passed without issue.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Text tool feature set is functionally complete pending human verification (Task 3 checkpoint)
- Checkpoint requires: browser open, "Add Text" button click, inspector verify, double-click edit, font picker, canvas drag, preset playback, undo test, export test
- Phase 4 (if any) can proceed once human verification passes

## Self-Check: PASSED

- `src/editor/TextInspectorPanel.ts` — FOUND
- `src/editor/TextEditOverlay.ts` — FOUND
- `.planning/phases/03-text-tool/03-04-SUMMARY.md` — FOUND
- Commit `52aa6f6` — FOUND
- Commit `347429b` — FOUND

---
*Phase: 03-text-tool*
*Completed: 2026-03-11*
