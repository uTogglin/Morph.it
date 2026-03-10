// Unit tests for pure logic helpers extracted from EffectChain.ts.
// These tests cover the math and data transforms that do NOT require a WebGL context.
// All helpers are exported from src/editor/EffectChain.ts.

import { describe, test, expect } from 'bun:test';
import type { Effect } from '../../src/editor/types.ts';
import {
  normalizeTransformUniforms,
  computeLutCoord,
  selectFboFormat,
  filterEnabledEffects,
  reorderEffects,
} from '../../src/editor/EffectChain.ts';

// ── normalizeTransformUniforms ────────────────────────────────────────────────

describe('normalizeTransformUniforms', () => {
  test('converts pixel x/y to normalized UV translation', () => {
    const params = { x: 100, y: 50, scaleX: 2, scaleY: 1.5, rotation: 90, anchorX: 0.5, anchorY: 0.5 };
    const result = normalizeTransformUniforms(params, 1920, 1080);
    // x/width = 100/1920, y/height = 50/1080
    expect(result.u_tx).toBeCloseTo(100 / 1920, 8);
    expect(result.u_ty).toBeCloseTo(50 / 1080, 8);
  });

  test('passes scale values through unchanged', () => {
    const params = { x: 0, y: 0, scaleX: 2, scaleY: 1.5, rotation: 0, anchorX: 0.5, anchorY: 0.5 };
    const result = normalizeTransformUniforms(params, 1920, 1080);
    expect(result.u_sx).toBe(2);
    expect(result.u_sy).toBe(1.5);
  });

  test('converts rotation degrees to radians', () => {
    const params = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 90, anchorX: 0, anchorY: 0 };
    const result = normalizeTransformUniforms(params, 1920, 1080);
    expect(result.u_rot).toBeCloseTo(Math.PI / 2, 8);
  });

  test('passes anchor values through unchanged', () => {
    const params = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 };
    const result = normalizeTransformUniforms(params, 1920, 1080);
    expect(result.u_ax).toBe(0.5);
    expect(result.u_ay).toBe(0.5);
  });

  test('full params set returns all seven uniforms', () => {
    const params = { x: 100, y: 50, scaleX: 2, scaleY: 1.5, rotation: 90, anchorX: 0.5, anchorY: 0.5 };
    const result = normalizeTransformUniforms(params, 1920, 1080);
    expect(Object.keys(result)).toEqual(['u_tx', 'u_ty', 'u_sx', 'u_sy', 'u_rot', 'u_ax', 'u_ay']);
  });
});

// ── computeLutCoord ───────────────────────────────────────────────────────────

describe('computeLutCoord', () => {
  test('scales+offsets input to avoid clamping artifacts', () => {
    // For value=0.5, lutSize=33: expected = 0.5 * (32/33) + 0.5/33
    const expected = 0.5 * (32 / 33) + 0.5 / 33;
    expect(computeLutCoord(0.5, 33)).toBeCloseTo(expected, 10);
  });

  test('maps 0.0 to 0.5/N (not 0) to avoid edge clamping', () => {
    expect(computeLutCoord(0.0, 33)).toBeCloseTo(0.5 / 33, 10);
  });

  test('maps 1.0 to (N-0.5)/N (not 1) to avoid edge clamping', () => {
    const expected = 1.0 * (32 / 33) + 0.5 / 33; // = (32 + 0.5) / 33 = 32.5/33
    expect(computeLutCoord(1.0, 33)).toBeCloseTo(expected, 10);
  });

  test('works with lutSize=17', () => {
    const expected = 0.5 * (16 / 17) + 0.5 / 17;
    expect(computeLutCoord(0.5, 17)).toBeCloseTo(expected, 10);
  });
});

// ── selectFboFormat ───────────────────────────────────────────────────────────

describe('selectFboFormat', () => {
  test('returns RGBA16F + HALF_FLOAT when extension is available', () => {
    const result = selectFboFormat(true);
    expect(result.internalFormat).toBe('RGBA16F');
    expect(result.type).toBe('HALF_FLOAT');
  });

  test('returns RGBA8 + UNSIGNED_BYTE when extension is unavailable', () => {
    const result = selectFboFormat(false);
    expect(result.internalFormat).toBe('RGBA8');
    expect(result.type).toBe('UNSIGNED_BYTE');
  });
});

// ── filterEnabledEffects ──────────────────────────────────────────────────────

describe('filterEnabledEffects', () => {
  const makeEffect = (id: string, enabled: boolean): Effect => ({
    id,
    kind: 'colorCorrect',
    enabled,
    params: { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0,
              liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1,
              gainR: 1, gainG: 1, gainB: 1 },
  });

  test('returns only enabled effects', () => {
    const effects = [makeEffect('a', true), makeEffect('b', false), makeEffect('c', true)];
    const result = filterEnabledEffects(effects);
    expect(result).toHaveLength(2);
    expect(result.map(e => e.id)).toEqual(['a', 'c']);
  });

  test('returns empty array when all are disabled', () => {
    const effects = [makeEffect('a', false), makeEffect('b', false)];
    expect(filterEnabledEffects(effects)).toHaveLength(0);
  });

  test('returns all effects when all are enabled', () => {
    const effects = [makeEffect('a', true), makeEffect('b', true)];
    expect(filterEnabledEffects(effects)).toHaveLength(2);
  });
});

// ── reorderEffects ────────────────────────────────────────────────────────────

describe('reorderEffects', () => {
  const makeEffect = (id: string): Effect => ({
    id,
    kind: 'colorCorrect',
    enabled: true,
    params: { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0,
              liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1,
              gainR: 1, gainG: 1, gainB: 1 },
  });

  test('moves element from index 2 to index 0 producing [c, a, b]', () => {
    const effects = [makeEffect('a'), makeEffect('b'), makeEffect('c')];
    const result = reorderEffects(effects, 2, 0);
    expect(result.map(e => e.id)).toEqual(['c', 'a', 'b']);
  });

  test('returns a new array (does not mutate original)', () => {
    const effects = [makeEffect('a'), makeEffect('b'), makeEffect('c')];
    const result = reorderEffects(effects, 0, 2);
    expect(result).not.toBe(effects);
    expect(effects.map(e => e.id)).toEqual(['a', 'b', 'c']); // original unchanged
  });

  test('moves element from index 0 to index 2 producing [b, c, a]', () => {
    const effects = [makeEffect('a'), makeEffect('b'), makeEffect('c')];
    const result = reorderEffects(effects, 0, 2);
    expect(result.map(e => e.id)).toEqual(['b', 'c', 'a']);
  });
});
