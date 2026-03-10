// ── Editor Data Model ──────────────────────────────────────────────────────────
// Non-destructive timeline: the Project tree is the single source of truth.
// All File references are held by Clip; no bytes are copied or mutated here.

export type TrackKind = 'video' | 'audio';

// ── Project ───────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  frameRate: number;       // e.g. 24, 30, 60
  width: number;           // canvas output width in pixels
  height: number;          // canvas output height in pixels
  sampleRate: number;      // audio sample rate (44100 or 48000)
  tracks: Track[];
  duration: number;        // total timeline duration in seconds (computed from clips)
}

// ── Track ─────────────────────────────────────────────────────────────────────

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  volume: number;          // 0.0–2.0  (1.0 = unity)
  pan: number;             // -1.0 (L) to 1.0 (R), audio tracks only
  linkedTrackId?: string;  // ID of a paired track (video↔audio)
  clips: Clip[];
}

// ── Clip ──────────────────────────────────────────────────────────────────────

export interface Clip {
  id: string;
  trackId: string;
  sourceFile: File;        // original File handle — never mutated
  sourceStart: number;     // in-point in source media (seconds)
  sourceEnd: number;       // out-point in source media (seconds)
  timelineStart: number;   // position of in-point on the timeline (seconds)
  speed: number;           // playback speed multiplier (1.0 = normal)
  audioGain: number;       // 0.0–2.0 per-clip audio gain
  effects: Effect[];
  linkedClipId?: string;   // ID of a paired clip on the linked track
}

/** How long the clip occupies on the timeline, accounting for speed. */
export function clipTimelineDuration(clip: Clip): number {
  return (clip.sourceEnd - clip.sourceStart) / Math.abs(clip.speed);
}

/** Whether the clip is active at a given timeline position (seconds). */
export function clipActiveAt(clip: Clip, t: number): boolean {
  const end = clip.timelineStart + clipTimelineDuration(clip);
  return t >= clip.timelineStart && t < end;
}

/** Map a timeline position to the corresponding source position for a clip. */
export function clipSourceTime(clip: Clip, timelineT: number): number {
  const elapsed = timelineT - clip.timelineStart;
  // For reverse clips (speed < 0) anchor at sourceEnd so time walks backward from the out-point.
  return clip.speed >= 0
    ? clip.sourceStart + elapsed * clip.speed
    : clip.sourceEnd   + elapsed * clip.speed;
}

// ── Effects ───────────────────────────────────────────────────────────────────

export type EffectKind = 'colorCorrect' | 'lut' | 'blur' | 'sharpen' | 'vignette' | 'transform' | 'crop';

export interface Effect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  params: EffectParams;
}

// Color correction — the primary grading effect
export interface ColorCorrectParams {
  // Basic
  brightness: number;       // -1.0 to 1.0
  contrast: number;         // -1.0 to 1.0
  saturation: number;       // -1.0 to 1.0
  hue: number;              // -180 to 180 degrees
  temperature: number;      // -1.0 (cool/blue) to 1.0 (warm/orange)
  tint: number;             // -1.0 (green) to 1.0 (magenta)
  // 3-way color wheels (lift/gamma/gain per channel)
  liftR: number;  liftG: number;  liftB: number;
  gammaR: number; gammaG: number; gammaB: number;
  gainR: number;  gainG: number;  gainB: number;
}

// 3D LUT
export interface LutParams {
  lutData: Float32Array;   // size^3 × 3 floats (R,G,B interleaved)
  size: number;            // LUT dimension e.g. 17, 33, 65
  opacity: number;         // 0.0–1.0
}

// Gaussian blur (separable)
export interface BlurParams {
  radius: number;          // 0–50 pixels
}

// Unsharp-mask sharpen
export interface SharpenParams {
  amount: number;          // 0–2.0
}

// Vignette
export interface VignetteParams {
  strength: number;        // 0.0–1.0
  midpoint: number;        // 0.0–1.0 (how far vignette extends inward)
  roundness: number;       // 0.0–1.0 (0 = square, 1 = circular)
  feather: number;         // 0.0–1.0
}

// Crop (all values 0.0–1.0, fraction of frame to remove from each edge)
export interface CropParams {
  left:   number;
  right:  number;
  top:    number;
  bottom: number;
}

// 2D transform
export interface TransformParams {
  x: number;               // pixels offset
  y: number;
  scaleX: number;          // 1.0 = no scale
  scaleY: number;
  rotation: number;        // degrees
  anchorX: number;         // 0.0–1.0 (normalized anchor point)
  anchorY: number;
}

export type EffectParams =
  | ColorCorrectParams
  | LutParams
  | BlurParams
  | SharpenParams
  | VignetteParams
  | TransformParams
  | CropParams;

// ── Factory functions ─────────────────────────────────────────────────────────

export function createProject(name = 'Untitled Project'): Project {
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    frameRate: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [],
    duration: 0,
  };
}

export function createTrack(kind: TrackKind, name?: string): Track {
  return {
    id: crypto.randomUUID(),
    kind,
    name: name ?? (kind === 'video' ? 'Video Track' : 'Audio Track'),
    muted: false,
    solo: false,
    locked: false,
    volume: 1.0,
    pan: 0,
    clips: [],
  };
}

export function createClip(
  file: File,
  trackId: string,
  sourceStart: number,
  sourceEnd: number,
  timelineStart: number,
): Clip {
  return {
    id: crypto.randomUUID(),
    trackId,
    sourceFile: file,
    sourceStart,
    sourceEnd,
    timelineStart,
    speed: 1.0,
    audioGain: 1.0,
    effects: [],
  };
}

export function createColorCorrectEffect(): Effect {
  const params: ColorCorrectParams = {
    brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0,
    liftR: 0,  liftG: 0,  liftB: 0,
    gammaR: 1, gammaG: 1, gammaB: 1,
    gainR:  1, gainG:  1, gainB:  1,
  };
  return { id: crypto.randomUUID(), kind: 'colorCorrect', enabled: true, params };
}

export function createBlurEffect(radius = 4): Effect {
  return { id: crypto.randomUUID(), kind: 'blur', enabled: true, params: { radius } satisfies BlurParams };
}

export function createSharpenEffect(amount = 0.5): Effect {
  return { id: crypto.randomUUID(), kind: 'sharpen', enabled: true, params: { amount } satisfies SharpenParams };
}

export function createVignetteEffect(): Effect {
  const params: VignetteParams = { strength: 0.4, midpoint: 0.5, roundness: 0.5, feather: 0.5 };
  return { id: crypto.randomUUID(), kind: 'vignette', enabled: true, params };
}

export function createTransformEffect(): Effect {
  const params: TransformParams = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 };
  return { id: crypto.randomUUID(), kind: 'transform', enabled: true, params };
}

export function createCropEffect(): Effect {
  const params: CropParams = { left: 0, right: 0, top: 0, bottom: 0 };
  return { id: crypto.randomUUID(), kind: 'crop', enabled: true, params };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recompute project duration from all track clips. */
export function recomputeDuration(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + clipTimelineDuration(clip);
      if (end > max) max = end;
    }
  }
  return max;
}

/**
 * Deep-clone a project for undo/redo history.
 * File objects are intentionally shared (same reference) — they are immutable
 * and copying them would be wasteful and incorrect.
 * All other data (effects, params, positions) is deeply cloned.
 */
export function cloneProject(p: Project): Project {
  return {
    ...p,
    tracks: p.tracks.map(t => ({
      ...t,
      clips: t.clips.map(c => ({
        ...c,
        // sourceFile is deliberately shared — Files are immutable
        effects: c.effects.map(e => ({
          ...e,
          // structuredClone correctly deep-copies typed arrays (Float32Array in LutParams)
          params: structuredClone(e.params),
        })),
      })),
    })),
  };
}
