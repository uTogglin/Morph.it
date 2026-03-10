// ── WaveformCache ─────────────────────────────────────────────────────────────
// Lazily decodes audio from source Files and caches per-pixel peak amplitude
// data for timeline waveform drawing.
//
// Usage (from TimelineRenderer):
//   const cache = new WaveformCache();
//   // In drawClip:
//   const peaks = cache.getPeaks(clip.id);
//   if (peaks) { /* draw */ }
//   else cache.requestDecode(clip.id, clip.sourceFile, redrawCallback);

/** Peak resolution: number of amplitude samples stored per clip. */
const PEAK_RESOLUTION = 2000;

type DecodeState =
  | { status: 'pending' }
  | { status: 'ready'; peaks: Float32Array }
  | { status: 'error' };

export class WaveformCache {
  private _cache    = new Map<string, DecodeState>();
  private _ctx: AudioContext | null = null;

  private getAudioContext(): AudioContext {
    if (!this._ctx || this._ctx.state === 'closed') {
      this._ctx = new AudioContext();
    }
    return this._ctx;
  }

  /**
   * Return cached peak data for the given clip ID, or null if not yet decoded.
   */
  getPeaks(clipId: string): Float32Array | null {
    const entry = this._cache.get(clipId);
    if (entry?.status === 'ready') return entry.peaks;
    return null;
  }

  /**
   * Start async decoding for a clip if not already started.
   * `onReady` is called once the peaks are computed — typically triggers a redraw.
   */
  requestDecode(clipId: string, file: File, onReady: () => void): void {
    if (this._cache.has(clipId)) return; // already decoding or done

    this._cache.set(clipId, { status: 'pending' });

    this._decode(clipId, file).then((peaks) => {
      this._cache.set(clipId, { status: 'ready', peaks });
      onReady();
    }).catch(() => {
      this._cache.set(clipId, { status: 'error' });
    });
  }

  /** Remove cached data for a clip (e.g. when clip is deleted). */
  evict(clipId: string): void {
    this._cache.delete(clipId);
  }

  /** Clear all cached data. */
  clear(): void {
    this._cache.clear();
  }

  dispose(): void {
    this._cache.clear();
    this._ctx?.close().catch(() => { /* ignore */ });
    this._ctx = null;
  }

  // ── Private: decode + compute peaks ─────────────────────────────────────────

  private async _decode(clipId: string, file: File): Promise<Float32Array> {
    void clipId;

    const audioCtx = this.getAudioContext();

    // Read file bytes
    const arrayBuffer = await file.arrayBuffer();

    // Decode audio — throws if not an audio/video file with audio
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch {
      throw new Error('WaveformCache: audio decode failed');
    }

    return this._computePeaks(audioBuffer);
  }

  /**
   * Reduce an AudioBuffer to PEAK_RESOLUTION peak-amplitude values.
   * Uses the first channel (mono mix) for simplicity.
   */
  private _computePeaks(buffer: AudioBuffer): Float32Array {
    // Mix down to mono: average all channels
    const numChannels = buffer.numberOfChannels;
    const length      = buffer.length;
    const monoData    = new Float32Array(length);

    for (let c = 0; c < numChannels; c++) {
      const channelData = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        monoData[i] += channelData[i] / numChannels;
      }
    }

    const peaks      = new Float32Array(PEAK_RESOLUTION);
    const blockSize  = Math.max(1, Math.floor(length / PEAK_RESOLUTION));

    for (let i = 0; i < PEAK_RESOLUTION; i++) {
      const start = i * blockSize;
      const end   = Math.min(start + blockSize, length);
      let   peak  = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(monoData[j]);
        if (abs > peak) peak = abs;
      }
      peaks[i] = peak;
    }

    return peaks;
  }
}
