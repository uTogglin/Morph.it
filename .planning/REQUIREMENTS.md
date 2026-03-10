# Requirements: Morph.it Video Editor Enhancement

**Defined:** 2026-03-10
**Core Value:** Users can apply professional-quality text overlays and real-time video effects to their timeline, animate them with keyframes, and export the result — all in-browser.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Effects Foundation

- [x] **EFCT-01**: Transform shader renders position, scale, rotation, and anchor point correctly (fix identity pass-through)
- [x] **EFCT-02**: LUT shader applies 3D LUT via WebGL2 TEXTURE_3D with trilinear filtering (fix identity pass-through)
- [x] **EFCT-03**: FBO intermediate textures upgraded to RGBA16F for precision with 3+ stacked effects
- [x] **EFCT-04**: User can reorder effects in a clip's effect stack via drag-and-drop in the effects panel
- [x] **EFCT-05**: User can enable/disable individual effects with a toggle without removing them
- [ ] **EFCT-06**: User can save an effect stack as a named preset and apply it to other clips
- [ ] **EFCT-07**: User can load and manage saved effect presets (rename, delete, apply)

### Keyframe Animation

- [x] **KEYF-01**: Keyframe data model stores clip-relative timestamps with value and interpolation type per animated property
- [x] **KEYF-02**: Keyframe interpolation engine evaluates linear, bezier, and hold curves at arbitrary time points
- [x] **KEYF-03**: User can add keyframes to any effect parameter (brightness, contrast, blur radius, etc.) at the current playhead position
- [x] **KEYF-04**: Effect parameters interpolate smoothly between keyframes during playback and scrubbing
- [x] **KEYF-05**: User can view and edit keyframes in a visual graph editor with time on X-axis and value on Y-axis
- [x] **KEYF-06**: User can drag bezier curve handles in the graph editor to control easing between keyframes
- [x] **KEYF-07**: Keyframe data is included in project serialization and survives undo/redo via structuredClone

### Text Tool

- [x] **TEXT-01**: User can create a text clip on the timeline with a defined start time and duration
- [x] **TEXT-02**: Text clip appears as a distinct clip type on a text track in the timeline
- [ ] **TEXT-03**: User can edit text content in-place with a live preview over the video canvas
- [x] **TEXT-04**: User can search and select fonts from the Fontsource API with weight/style variants
- [x] **TEXT-05**: Downloaded fonts are cached locally (IndexedDB or font cache) to avoid re-downloading
- [ ] **TEXT-06**: User can adjust text size, color, opacity, and alignment
- [ ] **TEXT-07**: User can drag text position in the preview canvas
- [x] **TEXT-08**: Text clips snap to existing video and audio clip edges on the timeline
- [x] **TEXT-09**: User can animate text position, scale, rotation, and opacity via keyframes
- [x] **TEXT-10**: User can apply preset text animations (fade in/out, slide in/out, typewriter)

### Compositing

- [x] **COMP-01**: User can create adjustment layer tracks that apply their effect stack to all clips on tracks beneath
- [x] **COMP-02**: Adjustment layers appear on the timeline with definable start time and duration
- [x] **COMP-03**: Compositing order is: video clips (bottom to top) → adjustment layer effects → text overlays on top

### Audio

- [ ] **AUDI-01**: User can add fade-in and fade-out to audio clips via visual handles on clip edges
- [ ] **AUDI-02**: Fade curves apply smoothly using Web Audio GainNode ramps (linear or cubic)
- [ ] **AUDI-03**: When two audio clips overlap on the same track, an equal-power crossfade is applied automatically
- [ ] **AUDI-04**: Fade handles are visible and draggable on the timeline clip rendering

### Export

- [ ] **EXPT-01**: Exported WebM includes all applied effects rendered at full quality
- [ ] **EXPT-02**: Exported WebM includes text overlays composited at the correct times and positions
- [ ] **EXPT-03**: Exported WebM includes adjustment layer effects applied to clips beneath them
- [ ] **EXPT-04**: Export output matches the preview canvas (WYSIWYG)

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Text Styling Extended

- **TXTS-01**: User can add drop shadow, stroke/outline, and background box to text
- **TXTS-02**: User can adjust letter-spacing and line-height
- **TXTS-03**: User can save and load reusable text style presets

### Speed Control

- **SPED-01**: User can set clip playback speed via numeric input and preset buttons (0.25x, 0.5x, 1x, 2x, 4x)
- **SPED-02**: User can reverse clip playback via toggle
- **SPED-03**: User can create speed ramps via keyframes on the speed property

### Timeline Extras

- **TMLN-01**: User can add color-coded, labeled markers to the timeline ruler
- **TMLN-02**: User can create compound clips (grouped clips for easier management)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-character text animation | Enormous complexity (glyph decomposition); use clip-level typewriter preset instead |
| Text templates marketplace | Content business scope creep; ship baked-in presets + user save/load |
| Real-time collaboration | Requires CRDT/server infrastructure; incompatible with client-only constraint |
| AI auto-captions | Requires large WASM model or cloud API; breaks no-backend constraint |
| Video transitions (dissolve, wipe) | Requires two-clip compositing architecture; defer to v2+ |
| Advanced audio DSP (noise reduction, compressor) | Web Audio API has limited DSP; current mixer is sufficient |
| Mobile-specific UI | Touch-native timeline editing requires separate UX paradigm |
| Server-side rendering/export | Breaks core value proposition of no backend |
| 4K+ preview | Saturates GPU memory on most laptops; cap preview at 1080p |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EFCT-01 | Phase 1 | Complete |
| EFCT-02 | Phase 1 | Complete |
| EFCT-03 | Phase 1 | Complete |
| EFCT-04 | Phase 1 | Complete |
| EFCT-05 | Phase 1 | Complete |
| EFCT-06 | Phase 4 | Pending |
| EFCT-07 | Phase 4 | Pending |
| KEYF-01 | Phase 2 | Complete |
| KEYF-02 | Phase 2 | Complete |
| KEYF-03 | Phase 2 | Complete |
| KEYF-04 | Phase 2 | Complete |
| KEYF-05 | Phase 2 | Complete |
| KEYF-06 | Phase 2 | Complete |
| KEYF-07 | Phase 2 | Complete |
| TEXT-01 | Phase 3 | Complete |
| TEXT-02 | Phase 3 | Complete |
| TEXT-03 | Phase 3 | Pending |
| TEXT-04 | Phase 3 | Complete |
| TEXT-05 | Phase 3 | Complete |
| TEXT-06 | Phase 3 | Pending |
| TEXT-07 | Phase 3 | Pending |
| TEXT-08 | Phase 3 | Complete |
| TEXT-09 | Phase 3 | Complete |
| TEXT-10 | Phase 3 | Complete |
| COMP-01 | Phase 2 | Complete |
| COMP-02 | Phase 2 | Complete |
| COMP-03 | Phase 2 | Complete |
| AUDI-01 | Phase 4 | Pending |
| AUDI-02 | Phase 4 | Pending |
| AUDI-03 | Phase 4 | Pending |
| AUDI-04 | Phase 4 | Pending |
| EXPT-01 | Phase 4 | Pending |
| EXPT-02 | Phase 4 | Pending |
| EXPT-03 | Phase 4 | Pending |
| EXPT-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0

---
*Requirements defined: 2026-03-10*
*Last updated: 2026-03-10 — traceability mapped after roadmap creation*
