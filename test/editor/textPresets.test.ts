// Unit tests for TextPresets.ts — preset animation generators.
// Pure functions operating on a TextClip-shaped fixture (no DOM/canvas needed).
// TDD RED phase: all tests fail because src/editor/TextPresets.ts does not exist.

import { describe, test, expect } from 'bun:test';
import type { KeyframeTrack } from '../../src/editor/types.ts';
import {
  applyTextPreset,
  TEXT_PRESETS,
} from '../../src/editor/TextPresets.ts';

// ── Minimal TextClip fixture ───────────────────────────────────────────────────

/** Minimal shape required by applyTextPreset. */
interface MinimalTextClip {
  x: number;
  y: number;
  content: string;
  duration: number;
  keyframeTracks: KeyframeTrack[];
}

function makeClip(overrides: Partial<MinimalTextClip> = {}): MinimalTextClip {
  return {
    x: 960,
    y: 540,
    content: 'Hello World',
    duration: 5,
    keyframeTracks: [],
    ...overrides,
  };
}

/** Find the first keyframe track with the given property name. */
function findTrack(clip: MinimalTextClip, property: string): KeyframeTrack | undefined {
  return clip.keyframeTracks.find(t => t.property === property);
}

// ── TEXT_PRESETS array ────────────────────────────────────────────────────────

describe('TEXT_PRESETS — enumeration', () => {
  test('TEXT_PRESETS is an array', () => {
    expect(Array.isArray(TEXT_PRESETS)).toBe(true);
  });

  test('TEXT_PRESETS contains all 7 preset names', () => {
    const expected = ['fadeIn', 'fadeOut', 'slideInLeft', 'slideInRight', 'slideOutLeft', 'slideOutRight', 'typewriter'];
    for (const name of expected) {
      expect(TEXT_PRESETS).toContain(name);
    }
  });

  test('TEXT_PRESETS has exactly 7 entries', () => {
    expect(TEXT_PRESETS).toHaveLength(7);
  });
});

// ── fadeIn ────────────────────────────────────────────────────────────────────

describe("applyTextPreset('fadeIn')", () => {
  test('adds an opacity keyframe track', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeIn', 1920);
    const track = findTrack(clip, 'opacity');
    expect(track).toBeDefined();
  });

  test('first keyframe value is 0 (transparent)', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeIn', 1920);
    const track = findTrack(clip, 'opacity')!;
    expect(track.keyframes[0].value).toBe(0);
    expect(track.keyframes[0].t).toBe(0);
  });

  test('last keyframe value is 1 (opaque)', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeIn', 1920);
    const track = findTrack(clip, 'opacity')!;
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe(1);
  });

  test('adds exactly 2 keyframes', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeIn', 1920);
    const track = findTrack(clip, 'opacity')!;
    expect(track.keyframes).toHaveLength(2);
  });
});

// ── fadeOut ───────────────────────────────────────────────────────────────────

describe("applyTextPreset('fadeOut')", () => {
  test('adds an opacity track with first kf value=1, last kf value=0', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeOut', 1920);
    const track = findTrack(clip, 'opacity')!;
    expect(track).toBeDefined();
    expect(track.keyframes[0].value).toBe(1);
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe(0);
    expect(last.t).toBe(clip.duration);
  });
});

// ── slideInLeft ───────────────────────────────────────────────────────────────

describe("applyTextPreset('slideInLeft')", () => {
  test('adds an x keyframe track', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInLeft', 1920);
    const track = findTrack(clip, 'x');
    expect(track).toBeDefined();
  });

  test('first keyframe value is clip.x - projectWidth', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInLeft', 1920);
    const track = findTrack(clip, 'x')!;
    expect(track.keyframes[0].value).toBe(960 - 1920);
  });

  test('last keyframe value is clip.x', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInLeft', 1920);
    const track = findTrack(clip, 'x')!;
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe(960);
  });
});

// ── slideInRight ──────────────────────────────────────────────────────────────

describe("applyTextPreset('slideInRight')", () => {
  test('first keyframe value is clip.x + projectWidth', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInRight', 1920);
    const track = findTrack(clip, 'x')!;
    expect(track.keyframes[0].value).toBe(960 + 1920);
  });

  test('last keyframe value is clip.x', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInRight', 1920);
    const track = findTrack(clip, 'x')!;
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe(960);
  });
});

// ── slideOutLeft ──────────────────────────────────────────────────────────────

describe("applyTextPreset('slideOutLeft')", () => {
  test('adds an x track; first kf value is clip.x, last kf value is clip.x - projectWidth', () => {
    const clip = makeClip({ x: 960, duration: 5 });
    applyTextPreset(clip as any, 'slideOutLeft', 1920);
    const track = findTrack(clip, 'x')!;
    expect(track).toBeDefined();
    expect(track.keyframes[0].value).toBe(960);
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe(960 - 1920);
    expect(last.t).toBe(5);
  });
});

// ── slideOutRight ─────────────────────────────────────────────────────────────

describe("applyTextPreset('slideOutRight')", () => {
  test('adds an x track; last kf value is clip.x + projectWidth', () => {
    const clip = makeClip({ x: 960, duration: 5 });
    applyTextPreset(clip as any, 'slideOutRight', 1920);
    const track = findTrack(clip, 'x')!;
    expect(track).toBeDefined();
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe(960 + 1920);
    expect(last.t).toBe(5);
  });
});

// ── typewriter ────────────────────────────────────────────────────────────────

describe("applyTextPreset('typewriter')", () => {
  test('adds a charReveal track', () => {
    const clip = makeClip({ content: 'Hello World' });
    applyTextPreset(clip as any, 'typewriter', 1920);
    const track = findTrack(clip, 'charReveal');
    expect(track).toBeDefined();
  });

  test('first keyframe value is 0', () => {
    const clip = makeClip({ content: 'Hello World' });
    applyTextPreset(clip as any, 'typewriter', 1920);
    const track = findTrack(clip, 'charReveal')!;
    expect(track.keyframes[0].value).toBe(0);
    expect(track.keyframes[0].t).toBe(0);
  });

  test('last keyframe value is clip.content.length', () => {
    const clip = makeClip({ content: 'Hello World' }); // length = 11
    applyTextPreset(clip as any, 'typewriter', 1920);
    const track = findTrack(clip, 'charReveal')!;
    const last = track.keyframes[track.keyframes.length - 1];
    expect(last.value).toBe('Hello World'.length);
  });
});

// ── Idempotency — no duplicate tracks ────────────────────────────────────────

describe('applyTextPreset — replaces existing preset tracks', () => {
  test('calling fadeIn twice results in exactly one opacity track', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeIn', 1920);
    applyTextPreset(clip as any, 'fadeIn', 1920);
    const opacityTracks = clip.keyframeTracks.filter(t => t.property === 'opacity');
    expect(opacityTracks).toHaveLength(1);
  });

  test('switching from fadeIn to fadeOut replaces the opacity track', () => {
    const clip = makeClip();
    applyTextPreset(clip as any, 'fadeIn', 1920);
    applyTextPreset(clip as any, 'fadeOut', 1920);
    const opacityTracks = clip.keyframeTracks.filter(t => t.property === 'opacity');
    expect(opacityTracks).toHaveLength(1);
    // Should be fadeOut: last kf value = 0
    const last = opacityTracks[0].keyframes[opacityTracks[0].keyframes.length - 1];
    expect(last.value).toBe(0);
  });

  test('calling slideInLeft twice results in exactly one x track', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInLeft', 1920);
    applyTextPreset(clip as any, 'slideInLeft', 1920);
    const xTracks = clip.keyframeTracks.filter(t => t.property === 'x');
    expect(xTracks).toHaveLength(1);
  });

  test('switching from slideInLeft to typewriter removes x track, adds charReveal', () => {
    const clip = makeClip({ x: 960 });
    applyTextPreset(clip as any, 'slideInLeft', 1920);
    applyTextPreset(clip as any, 'typewriter', 1920);
    expect(clip.keyframeTracks.filter(t => t.property === 'x')).toHaveLength(0);
    expect(clip.keyframeTracks.filter(t => t.property === 'charReveal')).toHaveLength(1);
  });
});
