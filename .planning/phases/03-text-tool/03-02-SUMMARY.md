---
phase: 03-text-tool
plan: "02"
subsystem: editor
tags: [fontsource, fonts, text, presets, animation, keyframes, tdd]

requires:
  - phase: 03-text-tool plan 01
    provides: TextClip type and KeyframeTrack used by TextPresets

provides:
  - FontPicker.ts with Fontsource API integration (fetchFontsourceList, loadFontsourceFont, module-level loadedFonts cache)
  - TextPresets.ts with 7 preset animation generators (fadeIn/fadeOut/slideIn/Out/typewriter)
  - Full unit test coverage for both modules (29 tests across 2 files)
  - Re-exports from src/editor/index.ts

affects:
  - 03-text-tool plan 03 (TextInspectorPanel will call loadFontsourceFont)
  - 03-text-tool plan 04 (editor-page.ts wiring will call applyTextPreset)

tech-stack:
  added: []
  patterns:
    - "Module-level loadedFonts Set with family:weight:style key prevents redundant FontFace.load() calls"
    - "Module-level _fontListCache avoids re-fetching the full Fontsource API list on every call"
    - "applyTextPreset removes preset-owned tracks (opacity, x, charReveal) before writing new ones — prevents stacking"
    - "Bun test FontFace mock: assign class to global.FontFace before calling loadFontsourceFont"

key-files:
  created:
    - src/editor/FontPicker.ts
    - src/editor/TextPresets.ts
    - test/editor/fontPicker.test.ts
    - test/editor/textPresets.test.ts
  modified:
    - src/editor/index.ts

key-decisions:
  - "loadedFonts cache key format is 'family:weight:style' (not 'fontId:weight:style') because the CSS font-family name is what FontFace deduplication needs to match"
  - "fetchFontsourceList() caches the full API response in a module-level variable — avoids repeated network I/O and keeps function idempotent"
  - "applyTextPreset removes all preset-managed properties before writing — cleaner than checking for duplicates; PRESET_PROPERTIES Set makes the owned set explicit"
  - "Bun has no FontFace or document globals — tests mock these via global assignment before each call and restore after"

patterns-established:
  - "Global mock injection for browser APIs in Bun: assign to global.FontFace / global.document before test, restore in finally block"

requirements-completed: [TEXT-04, TEXT-05, TEXT-10]

duration: 3min
completed: 2026-03-10
---

# Phase 03 Plan 02: FontPicker and TextPresets Summary

**Fontsource font discovery + caching utility and 7-preset text animation generator with full TDD test coverage (29 tests)**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-10T23:45:10Z
- **Completed:** 2026-03-10T23:48:31Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- `FontPicker.ts` extracts the Fontsource pattern from `pdf-editor-tool.ts` into a reusable module: `fetchFontsourceList()` with in-memory result cache, `loadFontsourceFont()` with `loadedFonts` Set guard preventing duplicate `FontFace.load()` calls
- `TextPresets.ts` implements 7 preset animation generators as pure functions: `applyTextPreset()` strips existing preset-owned tracks before writing new `KeyframeTrack[]` entries, ensuring clean preset switching
- 29 tests across `fontPicker.test.ts` and `textPresets.test.ts` covering all behaviors; full editor suite (110 tests, 5 files) green with no regressions

## Task Commits

1. **Task 1: RED — Write failing tests** - `497deae` (test)
2. **Task 2: GREEN — Implement FontPicker.ts and TextPresets.ts** - `d34ce44` (feat)

_TDD plan: test commit then implementation commit_

## Files Created/Modified

- `src/editor/FontPicker.ts` — `FontEntry` type, `FONTSOURCE_API` + `FONTSOURCE_CDN` constants, `loadedFonts` cache Set, `fetchFontsourceList()`, `loadFontsourceFont()`
- `src/editor/TextPresets.ts` — `TextPreset` union type, `TEXT_PRESETS` array, `applyTextPreset()` with all 7 generators
- `src/editor/index.ts` — Added re-exports for FontPicker and TextPresets public API
- `test/editor/fontPicker.test.ts` — 12 tests: function existence, mocked fetch mapping, CDN URL construction (weight 700/italic and default), caching (single FontFace per key, distinct keys each get one FontFace)
- `test/editor/textPresets.test.ts` — 17 tests: TEXT_PRESETS enumeration, each of the 7 presets, idempotency (replacing existing tracks on re-apply)

## Decisions Made

- `loadedFonts` cache key uses `family:weight:style` (CSS family string) rather than `fontId:weight:style` because `FontFace` deduplication works on the family name that appears in CSS.
- `fetchFontsourceList()` caches its result in a module-level variable so repeated calls (e.g. search filtering) don't hit the network again.
- `applyTextPreset()` owns the `PRESET_PROPERTIES` set `{opacity, x, charReveal}` and unconditionally removes all matching tracks before writing the new ones — simpler and more correct than checking for duplicates.
- Bun has no `FontFace` or `document` globals; tests inject class mocks via `global.FontFace = ...` and restore in `finally` blocks.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `fetchFontsourceList()` and `loadFontsourceFont()` are ready for the `TextInspectorPanel` font picker (Plan 03)
- `applyTextPreset()` and `TEXT_PRESETS` are ready for the editor-page.ts preset picker wiring (Plan 04)
- All 110 editor tests pass — no regressions introduced

---
*Phase: 03-text-tool*
*Completed: 2026-03-10*
