// ── TextPresets.ts ────────────────────────────────────────────────────────────
// Preset text animation generators.
// Pure functions that write pre-baked KeyframeTrack arrays onto a TextClip.
// No DOM, canvas, or browser APIs — fully testable in Bun headless environment.

import type { KeyframeTrack, Keyframe, InterpolationType } from './types.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TextPreset =
  | 'fadeIn'
  | 'fadeOut'
  | 'slideInLeft'
  | 'slideInRight'
  | 'slideOutLeft'
  | 'slideOutRight'
  | 'typewriter';

/** All preset names — for UI enumeration (e.g. a preset picker dropdown). */
export const TEXT_PRESETS: TextPreset[] = [
  'fadeIn',
  'fadeOut',
  'slideInLeft',
  'slideInRight',
  'slideOutLeft',
  'slideOutRight',
  'typewriter',
];

/**
 * Minimal clip shape required by applyTextPreset.
 * Compatible with TextClip (Phase 3 Plan 01) once it exists.
 */
interface PresetClip {
  x: number;
  y: number;
  content: string;
  duration: number;
  keyframeTracks: KeyframeTrack[];
}

// ── Properties managed by presets ─────────────────────────────────────────────

/**
 * Properties that applyTextPreset owns.
 * These tracks are removed before the new preset tracks are written,
 * preventing stacking when the user switches presets.
 */
const PRESET_PROPERTIES = new Set(['opacity', 'x', 'charReveal']);

// ── Keyframe helper ───────────────────────────────────────────────────────────

function makeKf(
  t: number,
  value: number,
  interpolation: InterpolationType = 'linear',
): Keyframe {
  return { t, value, interpolation, handleOut: [0, 0], handleIn: [0, 0] };
}

// ── applyTextPreset ───────────────────────────────────────────────────────────

/**
 * Apply a named animation preset to a text clip.
 *
 * 1. Removes existing keyframe tracks managed by presets (opacity, x, charReveal).
 * 2. Pushes the new track(s) for the requested preset.
 *
 * @param clip          Text clip to modify (mutated in place)
 * @param preset        Preset name
 * @param projectWidth  Canvas width in pixels (used for slide presets)
 */
export function applyTextPreset(
  clip: PresetClip,
  preset: TextPreset,
  projectWidth = 1920,
): void {
  // Remove tracks owned by presets to avoid duplication.
  clip.keyframeTracks = clip.keyframeTracks.filter(
    t => !PRESET_PROPERTIES.has(t.property),
  );

  const { x, duration, content } = clip;
  const easeIn: InterpolationType = 'bezier';
  const inEnd = Math.min(0.5, duration * 0.3);
  const outStart = Math.max(duration - 0.5, duration * 0.7);

  switch (preset) {
    case 'fadeIn':
      clip.keyframeTracks.push({
        property: 'opacity',
        keyframes: [
          makeKf(0, 0),
          makeKf(inEnd, 1),
        ],
      });
      break;

    case 'fadeOut':
      clip.keyframeTracks.push({
        property: 'opacity',
        keyframes: [
          makeKf(outStart, 1),
          makeKf(duration, 0),
        ],
      });
      break;

    case 'slideInLeft':
      clip.keyframeTracks.push({
        property: 'x',
        keyframes: [
          { t: 0,     value: x - projectWidth, interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
          { t: inEnd, value: x,                interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
        ],
      });
      break;

    case 'slideInRight':
      clip.keyframeTracks.push({
        property: 'x',
        keyframes: [
          { t: 0,     value: x + projectWidth, interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
          { t: inEnd, value: x,                interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
        ],
      });
      break;

    case 'slideOutLeft':
      clip.keyframeTracks.push({
        property: 'x',
        keyframes: [
          { t: outStart, value: x,                interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
          { t: duration, value: x - projectWidth, interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
        ],
      });
      break;

    case 'slideOutRight':
      clip.keyframeTracks.push({
        property: 'x',
        keyframes: [
          { t: outStart, value: x,                interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
          { t: duration, value: x + projectWidth, interpolation: easeIn, handleOut: [0, 0], handleIn: [0, 0] },
        ],
      });
      break;

    case 'typewriter':
      clip.keyframeTracks.push({
        property: 'charReveal',
        keyframes: [
          makeKf(0, 0),
          makeKf(Math.min(2, duration * 0.6), content.length),
        ],
      });
      break;
  }
}
