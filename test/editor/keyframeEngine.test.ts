// Unit tests for KeyframeEngine.ts — pure interpolation functions.
// All tests run without browser APIs — Bun Test only.
// TDD RED phase: write all tests before implementation.

import { describe, test, expect } from 'bun:test';
import type { Keyframe, KeyframeTrack } from '../../src/editor/types.ts';
import {
  evaluateTrack,
  evaluateEffectParam,
  addKeyframe,
  removeKeyframe,
} from '../../src/editor/KeyframeEngine.ts';

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

// ── evaluateTrack: edge cases ─────────────────────────────────────────────────

describe('evaluateTrack — empty and single keyframe', () => {
  test('empty track returns 0', () => {
    const track = makeKeyframeTrack('brightness', []);
    expect(evaluateTrack(track, 0)).toBe(0);
    expect(evaluateTrack(track, 5)).toBe(0);
    expect(evaluateTrack(track, -1)).toBe(0);
  });

  test('single keyframe returns that value at t = keyframe.t', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(1.0, 0.5)]);
    expect(evaluateTrack(track, 1.0)).toBe(0.5);
  });

  test('single keyframe returns that value for all t', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(1.0, 0.5)]);
    expect(evaluateTrack(track, 0)).toBe(0.5);
    expect(evaluateTrack(track, 2)).toBe(0.5);
    expect(evaluateTrack(track, 1000)).toBe(0.5);
    expect(evaluateTrack(track, -1)).toBe(0.5);
  });
});

// ── evaluateTrack: clamping ───────────────────────────────────────────────────

describe('evaluateTrack — out-of-range clamping', () => {
  const kf = [makeKeyframe(1.0, 10), makeKeyframe(3.0, 20)];
  const track = makeKeyframeTrack('brightness', kf);

  test('t before first keyframe returns first keyframe value', () => {
    expect(evaluateTrack(track, 0)).toBe(10);
    expect(evaluateTrack(track, -10)).toBe(10);
  });

  test('t exactly at first keyframe returns first keyframe value', () => {
    expect(evaluateTrack(track, 1.0)).toBe(10);
  });

  test('t after last keyframe returns last keyframe value', () => {
    expect(evaluateTrack(track, 10)).toBe(20);
    expect(evaluateTrack(track, 999)).toBe(20);
  });

  test('t exactly at last keyframe returns last keyframe value', () => {
    expect(evaluateTrack(track, 3.0)).toBe(20);
  });
});

// ── evaluateTrack: linear interpolation ──────────────────────────────────────

describe('evaluateTrack — linear interpolation', () => {
  test('midpoint between two linear keyframes is exact midpoint value', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0, 'linear'),
      makeKeyframe(1, 1, 'linear'),
    ]);
    expect(evaluateTrack(track, 0.5)).toBeCloseTo(0.5, 10);
  });

  test('quarter-point returns proportional value', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0, 'linear'),
      makeKeyframe(4, 8, 'linear'),
    ]);
    // at t=1, u=0.25, value = 0 + 0.25 * 8 = 2
    expect(evaluateTrack(track, 1)).toBeCloseTo(2, 10);
  });

  test('linear interpolation with negative values', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, -1, 'linear'),
      makeKeyframe(1, 1, 'linear'),
    ]);
    expect(evaluateTrack(track, 0.5)).toBeCloseTo(0, 10);
  });

  test('three keyframes: selects the correct segment', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0, 'linear'),
      makeKeyframe(1, 10, 'linear'),
      makeKeyframe(2, 20, 'linear'),
    ]);
    // First segment [0,1]: at t=0.5, value=5
    expect(evaluateTrack(track, 0.5)).toBeCloseTo(5, 10);
    // Second segment [1,2]: at t=1.5, value=15
    expect(evaluateTrack(track, 1.5)).toBeCloseTo(15, 10);
  });
});

// ── evaluateTrack: hold interpolation ────────────────────────────────────────

describe('evaluateTrack — hold interpolation', () => {
  test('hold: returns left keyframe value throughout segment', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 5, 'hold'),
      makeKeyframe(1, 10, 'hold'),
    ]);
    // Any t in [0, 1) returns left keyframe value 5
    expect(evaluateTrack(track, 0.0)).toBe(5);
    expect(evaluateTrack(track, 0.5)).toBe(5);
    expect(evaluateTrack(track, 0.999)).toBe(5);
  });

  test('hold: at the second keyframe, returns the second keyframe value (clamped)', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 5, 'hold'),
      makeKeyframe(1, 10, 'hold'),
    ]);
    // t exactly at last keyframe = last value
    expect(evaluateTrack(track, 1.0)).toBe(10);
  });

  test('hold: three keyframes jump between steps', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 1, 'hold'),
      makeKeyframe(1, 2, 'hold'),
      makeKeyframe(2, 3, 'hold'),
    ]);
    expect(evaluateTrack(track, 0.5)).toBe(1);
    expect(evaluateTrack(track, 1.5)).toBe(2);
    expect(evaluateTrack(track, 2.0)).toBe(3); // clamped at last
  });
});

// ── evaluateTrack: bezier interpolation ──────────────────────────────────────

describe('evaluateTrack — bezier interpolation', () => {
  test('bezier with zero handles is equivalent to linear at midpoint', () => {
    // With handles [0,0], the bezier degenerates to linear
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0, 'bezier', [0, 0], [0, 0]),
      makeKeyframe(1, 1, 'bezier', [0, 0], [0, 0]),
    ]);
    expect(evaluateTrack(track, 0.5)).toBeCloseTo(0.5, 3);
  });

  test('bezier returns value within [a.value, b.value] for handles within bounds', () => {
    // Standard easing (ease-in): the value stays closer to a.value longer
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0, 'bezier', [0.2, 0], [0, 0]),
      makeKeyframe(1, 1, 'bezier', [0, 0], [-0.2, 0]),
    ]);
    const mid = evaluateTrack(track, 0.5);
    // Should be within [0, 1] range
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(1);
  });

  test('bezier at t=0 returns first keyframe value', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 3, 'bezier', [0.3, 0.5], [0, 0]),
      makeKeyframe(1, 7, 'bezier', [0, 0], [-0.3, -0.5]),
    ]);
    expect(evaluateTrack(track, 0)).toBe(3); // clamped
  });

  test('bezier at t=last returns last keyframe value', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 3, 'bezier', [0.3, 0.5], [0, 0]),
      makeKeyframe(1, 7, 'bezier', [0, 0], [-0.3, -0.5]),
    ]);
    expect(evaluateTrack(track, 1)).toBe(7); // clamped
  });

  test('bezier is continuous: small dt gives small dv', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0, 'bezier', [0.25, 0], [0, 0]),
      makeKeyframe(1, 10, 'bezier', [0, 0], [-0.25, 0]),
    ]);
    const v1 = evaluateTrack(track, 0.5);
    const v2 = evaluateTrack(track, 0.501);
    // Should differ by less than 0.1 (continuous)
    expect(Math.abs(v2 - v1)).toBeLessThan(0.1);
  });
});

// ── evaluateEffectParam ───────────────────────────────────────────────────────

describe('evaluateEffectParam — fast path', () => {
  test('returns structuredClone of effect.params when no tracks match', () => {
    const effect = {
      id: 'fx-001',
      kind: 'colorCorrect' as const,
      enabled: true,
      params: { brightness: 0.5, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0,
                liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1,
                gainR: 1, gainG: 1, gainB: 1 },
    };
    const clip = {
      id: 'clip-001',
      trackId: 'track-001',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [effect],
      keyframeTracks: [],
    };
    const result = evaluateEffectParam(effect, clip, 1.0);
    expect((result as any).brightness).toBe(0.5);
  });

  test('does not mutate original effect.params on fast path', () => {
    const effect = {
      id: 'fx-001',
      kind: 'blur' as const,
      enabled: true,
      params: { radius: 5 },
    };
    const clip = {
      id: 'clip-001',
      trackId: 'track-001',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [effect],
      keyframeTracks: [],
    };
    const originalRadius = effect.params.radius;
    evaluateEffectParam(effect, clip, 1.0);
    // Original must not be mutated
    expect(effect.params.radius).toBe(originalRadius);
  });
});

describe('evaluateEffectParam — animated path', () => {
  test('overrides field with interpolated value when track matches effectId.fieldName', () => {
    const effect = {
      id: 'fx-abc',
      kind: 'blur' as const,
      enabled: true,
      params: { radius: 0 },
    };
    const clip = {
      id: 'clip-001',
      trackId: 'track-001',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [effect],
      keyframeTracks: [
        makeKeyframeTrack('fx-abc.radius', [
          makeKeyframe(0, 0, 'linear'),
          makeKeyframe(2, 10, 'linear'),
        ]),
      ],
    };
    const result = evaluateEffectParam(effect, clip, 1.0);
    // At t=1, midpoint between 0 and 10 → 5
    expect((result as any).radius).toBeCloseTo(5, 5);
  });

  test('does not mutate original effect.params when animated', () => {
    const effect = {
      id: 'fx-abc',
      kind: 'blur' as const,
      enabled: true,
      params: { radius: 0 },
    };
    const originalRadius = effect.params.radius;
    const clip = {
      id: 'clip-001',
      trackId: 'track-001',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [effect],
      keyframeTracks: [
        makeKeyframeTrack('fx-abc.radius', [
          makeKeyframe(0, 0, 'linear'),
          makeKeyframe(2, 10, 'linear'),
        ]),
      ],
    };
    evaluateEffectParam(effect, clip, 1.0);
    expect(effect.params.radius).toBe(originalRadius);
  });

  test('only overrides fields for matching effect (ignores other effect tracks)', () => {
    const effect = {
      id: 'fx-001',
      kind: 'blur' as const,
      enabled: true,
      params: { radius: 3 },
    };
    const clip = {
      id: 'clip-001',
      trackId: 'track-001',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [effect],
      keyframeTracks: [
        // Track for a DIFFERENT effect
        makeKeyframeTrack('fx-OTHER.radius', [
          makeKeyframe(0, 99, 'linear'),
          makeKeyframe(2, 99, 'linear'),
        ]),
      ],
    };
    const result = evaluateEffectParam(effect, clip, 1.0);
    // fx-001's radius must remain 3 (not overridden by fx-OTHER's track)
    expect((result as any).radius).toBe(3);
  });

  test('returns all original fields even when only one field is animated', () => {
    const effect = {
      id: 'fx-cc',
      kind: 'colorCorrect' as const,
      enabled: true,
      params: { brightness: 0, contrast: 0.5, saturation: 0, hue: 0, temperature: 0, tint: 0,
                liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1,
                gainR: 1, gainG: 1, gainB: 1 },
    };
    const clip = {
      id: 'clip-001',
      trackId: 'track-001',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [effect],
      keyframeTracks: [
        makeKeyframeTrack('fx-cc.brightness', [
          makeKeyframe(0, 0, 'linear'),
          makeKeyframe(2, 1, 'linear'),
        ]),
      ],
    };
    const result = evaluateEffectParam(effect, clip, 1.0) as any;
    // contrast (not animated) should remain 0.5
    expect(result.contrast).toBe(0.5);
    // brightness (animated) should be overridden at t=1 → midpoint = 0.5
    expect(result.brightness).toBeCloseTo(0.5, 5);
  });
});

// ── addKeyframe ───────────────────────────────────────────────────────────────

describe('addKeyframe', () => {
  test('adds a keyframe to an empty track', () => {
    const track = makeKeyframeTrack('brightness', []);
    const kf = makeKeyframe(1.0, 0.5);
    addKeyframe(track, kf);
    expect(track.keyframes).toHaveLength(1);
    expect(track.keyframes[0].t).toBe(1.0);
    expect(track.keyframes[0].value).toBe(0.5);
  });

  test('maintains sorted-by-t invariant when inserting before existing', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(2, 20)]);
    addKeyframe(track, makeKeyframe(1, 10));
    expect(track.keyframes[0].t).toBe(1);
    expect(track.keyframes[1].t).toBe(2);
  });

  test('maintains sorted-by-t invariant when inserting after existing', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(1, 10)]);
    addKeyframe(track, makeKeyframe(2, 20));
    expect(track.keyframes[0].t).toBe(1);
    expect(track.keyframes[1].t).toBe(2);
  });

  test('maintains sorted order when inserting in the middle', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0),
      makeKeyframe(2, 20),
    ]);
    addKeyframe(track, makeKeyframe(1, 10));
    expect(track.keyframes.map(k => k.t)).toEqual([0, 1, 2]);
  });

  test('replaces keyframe when t already exists', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(1.0, 5)]);
    addKeyframe(track, makeKeyframe(1.0, 99));
    expect(track.keyframes).toHaveLength(1);
    expect(track.keyframes[0].value).toBe(99);
  });

  test('replaces correct keyframe when multiple exist', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0),
      makeKeyframe(1, 10),
      makeKeyframe(2, 20),
    ]);
    addKeyframe(track, makeKeyframe(1, 99));
    expect(track.keyframes).toHaveLength(3);
    expect(track.keyframes[1].value).toBe(99);
  });
});

// ── removeKeyframe ────────────────────────────────────────────────────────────

describe('removeKeyframe', () => {
  test('removes the keyframe at exact t', () => {
    const track = makeKeyframeTrack('brightness', [
      makeKeyframe(0, 0),
      makeKeyframe(1, 10),
      makeKeyframe(2, 20),
    ]);
    removeKeyframe(track, 1.0);
    expect(track.keyframes).toHaveLength(2);
    expect(track.keyframes.map(k => k.t)).toEqual([0, 2]);
  });

  test('removes with epsilon tolerance (1e-6)', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(1.0, 5)]);
    removeKeyframe(track, 1.0 + 5e-7);
    expect(track.keyframes).toHaveLength(0);
  });

  test('does nothing when no keyframe at t', () => {
    const track = makeKeyframeTrack('brightness', [makeKeyframe(0, 0), makeKeyframe(2, 20)]);
    removeKeyframe(track, 1.0);
    expect(track.keyframes).toHaveLength(2);
  });

  test('does nothing on empty track', () => {
    const track = makeKeyframeTrack('brightness', []);
    expect(() => removeKeyframe(track, 1.0)).not.toThrow();
    expect(track.keyframes).toHaveLength(0);
  });
});

// ── structuredClone round-trip ────────────────────────────────────────────────

describe('structuredClone compatibility', () => {
  test('keyframe data survives structuredClone round-trip', () => {
    const kf: Keyframe = {
      t: 1.5,
      value: 0.75,
      interpolation: 'bezier',
      handleOut: [0.3, 0.1],
      handleIn: [-0.2, -0.05],
    };
    const cloned = structuredClone(kf);
    expect(cloned).toEqual(kf);
    expect(cloned).not.toBe(kf); // different reference
    expect(cloned.handleOut).not.toBe(kf.handleOut); // deep clone
  });

  test('KeyframeTrack with multiple keyframes survives structuredClone', () => {
    const track: KeyframeTrack = {
      property: 'fx-abc.brightness',
      keyframes: [
        { t: 0, value: 0, interpolation: 'linear', handleOut: [0, 0], handleIn: [0, 0] },
        { t: 1, value: 1, interpolation: 'bezier', handleOut: [0.25, 0.1], handleIn: [-0.25, -0.1] },
        { t: 2, value: 0.5, interpolation: 'hold', handleOut: [0, 0], handleIn: [0, 0] },
      ],
    };
    const cloned = structuredClone(track);
    expect(cloned).toEqual(track);
    expect(cloned.keyframes).not.toBe(track.keyframes);
    expect(cloned.keyframes[1].handleOut).not.toBe(track.keyframes[1].handleOut);
  });
});

// ── types.ts additions ────────────────────────────────────────────────────────

describe('types.ts — Clip.keyframeTracks field', () => {
  test('Clip can include keyframeTracks array (type check via usage)', () => {
    // This tests that types.ts has been extended with keyframeTracks
    // If types.ts is missing the field, the import/usage in evaluateEffectParam would fail
    const clip = {
      id: 'c1',
      trackId: 't1',
      sourceFile: {} as File,
      sourceStart: 0,
      sourceEnd: 5,
      timelineStart: 0,
      speed: 1,
      audioGain: 1,
      effects: [],
      keyframeTracks: [] as KeyframeTrack[],
    };
    expect(clip.keyframeTracks).toEqual([]);
  });
});

describe('types.ts — TrackKind includes adjustment', () => {
  test('TrackKind accepts adjustment value', () => {
    // This is a TypeScript type test — if TrackKind doesn't include 'adjustment',
    // the import of TrackKind would fail TypeScript compilation
    // Runtime check: the string value 'adjustment' is valid
    const kind: import('../../src/editor/types.ts').TrackKind = 'adjustment';
    expect(kind).toBe('adjustment');
  });
});
