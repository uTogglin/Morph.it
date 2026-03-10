// ── ClipDecoder ────────────────────────────────────────────────────────────────
// Wraps an HTMLVideoElement to provide per-frame VideoFrame objects for a
// single source clip, with seek support.
//
// Strategy:
//   • Preview playback:  HTMLVideoElement drives decoding (hardware-accelerated,
//     zero extra deps). requestVideoFrameCallback delivers frame metadata on each
//     decoded frame; we wrap the element itself in a VideoFrame for WebGL upload.
//   • Accurate seek:     video.currentTime = t, then wait for the next
//     requestVideoFrameCallback to confirm the frame has been presented.
//   • Frame output:      new VideoFrame(videoElement, { timestamp }) — a zero-copy
//     wrapper that can be passed directly to WebGL texImage2D or EffectChain.
//     Caller MUST call frame.close() after use to release the GPU resource.
//
// Note: requestVideoFrameCallback is available in Chrome 83+, Edge, and
// Safari 15.4+. The type declarations live in global.d.ts.

export type FrameCallback = (frame: VideoFrame, presentedTime: number) => void;

export class ClipDecoder {
  private video: HTMLVideoElement;
  private objectUrl: string;
  private _ready: Promise<void>;
  private _duration = 0;
  private _width = 0;
  private _height = 0;
  private _playing = false;
  private _disposed = false;

  /**
   * If non-null, the next rVFC callback resolves this promise and clears it.
   * This is the fix for C2 (non-reentrant seekTo) — rather than swapping
   * onFrame in/out, we track pending seek resolution separately so concurrent
   * seekTo calls simply replace the resolver (last seek wins) without
   * corrupting the permanent onFrame callback.
   */
  private _seekPending: ((frame: VideoFrame) => void) | null = null;
  private _seekReject:  ((err: unknown) => void) | null = null;

  /** Latest decoded frame — caller must .close() it after use. */
  latestFrame: VideoFrame | null = null;

  /** Called each time a new frame is presented during playback or after seek. */
  onFrame: FrameCallback | null = null;

  /** Called when the video has ended naturally. */
  onEnded: (() => void) | null = null;

  constructor(file: File) {
    this.objectUrl = URL.createObjectURL(file);
    this.video = document.createElement('video');
    this.video.muted = true;           // must be muted to autoplay without gesture
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.src = this.objectUrl;

    this.video.addEventListener('ended', () => {
      this._playing = false;
      this.onEnded?.();
    });

    // Reject any pending seek promise if the video element errors (e.g. corrupt
    // stream, network loss). Without this the seekTo() caller would hang forever.
    this.video.addEventListener('error', () => {
      if (this._seekReject) {
        const reject = this._seekReject;
        this._seekPending = null;
        this._seekReject  = null;
        reject(new Error(`ClipDecoder: video error during seek — ${this.video.error?.message ?? 'unknown error'}`));
      }
    });

    this._ready = new Promise((resolve, reject) => {
      this.video.addEventListener('loadedmetadata', () => {
        this._duration = this.video.duration;
        this._width    = this.video.videoWidth;
        this._height   = this.video.videoHeight;
        resolve();
      }, { once: true });
      this.video.addEventListener('error', () => {
        reject(new Error(`ClipDecoder: failed to load video — ${this.video.error?.message ?? 'unknown error'}`));
      }, { once: true });
    });

    // Start the rVFC loop: runs whenever the video is playing OR after a seek.
    this.scheduleFrameCallback();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Resolves when metadata is loaded and the decoder is ready to seek/play. */
  get ready(): Promise<void> { return this._ready; }

  get duration(): number { return this._duration; }
  get videoWidth(): number { return this._width; }
  get videoHeight(): number { return this._height; }
  get playing(): boolean { return this._playing; }
  get currentTime(): number { return this.video.currentTime; }

  /**
   * Expose the underlying HTMLVideoElement so AudioMixer can create a
   * MediaElementAudioSourceNode from it. The element is muted by default;
   * audio is routed exclusively through AudioMixer.
   */
  get videoElement(): HTMLVideoElement { return this.video; }

  /**
   * Seek to a specific time in the source clip.
   * Returns a Promise that resolves with the VideoFrame at that position.
   * The returned frame must be .close()d by the caller.
   *
   * C2 fix: uses _seekPending instead of swapping onFrame, so concurrent
   * calls are safe — the last seek wins and previous promises are abandoned.
   * The caller (PlaybackEngine) prevents concurrent seeks via _decoderStarting.
   */
  seekTo(seconds: number): Promise<VideoFrame> {
    return new Promise<VideoFrame>((resolve, reject) => {
      this._seekPending = resolve;
      this._seekReject  = reject;
      this.video.currentTime = Math.max(0, Math.min(seconds, this._duration));
    });
  }

  /** Start continuous playback. Frames are delivered via onFrame callback. */
  async play(): Promise<void> {
    await this._ready;
    this._playing = true;
    await this.video.play();
  }

  /** Pause playback. */
  pause(): void {
    this._playing = false;
    this.video.pause();
  }

  /** Set playback rate (speed). 0.25–4.0 are well-supported. */
  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  /** Set audio volume (0.0–1.0). Note: for timeline mixing use AudioMixer instead. */
  setVolume(vol: number): void {
    this.video.volume = Math.max(0, Math.min(1, vol));
  }

  /** Release all resources. Must be called when the clip is removed from the timeline. */
  dispose(): void {
    this._disposed    = true;    // C3: stops rVFC loop from re-registering
    this._seekPending = null;    // C2: abandon any in-flight seek
    this._seekReject  = null;
    this.pause();
    this.onFrame  = null;
    this.onEnded  = null;
    this.latestFrame?.close();
    this.latestFrame = null;
    this.video.src = '';
    this.video.load();
    URL.revokeObjectURL(this.objectUrl);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Register a requestVideoFrameCallback that fires on every decoded frame.
   * We wrap the video element in a VideoFrame so callers get a real VideoFrame
   * regardless of whether we're in playback or paused-after-seek mode.
   */
  private scheduleFrameCallback(): void {
    if (typeof this.video.requestVideoFrameCallback !== 'function') {
      // Fallback for browsers without rVFC: use requestAnimationFrame + draw
      // We note this silently — the engine will still work via RAF.
      return;
    }

    this.video.requestVideoFrameCallback((_, metadata) => {
      // C3 fix: stop re-registering after dispose
      if (this._disposed) return;

      // Close the previous frame to free GPU memory before creating a new one
      this.latestFrame?.close();
      this.latestFrame = null;

      try {
        // new VideoFrame(HTMLVideoElement) captures the currently displayed frame.
        // timestamp is in microseconds (metadata.mediaTime is in seconds).
        const frame = new VideoFrame(this.video, {
          timestamp: Math.round(metadata.mediaTime * 1_000_000),
        });
        this.latestFrame = frame;

        // C2 fix: resolve pending seek before calling the regular onFrame callback.
        // _seekPending is set by seekTo(), cleared here after first delivery.
        if (this._seekPending) {
          const resolve = this._seekPending;
          this._seekPending = null;
          this._seekReject  = null;
          resolve(frame);
        }

        this.onFrame?.(frame, metadata.mediaTime);
      } catch {
        // The video element may not have a presentable frame yet (e.g., during seek).
      }

      // Re-register so we keep getting callbacks for as long as the element exists.
      this.scheduleFrameCallback();
    });
  }
}

// ── ClipDecoderPool ────────────────────────────────────────────────────────────
// Manages a set of ClipDecoder instances keyed by clip ID.
// Ensures decoders are created once and reused across render cycles.

export class ClipDecoderPool {
  private pool = new Map<string, ClipDecoder>();

  get(clipId: string): ClipDecoder | undefined {
    return this.pool.get(clipId);
  }

  /** Get or create a decoder for this clip. */
  getOrCreate(clipId: string, file: File): ClipDecoder {
    let decoder = this.pool.get(clipId);
    if (!decoder) {
      decoder = new ClipDecoder(file);
      this.pool.set(clipId, decoder);
    }
    return decoder;
  }

  /** Remove and dispose a single decoder. */
  remove(clipId: string): void {
    this.pool.get(clipId)?.dispose();
    this.pool.delete(clipId);
  }

  /** Dispose all decoders and clear the pool. */
  disposeAll(): void {
    for (const decoder of this.pool.values()) decoder.dispose();
    this.pool.clear();
  }
}
