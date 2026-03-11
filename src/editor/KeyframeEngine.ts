// ── KeyframeEngine ─────────────────────────────────────────────────────────────
// Pure interpolation functions for keyframe animation.
// No browser API dependencies — fully testable with Bun Test.
// All functions are stateless; data is stored in plain KeyframeTrack objects.

import type { Keyframe, KeyframeTrack, Effect, Clip, EffectParams } from './types.ts';

// ── Internal math helpers ──────────────────────────────────────────────────────

/**
 * Evaluate a cubic bezier polynomial at parameter t ∈ [0, 1].
 * B(t) = (1-t)³·p0 + 3(1-t)²t·p1 + 3(1-t)t²·p2 + t³·p3
 */
function cubicBezierValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Evaluate the derivative of a cubic bezier polynomial at parameter t.
 * B'(t) = 3(1-t)²(p1-p0) + 6(1-t)t(p2-p1) + 3t²(p3-p2)
 */
function cubicBezierDerivative(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/**
 * Solve for the bezier parameter t given a target x value using Newton-Raphson.
 * Uses 8 iterations and clamps t to [0, 1] after each step.
 *
 * The time axis control points (p0..p3) must be in normalized [0, 1] range.
 * p1 and p2 are clamped to [0, 1] to prevent divergence (see Pitfall 6 in RESEARCH.md).
 */
function solveBezierT(p0: number, p1: number, p2: number, p3: number, x: number): number {
  // Clamp control points to avoid divergence when free handles extend beyond segment
  const cp1 = Math.max(0, Math.min(1, p1));
  const cp2 = Math.max(0, Math.min(1, p2));

  let t = x; // initial guess: x is a reasonable approximation for the cubic root
  for (let i = 0; i < 8; i++) {
    const xT = cubicBezierValue(p0, cp1, cp2, p3, t) - x;
    const dxT = cubicBezierDerivative(p0, cp1, cp2, p3, t);
    if (Math.abs(dxT) < 1e-8) break;
    t -= xT / dxT;
    t = Math.max(0, Math.min(1, t));
  }
  return t;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a keyframe track at a clip-relative time (seconds from clip start).
 *
 * Assumes track.keyframes is sorted by t ascending.
 *
 * - Empty track → 0
 * - Single keyframe → returns that value for all t
 * - t before first keyframe → clamp to first value
 * - t after last keyframe → clamp to last value
 * - Otherwise → interpolate using the left keyframe's interpolation type
 */
export function evaluateTrack(track: KeyframeTrack, clipRelativeT: number): number {
  const kf = track.keyframes;
  if (kf.length === 0) return 0;
  if (kf.length === 1) return kf[0].value;
  if (clipRelativeT <= kf[0].t) return kf[0].value;
  if (clipRelativeT >= kf[kf.length - 1].t) return kf[kf.length - 1].value;

  // Find the segment: kf[i].t <= clipRelativeT < kf[i+1].t
  let i = 0;
  while (i < kf.length - 1 && kf[i + 1].t <= clipRelativeT) i++;

  const a = kf[i];
  const b = kf[i + 1];
  const dt = b.t - a.t;
  const u = dt > 0 ? (clipRelativeT - a.t) / dt : 0;

  if (a.interpolation === 'hold') {
    return a.value;
  }

  if (a.interpolation === 'linear') {
    return a.value + u * (b.value - a.value);
  }

  // 'bezier': handles are stored as [dt, dv] offsets from the keyframe position
  // Convert to normalized [0, 1] control points for the time axis:
  //   p0 = 0 (start of segment, normalized)
  //   p1 = a.handleOut[0] / dt (exit handle time, normalized)
  //   p2 = 1 + b.handleIn[0] / dt (b.handleIn[0] is negative, pointing left)
  //   p3 = 1 (end of segment, normalized)
  const p0 = 0;
  const p1 = a.handleOut[0] / dt;
  const p2 = 1 + b.handleIn[0] / dt;
  const p3 = 1;

  // Solve for the bezier parametric t that corresponds to our x=u position on the time axis
  const bezierT = solveBezierT(p0, p1, p2, p3, u);

  // Evaluate the value axis using the bezier parametric t
  // Value control points (not normalized — can overshoot for artistic effect):
  //   v0 = a.value
  //   v1 = a.value + a.handleOut[1]
  //   v2 = b.value + b.handleIn[1]
  //   v3 = b.value
  return cubicBezierValue(a.value, a.value + a.handleOut[1], b.value + b.handleIn[1], b.value, bezierT);
}

/**
 * Evaluate all animated effect parameters for a clip at a given clip-relative time.
 *
 * - Fast path: if no keyframe tracks match this effect, returns structuredClone(effect.params)
 * - Animated path: clones params, then overrides each animated field with the interpolated value
 *
 * NEVER mutates effect.params — always returns a fresh clone.
 *
 * Property path format: "<effectId>.<fieldName>"
 * e.g., "fx-abc123.brightness" targets the 'brightness' field of effect with id "fx-abc123"
 */
export function evaluateEffectParam(
  effect: Effect,
  clip: Clip,
  clipRelativeT: number,
): EffectParams {
  const prefix = effect.id + '.';

  // Check for any matching tracks first (fast path — avoid clone if no animation)
  const matchingTracks = clip.keyframeTracks.filter(t => t.property.startsWith(prefix));
  if (matchingTracks.length === 0) {
    return structuredClone(effect.params);
  }

  // Clone params to avoid mutating the stored static values
  const params = structuredClone(effect.params) as unknown as Record<string, unknown>;

  for (const track of matchingTracks) {
    const field = track.property.slice(prefix.length);
    if (field in params) {
      (params as Record<string, number>)[field] = evaluateTrack(track, clipRelativeT);
    }
  }

  return params as unknown as EffectParams;
}

/**
 * Insert a keyframe into a track, maintaining the sorted-by-t invariant.
 *
 * - If a keyframe at the same t already exists (exact match), it is replaced.
 * - Mutates track.keyframes in place.
 */
export function addKeyframe(track: KeyframeTrack, keyframe: Keyframe): void {
  const kf = track.keyframes;

  // Check for existing keyframe at the same t (exact match)
  const existingIndex = kf.findIndex(k => k.t === keyframe.t);
  if (existingIndex !== -1) {
    kf[existingIndex] = keyframe;
    return;
  }

  // Find insertion point to maintain sorted-by-t order
  let insertAt = kf.length;
  for (let i = 0; i < kf.length; i++) {
    if (kf[i].t > keyframe.t) {
      insertAt = i;
      break;
    }
  }

  kf.splice(insertAt, 0, keyframe);
}

/**
 * Remove the keyframe at time t from the track.
 *
 * Uses epsilon tolerance of 1e-6 to handle floating-point imprecision.
 * If no matching keyframe is found, does nothing.
 * Mutates track.keyframes in place.
 */
export function removeKeyframe(track: KeyframeTrack, t: number): void {
  const EPSILON = 1e-6;
  const index = track.keyframes.findIndex(k => Math.abs(k.t - t) < EPSILON);
  if (index !== -1) {
    track.keyframes.splice(index, 1);
  }
}
