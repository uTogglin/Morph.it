// ── PlaybackEngine ─────────────────────────────────────────────────────────────
// Orchestrates the RAF loop: for each frame, finds active clips, pulls VideoFrames
// from ClipDecoder instances, composites them through EffectChain (bottom track
// first, top track last), and draws the result to the display canvas.
// Audio is routed through AudioMixer with video element sources.
//
// Fixes applied in this version:
//   C1  – _decoderStarting Set prevents concurrent seekTo+play races per clip
//   C4  – _rendering guard prevents concurrent renderFrame() calls
//   M2  – seekTo() restores to correct state ('paused' not always 'idle')
//   M3  – _registeredMixerTrackIds tracks known tracks; syncTracksToMixer removes stale ones
//   M4  – getOrCreate only called for clips that are active at currentTime
//   M7  – delta-time loop (capped at 200 ms) + visibilitychange handler for tab-backgrounding
//   L5  – applySolo() wired in syncTracksToMixer()

import type { Project, Track, Clip } from './types.ts';
import { clipActiveAt, clipSourceTime, clipTimelineDuration } from './types.ts';
import { EffectChain } from './EffectChain.ts';
import { ClipDecoder, ClipDecoderPool } from './ClipDecoder.ts';
import type { TrackAudioConfig } from './AudioMixer.ts';
import { AudioMixer } from './AudioMixer.ts';

export type EngineState = 'idle' | 'playing' | 'paused' | 'seeking';

export interface PlaybackEngineOptions {
  /** Called every frame with the current playhead time (seconds). */
  onTimeUpdate?: (time: number) => void;
  /** Called when playback reaches the end of the timeline. */
  onEnded?: () => void;
  /** Called when state changes. */
  onStateChange?: (state: EngineState) => void;
  /** Called when EffectChain encounters a GPU limitation (e.g. no RGBA16F support). */
  onWarning?: (msg: string) => void;
}

export class PlaybackEngine {
  private project: Project;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private effectChain: EffectChain;
  private decoders: ClipDecoderPool;
  private mixer: AudioMixer;
  private opts: PlaybackEngineOptions;

  private state: EngineState = 'idle';
  private currentTime = 0;            // seconds on timeline

  private _rafId: number | null = null;
  // M7: store the wall-clock timestamp of the previous RAF tick
  private _lastTickTime: number | null = null;

  // Track which video elements are already connected to the mixer
  private _connectedDecoders = new Set<string>();

  // C1: guard against concurrent seekTo+play per clip ID
  private _decoderStarting = new Set<string>();

  // C4: guard against concurrent renderFrame() calls
  private _rendering = false;

  // M3: track which track IDs have been registered with the mixer so stale ones can be removed
  private _registeredMixerTrackIds = new Set<string>();

  // M7: visibilitychange handler reference for cleanup
  private _onVisibilityChange: () => void;

  constructor(project: Project, canvas: HTMLCanvasElement, opts: PlaybackEngineOptions = {}) {
    this.project = project;
    this.canvas  = canvas;
    this.opts    = opts;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('PlaybackEngine: could not get 2D context from canvas');
    this.ctx2d = ctx;

    this.effectChain = new EffectChain(project.width, project.height, opts.onWarning);
    this.decoders    = new ClipDecoderPool();
    this.mixer       = new AudioMixer();

    // Pre-register all tracks in the mixer
    this.syncTracksToMixer();

    // M7: reset timing anchor when tab becomes visible again to avoid a
    // giant delta-time burst that would skip the playhead forward seconds.
    this._onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        this._lastTickTime = null; // force delta reset on next tick
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get playing(): boolean        { return this.state === 'playing'; }
  get paused(): boolean         { return this.state === 'paused' || this.state === 'idle'; }
  get time(): number            { return this.currentTime; }
  get duration(): number        { return this.project.duration; }
  /** Expose mixer so external panels can update per-track settings in real-time. */
  get audioMixer(): AudioMixer  { return this.mixer; }

  /** Start or resume playback from the current time. */
  async play(): Promise<void> {
    if (this.state === 'playing') return;
    await this.mixer.resume();
    this._lastTickTime = null; // M7: reset so first tick delta is 0
    this.setState('playing');
    this.scheduleRAF();
  }

  /** Pause playback at the current time. */
  pause(): void {
    if (this.state !== 'playing') return;
    this.cancelRAF();
    for (const track of this.videoTracks()) {
      for (const clip of track.clips) {
        if (clipActiveAt(clip, this.currentTime)) {
          this.decoders.get(clip.id)?.pause();
        }
      }
    }
    this.setState('paused');
  }

  /**
   * Seek to a specific timeline position (seconds).
   * Returns when the frame at that position is rendered.
   * M2 fix: restores to 'paused' (not 'idle') when pre-seek state was 'paused'.
   */
  async seekTo(seconds: number): Promise<void> {
    const prevState = this.state;          // M2: remember state before seek
    if (prevState === 'playing') this.pause();

    this.currentTime = Math.max(0, Math.min(seconds, this.project.duration));
    this.setState('seeking');

    const seekPromises: Promise<void>[] = [];
    for (const track of this.videoTracks()) {
      for (const clip of track.clips) {
        if (clipActiveAt(clip, this.currentTime)) {
          const decoder = this.decoders.getOrCreate(clip.id, clip.sourceFile);
          const srcTime = clipSourceTime(clip, this.currentTime);
          seekPromises.push(
            decoder.ready
              .then(() => decoder.seekTo(srcTime))
              .then(() => { /* frame delivered via onFrame */ })
          );
        }
      }
    }

    await Promise.all(seekPromises);
    await this.renderFrame();
    this.opts.onTimeUpdate?.(this.currentTime);

    // M2 fix: restore to correct prior state
    if (prevState === 'playing' || prevState === 'paused') {
      this.setState('paused');
    } else {
      this.setState('idle');
    }
  }

  /** Hot-swap the project reference (e.g. after an edit). Does not restart playback. */
  updateProject(project: Project): void {
    this.project = project;
    this.syncTracksToMixer();
  }

  dispose(): void {
    this.cancelRAF();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this.decoders.disposeAll();
    this.effectChain.dispose();
    this.mixer.dispose();
    this._connectedDecoders.clear();
    this._decoderStarting.clear();
    this._registeredMixerTrackIds.clear();
  }

  // ── RAF loop ───────────────────────────────────────────────────────────────

  private scheduleRAF(): void {
    this._rafId = requestAnimationFrame((now) => this.tick(now));
  }

  private cancelRAF(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * M7 fix: use delta-time rather than absolute wall-clock offset so that
   * backgrounding the tab (which pauses RAF) doesn't cause a time jump.
   * Delta is capped at 200 ms to handle occasional scheduler stalls.
   */
  private async tick(now: number): Promise<void> {
    if (this.state !== 'playing') return;

    const MAX_DELTA = 0.2; // seconds
    if (this._lastTickTime === null) {
      // First tick after play() or after tab re-focus: advance by zero
      this._lastTickTime = now;
    }
    const delta = Math.min((now - this._lastTickTime) / 1000, MAX_DELTA);
    this._lastTickTime = now;

    this.currentTime += delta;

    if (this.currentTime >= this.project.duration) {
      this.currentTime = this.project.duration;
      await this.renderFrame();
      this.pause();
      this.opts.onTimeUpdate?.(this.currentTime);
      this.opts.onEnded?.();
      return;
    }

    this.tickDecoders();

    await this.renderFrame();
    this.opts.onTimeUpdate?.(this.currentTime);

    if (this.state === 'playing') this.scheduleRAF();
  }

  // ── Decoder management ────────────────────────────────────────────────────

  private tickDecoders(): void {
    for (const track of this.videoTracks()) {
      for (const clip of track.clips) {
        const active = clipActiveAt(clip, this.currentTime);

        if (active) {
          // M4 fix: only call getOrCreate for active clips
          const decoder = this.decoders.getOrCreate(clip.id, clip.sourceFile);

          // Connect audio synchronously — the video element exists immediately at
          // ClipDecoder construction; no need to await decoder.ready. Doing this
          // synchronously guarantees the Web Audio route is established before
          // the async seekTo+play chain below can start the video playing.
          if (!this._connectedDecoders.has(clip.id)) {
            this.mixer.connectVideoElement(decoder.videoElement, clip.trackId);
            this._connectedDecoders.add(clip.id);
          }

          // C1 fix: guard against concurrent seekTo+play per decoder
          if (!decoder.playing && !this._decoderStarting.has(clip.id)) {
            this._decoderStarting.add(clip.id);
            const srcTime = clipSourceTime(clip, this.currentTime);
            decoder.ready.then(async () => {
              await decoder.seekTo(srcTime);
              // CR4 fix: only play if state is still 'playing' — the user may have
              // paused between when this async chain started and when seek finished.
              if (this.state === 'playing') await decoder.play();
            }).catch(() => { /* ignore */ }).finally(() => {
              this._decoderStarting.delete(clip.id);
            });
          }
        } else {
          // Clip not active — pause decoder to save resources
          const decoder = this.decoders.get(clip.id);
          if (decoder?.playing) decoder.pause();
        }
      }
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * Composite all active video clips onto the display canvas.
   * C4 fix: _rendering guard prevents overlapping async render calls.
   */
  private async renderFrame(): Promise<void> {
    if (this._rendering) return;
    this._rendering = true;

    try {
      const { width, height } = this.project;
      // Guard: assigning canvas.width/height (even to the same value) clears the
      // backing store on most browsers — skip when dimensions haven't changed.
      if (this.canvas.width  !== width)  this.canvas.width  = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.ctx2d.clearRect(0, 0, width, height);

      for (const track of this.videoTracks()) {
        if (track.muted) continue;

        for (const clip of track.clips) {
          if (!clipActiveAt(clip, this.currentTime)) continue;

          const decoder = this.decoders.get(clip.id);
          const frame   = decoder?.latestFrame;
          if (!frame) continue;

          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await this.effectChain.process(frame, clip.effects);
            this.ctx2d.drawImage(bitmap, 0, 0, width, height);
          } catch (e) {
            console.warn('[PlaybackEngine] effect chain error:', e);
          } finally {
            bitmap?.close();
          }
        }
      }
    } finally {
      this._rendering = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private videoTracks(): Track[] {
    return this.project.tracks.filter(t => t.kind === 'video');
  }

  private setState(s: EngineState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  /**
   * M3 fix: track registered IDs and remove stale ones when the project changes.
   * L5 fix: call applySolo() so solo state is reflected immediately.
   */
  private syncTracksToMixer(): void {
    const currentIds = new Set<string>();
    const soloConfigs = new Map<string, TrackAudioConfig>();

    for (const track of this.project.tracks) {
      currentIds.add(track.id);
      const config: TrackAudioConfig = {
        volume: track.volume,
        pan:    track.pan,
        muted:  track.muted,
        solo:   track.solo,
      };
      soloConfigs.set(track.id, config);
      this.mixer.addTrack(track.id, config);
      this.mixer.setVolume(track.id, track.volume);
      this.mixer.setPan(track.id, track.pan);
      this.mixer.setMuted(track.id, track.muted);
      this._registeredMixerTrackIds.add(track.id);
    }

    // M3 fix: remove tracks that no longer exist in the project
    for (const id of this._registeredMixerTrackIds) {
      if (!currentIds.has(id)) {
        this.mixer.removeTrack(id);
        this._registeredMixerTrackIds.delete(id);
      }
    }

    // L5 fix: apply solo state across all tracks
    this.mixer.applySolo(soloConfigs);
  }
}

// ── Utility ────────────────────────────────────────────────────────────────────
export function computeTimelineDuration(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + clipTimelineDuration(clip);
      if (end > max) max = end;
    }
  }
  return max;
}
