# Morph.it Video Editor Enhancement

## What This Is

A major feature expansion of the Morph.it in-browser video timeline editor, adding a full text tool with Fontsource font selection, a polished GPU-accelerated video effects system with keyframe animation, and additional DaVinci Resolve-inspired timeline features. Everything runs client-side with no backend dependencies (except font API calls).

## Core Value

Users can apply professional-quality text overlays and real-time video effects to their timeline, animate them with keyframes, and export the result — all without leaving the browser.

## Requirements

### Validated

- ✓ Multi-track timeline with video and audio tracks — existing
- ✓ Clip import, move, trim, split, delete with linked audio/video — existing
- ✓ WebGL2 effect chain (color correct, blur, sharpen, vignette, crop) — existing
- ✓ Audio mixer with per-track volume, pan, mute, solo — existing
- ✓ WebM export with VP9/VP8 video and Opus audio — existing
- ✓ Undo/redo via project snapshot cloning (50 levels) — existing
- ✓ Timeline zoom, scroll, snap-to-edges, playhead seeking — existing
- ✓ Thumbnail and waveform preview caching — existing
- ✓ Color grading panel UI — existing
- ✓ LUT file parser (.cube format) — existing

### Active

- [ ] Complete existing effect shaders (transform, LUT — currently fall through to identity)
- [ ] Full keyframe system with visual graph editor and custom easing curves
- [ ] Text clips on timeline with Fontsource font selection, styling, and live preview
- [ ] Text animation via keyframes (position, scale, rotation, opacity + presets)
- [ ] Stackable, reorderable effect system with enable/disable per effect
- [ ] Adjustment layers that apply effects to all clips beneath
- [ ] Audio fade in/out curves with visual handles
- [ ] Audio crossfades when clips overlap
- [ ] Clip speed control UI (including reverse playback)
- [ ] Full export pipeline rendering text overlays and all effects into WebM
- [ ] Preset system for effect stacks and text styles

### Out of Scope

- Server-side or cloud processing — must remain fully in-browser
- Real-time collaboration or multi-user editing — single-user tool
- Per-character text animation — extensibility hook only, not v1
- Text templates marketplace — defer to future
- Advanced audio (noise reduction, compressor, limiter) — current mixer is sufficient
- Mobile-specific UI — desktop/laptop browser target

## Context

- **Brownfield project**: existing editor subsystem in `src/editor/` with ~12 modules
- **PDF editor precedent**: `src/pdf-editor-tool.ts` already integrates Fontsource API, Fabric.js text editing, and font caching — patterns to reuse
- **WebGL2 pipeline**: `EffectChain.ts` already implements FBO ping-pong compositing with fragment shaders — extend, don't replace
- **Vanilla TypeScript**: no UI framework, direct DOM manipulation, module-level state in `editor-page.ts`
- **Known gaps**: `transform` and `lut` effect kinds exist in data model but their shaders fall through to identity pass
- **Export architecture**: `Exporter.ts` already creates independent EffectChain + ClipDecoderPool for frame-by-frame rendering — text compositing needs to plug in here
- **Undo system**: deep-clone snapshots of `Project` object — new data models must be cloneable via `structuredClone` (File objects shared by reference)

## Constraints

- **Runtime**: All processing client-side in browser (Web APIs, WebGL2, WebCodecs, Web Audio)
- **Network**: Only external calls allowed are font API (Fontsource/jsDelivr CDN)
- **Performance**: Real-time preview at interactive frame rates for 1080p on modern laptop
- **Compatibility**: Must work with existing project serialization and undo/redo system
- **Non-destructive**: All effects and text editable/removable at any time
- **Dependencies**: Fabric.js already bundled — reuse for text editing UX. Minimize new dependencies.
- **GPU degradation**: WebGL2 effects must degrade gracefully on lower-end devices

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fabric.js for text editing | Reuse PDF editor patterns, proven in-place text editing UX | — Pending |
| Pure Canvas2D/WebGL for text rendering in preview | Text rendered to OffscreenCanvas then composited through existing pipeline | — Pending |
| Full keyframe editor with graph UI | User wants DaVinci-level control, not just presets | — Pending |
| Effects polish as top priority | Existing effect system has gaps (transform/LUT shaders) — fix foundation first | — Pending |
| Adjustment layers in v1 | High-impact compositing feature, natural extension of existing track model | — Pending |
| Full export including text + effects | Users expect what they see in preview to appear in export | — Pending |
| Speed control UI | Data model supports speed/reverse already, just needs UX surface | — Pending |

---
*Last updated: 2026-03-10 after initialization*
