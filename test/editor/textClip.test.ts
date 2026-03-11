// Unit tests for TextClip.ts — data model, factory functions, evaluateTextProp.
// No browser APIs needed — Bun Test only.
// TDD RED phase: write all tests before implementation.

import { describe, test, expect } from 'bun:test';
import type { KeyframeTrack, Keyframe } from '../../src/editor/types.ts';
import {
  createTextClip,
  createTextTrack,
  textClipActiveAt,
  evaluateTextProp,
} from '../../src/editor/TextClip.ts';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeKeyframe(
  t: number,
  value: number,
  interpolation: Keyframe['interpolation'] = 'linear',
  handleOut: [number, number] = [0, 0],
  handleIn: [number, number] = [0, 0],
): Keyframe {
  return { t, value, interpolation, handleOut, handleIn };
}

function makeKeyframeTrack(property: string, keyframes: Keyframe[]): KeyframeTrack {
  return { property, keyframes };
}

// ── createTextClip ────────────────────────────────────────────────────────────

describe('createTextClip', () => {
  test('returns object with required fields', () => {
    const clip = createTextClip('track-1', 0, 5);
    expect(typeof clip.id).toBe('string');
    expect(clip.id.length).toBeGreaterThan(0);
    expect(clip.trackId).toBe('track-1');
    expect(clip.timelineStart).toBe(0);
    expect(clip.duration).toBe(5);
    expect(typeof clip.content).toBe('string');
    expect(Array.isArray(clip.keyframeTracks)).toBe(true);
  });

  test('defaults: position, scale, rotation', () => {
    const clip = createTextClip('track-1', 0, 5);
    expect(clip.x).toBe(960);
    expect(clip.y).toBe(540);
    expect(clip.scaleX).toBe(1);
    expect(clip.scaleY).toBe(1);
    expect(clip.rotation).toBe(0);
  });

  test('defaults: style', () => {
    const clip = createTextClip('track-1', 0, 5);
    expect(clip.style.fontFamily).toBe('Arial');
    expect(clip.style.fontWeight).toBe(400);
    expect(clip.style.fontStyle).toBe('normal');
    expect(clip.style.fontSize).toBe(48);
    expect(clip.style.color).toBe('#ffffff');
    expect(clip.style.opacity).toBe(1);
    expect(clip.style.align).toBe('center');
  });

  test('defaults: content is "Text"', () => {
    const clip = createTextClip('track-1', 0, 5);
    expect(clip.content).toBe('Text');
  });

  test('accepts custom content', () => {
    const clip = createTextClip('track-1', 0, 5, 'Hello World');
    expect(clip.content).toBe('Hello World');
  });

  test('starts with empty keyframeTracks', () => {
    const clip = createTextClip('track-1', 0, 5);
    expect(clip.keyframeTracks).toEqual([]);
  });

  test('each call produces a unique id', () => {
    const a = createTextClip('track-1', 0, 5);
    const b = createTextClip('track-1', 0, 5);
    expect(a.id).not.toBe(b.id);
  });
});

// ── structuredClone safety ────────────────────────────────────────────────────

describe('structuredClone safety', () => {
  test('round-trips through structuredClone without error', () => {
    const clip = createTextClip('track-1', 2, 10, 'Hello');
    let cloned: typeof clip;
    expect(() => {
      cloned = structuredClone(clip);
    }).not.toThrow();
    expect(cloned!.id).toBe(clip.id);
    expect(cloned!.trackId).toBe(clip.trackId);
    expect(cloned!.timelineStart).toBe(clip.timelineStart);
    expect(cloned!.duration).toBe(clip.duration);
    expect(cloned!.content).toBe(clip.content);
    expect(cloned!.x).toBe(clip.x);
    expect(cloned!.y).toBe(clip.y);
    expect(cloned!.scaleX).toBe(clip.scaleX);
    expect(cloned!.scaleY).toBe(clip.scaleY);
    expect(cloned!.rotation).toBe(clip.rotation);
    expect(cloned!.style).toEqual(clip.style);
    expect(cloned!.keyframeTracks).toEqual(clip.keyframeTracks);
  });

  test('round-trips a clip with keyframeTracks', () => {
    const clip = createTextClip('track-1', 0, 5);
    clip.keyframeTracks.push(
      makeKeyframeTrack('opacity', [
        makeKeyframe(0, 0),
        makeKeyframe(1, 1),
      ]),
    );
    let cloned: typeof clip;
    expect(() => {
      cloned = structuredClone(clip);
    }).not.toThrow();
    expect(cloned!.keyframeTracks.length).toBe(1);
    expect(cloned!.keyframeTracks[0].property).toBe('opacity');
  });
});

// ── textClipActiveAt ──────────────────────────────────────────────────────────

describe('textClipActiveAt', () => {
  test('returns true when t is within [timelineStart, timelineStart+duration)', () => {
    const clip = createTextClip('track-1', 2, 3); // active [2, 5)
    expect(textClipActiveAt(clip, 2)).toBe(true);
    expect(textClipActiveAt(clip, 3)).toBe(true);
    expect(textClipActiveAt(clip, 4.999)).toBe(true);
  });

  test('returns false before timelineStart', () => {
    const clip = createTextClip('track-1', 2, 3);
    expect(textClipActiveAt(clip, 0)).toBe(false);
    expect(textClipActiveAt(clip, 1.999)).toBe(false);
  });

  test('returns false at or after timelineStart+duration (exclusive end)', () => {
    const clip = createTextClip('track-1', 2, 3);
    expect(textClipActiveAt(clip, 5)).toBe(false);
    expect(textClipActiveAt(clip, 10)).toBe(false);
  });
});

// ── evaluateTextProp ──────────────────────────────────────────────────────────

describe('evaluateTextProp', () => {
  test('returns null when clip has no keyframe tracks at all', () => {
    const clip = createTextClip('track-1', 0, 5);
    expect(evaluateTextProp(clip, 'x', 1)).toBeNull();
  });

  test('returns null when clip has keyframe tracks but not for the queried property', () => {
    const clip = createTextClip('track-1', 0, 5);
    clip.keyframeTracks.push(
      makeKeyframeTrack('opacity', [makeKeyframe(0, 1)]),
    );
    expect(evaluateTextProp(clip, 'x', 1)).toBeNull();
  });

  test('returns interpolated value at mid-segment when keyframe track exists', () => {
    const clip = createTextClip('track-1', 0, 5);
    clip.keyframeTracks.push(
      makeKeyframeTrack('opacity', [
        makeKeyframe(0, 0, 'linear'),
        makeKeyframe(2, 1, 'linear'),
      ]),
    );
    // At t=1 (midpoint of [0,2]), linear interpolation should give 0.5
    const result = evaluateTextProp(clip, 'opacity', 1);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(0.5, 5);
  });

  test('returns value for property matched by bare name (not effectId.field format)', () => {
    const clip = createTextClip('track-1', 0, 5);
    clip.keyframeTracks.push(
      makeKeyframeTrack('x', [
        makeKeyframe(0, 100, 'linear'),
        makeKeyframe(4, 500, 'linear'),
      ]),
    );
    // At t=2 (midpoint of [0,4]), linear: 100 + 0.5*(500-100) = 300
    const result = evaluateTextProp(clip, 'x', 2);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(300, 4);
  });

  test('returns clamped value before first keyframe', () => {
    const clip = createTextClip('track-1', 0, 5);
    clip.keyframeTracks.push(
      makeKeyframeTrack('rotation', [
        makeKeyframe(1, 45, 'linear'),
        makeKeyframe(3, 90, 'linear'),
      ]),
    );
    // Before first keyframe, clamp to first value
    expect(evaluateTextProp(clip, 'rotation', 0)).toBeCloseTo(45, 5);
  });

  test('returns clamped value after last keyframe', () => {
    const clip = createTextClip('track-1', 0, 5);
    clip.keyframeTracks.push(
      makeKeyframeTrack('rotation', [
        makeKeyframe(1, 45, 'linear'),
        makeKeyframe(3, 90, 'linear'),
      ]),
    );
    // After last keyframe, clamp to last value
    expect(evaluateTextProp(clip, 'rotation', 4)).toBeCloseTo(90, 5);
  });
});

// ── evaluateTextProp charReveal ───────────────────────────────────────────────

describe('evaluateTextProp charReveal', () => {
  test('returns interpolated charReveal value from a charReveal keyframe track', () => {
    const clip = createTextClip('track-1', 0, 5, 'Hello World'); // 11 chars
    clip.keyframeTracks.push(
      makeKeyframeTrack('charReveal', [
        makeKeyframe(0, 0, 'linear'),
        makeKeyframe(2, 11, 'linear'),
      ]),
    );
    // At t=1 (midpoint), linear interpolation: 0 + 0.5*11 = 5.5
    const result = evaluateTextProp(clip, 'charReveal', 1);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(5.5, 4);
  });

  test('returns 0 at clip start when charReveal keyframe starts at 0', () => {
    const clip = createTextClip('track-1', 0, 5, 'Hello');
    clip.keyframeTracks.push(
      makeKeyframeTrack('charReveal', [
        makeKeyframe(0, 0, 'linear'),
        makeKeyframe(2, 5, 'linear'),
      ]),
    );
    const result = evaluateTextProp(clip, 'charReveal', 0);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(0, 5);
  });

  test('returns content.length at end of animation when charReveal reaches content.length', () => {
    const clip = createTextClip('track-1', 0, 5, 'Hello');
    clip.keyframeTracks.push(
      makeKeyframeTrack('charReveal', [
        makeKeyframe(0, 0, 'linear'),
        makeKeyframe(2, 5, 'linear'),
      ]),
    );
    const result = evaluateTextProp(clip, 'charReveal', 2);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(5, 5);
  });

  test('returns null when no charReveal track exists', () => {
    const clip = createTextClip('track-1', 0, 5, 'Hello');
    // no keyframe tracks at all
    expect(evaluateTextProp(clip, 'charReveal', 1)).toBeNull();
  });

  test('returns null when other tracks exist but not charReveal', () => {
    const clip = createTextClip('track-1', 0, 5, 'Hello');
    clip.keyframeTracks.push(
      makeKeyframeTrack('opacity', [makeKeyframe(0, 1)]),
    );
    expect(evaluateTextProp(clip, 'charReveal', 1)).toBeNull();
  });
});

// ── createTextTrack ───────────────────────────────────────────────────────────

describe('createTextTrack', () => {
  test('returns a Track with kind="text"', () => {
    const track = createTextTrack();
    expect(track.kind).toBe('text');
  });

  test('has default name "Text Track"', () => {
    const track = createTextTrack();
    expect(track.name).toBe('Text Track');
  });

  test('accepts custom name', () => {
    const track = createTextTrack('My Text Layer');
    expect(track.name).toBe('My Text Layer');
  });

  test('has empty clips array', () => {
    const track = createTextTrack();
    expect(Array.isArray(track.clips)).toBe(true);
    expect(track.clips.length).toBe(0);
  });

  test('has empty textClips array', () => {
    const track = createTextTrack();
    expect(Array.isArray(track.textClips)).toBe(true);
    expect(track.textClips!.length).toBe(0);
  });

  test('has a unique id', () => {
    const a = createTextTrack();
    const b = createTextTrack();
    expect(a.id).not.toBe(b.id);
  });

  test('has standard Track defaults (muted=false, solo=false, locked=false)', () => {
    const track = createTextTrack();
    expect(track.muted).toBe(false);
    expect(track.solo).toBe(false);
    expect(track.locked).toBe(false);
    expect(track.volume).toBe(1.0);
    expect(track.pan).toBe(0);
  });
});
