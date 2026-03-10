// ── TextClip ────────────────────────────────────────────────────────────────────
// Data model and factory functions for text overlay clips.
// All types are structuredClone-safe (no class instances, no File objects).

import type { Track, KeyframeTrack } from './types.ts';
import { evaluateTrack } from './KeyframeEngine.ts';

// ── Style ─────────────────────────────────────────────────────────────────────

export interface TextClipStyle {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSize: number;      // px
  color: string;         // CSS color string e.g. "#ffffff"
  opacity: number;       // 0.0–1.0
  align: 'left' | 'center' | 'right';
}

// ── TextClip ──────────────────────────────────────────────────────────────────

export interface TextClip {
  id: string;
  trackId: string;
  timelineStart: number;   // seconds
  duration: number;        // seconds
  content: string;
  x: number;               // canvas px (default: center of 1920x1080 = 960)
  y: number;               // canvas px (default: center of 1920x1080 = 540)
  scaleX: number;          // 1.0 = no scale
  scaleY: number;
  rotation: number;        // degrees
  style: TextClipStyle;
  keyframeTracks: KeyframeTrack[];
}

// ── Factory functions ─────────────────────────────────────────────────────────

export function createTextClip(
  trackId: string,
  timelineStart: number,
  duration: number,
  content = 'Text',
): TextClip {
  return {
    id: crypto.randomUUID(),
    trackId,
    timelineStart,
    duration,
    content,
    x: 960,
    y: 540,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    style: {
      fontFamily: 'Arial',
      fontWeight: 400,
      fontStyle: 'normal',
      fontSize: 48,
      color: '#ffffff',
      opacity: 1,
      align: 'center',
    },
    keyframeTracks: [],
  };
}

export function createTextTrack(name = 'Text Track'): Track & { textClips: TextClip[] } {
  return {
    id: crypto.randomUUID(),
    kind: 'text',
    name,
    muted: false,
    solo: false,
    locked: false,
    volume: 1.0,
    pan: 0,
    clips: [],
    textClips: [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Whether the text clip is active at a given timeline position (seconds). */
export function textClipActiveAt(clip: TextClip, t: number): boolean {
  return t >= clip.timelineStart && t < clip.timelineStart + clip.duration;
}

/**
 * Evaluate a text clip property at a clip-relative time.
 *
 * Finds a KeyframeTrack by bare property name (e.g. 'x', 'opacity') —
 * NOT the "effectId.field" format used by evaluateEffectParam.
 *
 * Returns null if no matching track exists for the property.
 * Otherwise calls evaluateTrack() from KeyframeEngine.ts.
 */
export function evaluateTextProp(
  clip: TextClip,
  property: string,
  clipRelativeT: number,
): number | null {
  const track = clip.keyframeTracks.find(t => t.property === property);
  if (!track) return null;
  return evaluateTrack(track, clipRelativeT);
}
