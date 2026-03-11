// ── ExportDecoder ──────────────────────────────────────────────────────────────
// Fast sequential video decoder for export using mp4box.js + WebCodecs
// VideoDecoder. Replaces HTMLVideoElement seek (~16-50ms/frame) with direct
// hardware-accelerated decoding (<1ms/frame for sequential access).
//
// For non-MP4 files (WebM, etc.), falls back to HTMLVideoElement seek.

let mp4boxModule: any = null;
async function getMP4Box(): Promise<any> {
  if (mp4boxModule) return mp4boxModule;
  mp4boxModule = await import('mp4box');
  return mp4boxModule;
}

interface Sample {
  timestamp: number;   // microseconds
  duration: number;    // microseconds
  isKeyframe: boolean;
  data: Uint8Array;
}

// ── ExportDecoder ─────────────────────────────────────────────────────────────

export class ExportDecoder {
  private samples: Sample[] = [];
  private decoderConfig: VideoDecoderConfig | null = null;
  private decoder: VideoDecoder | null = null;
  private _duration = 0;
  private _width = 0;
  private _height = 0;
  private _ready: Promise<void>;
  private _disposed = false;
  private _useFallback = false;
  private _file: File;

  // Fallback: HTMLVideoElement for non-MP4 files
  private fallbackVideo: HTMLVideoElement | null = null;
  private fallbackUrl: string | null = null;

  // Frame delivery from VideoDecoder
  private decodedFrames: Map<number, VideoFrame> = new Map();
  private nextDecodeIndex = 0;

  constructor(file: File) {
    this._file = file;
    this._ready = this.init(file);
  }

  get ready(): Promise<void> { return this._ready; }
  get duration(): number { return this._duration; }

  private async init(file: File): Promise<void> {
    // Try mp4box.js demux for MP4/MOV files
    const ext = file.name.toLowerCase();
    const isMp4Like = ext.endsWith('.mp4') || ext.endsWith('.m4v') || ext.endsWith('.mov');

    if (isMp4Like && typeof VideoDecoder !== 'undefined') {
      try {
        await this.initFastPath(file);
        return;
      } catch (e) {
        console.warn('[ExportDecoder] Fast path failed, falling back to HTMLVideoElement:', e);
      }
    }

    // Fallback for non-MP4 or if demux fails
    await this.initFallback(file);
  }

  private async initFastPath(file: File): Promise<void> {
    const MP4Box = await getMP4Box();
    const buffer = await file.arrayBuffer();
    const mp4File = MP4Box.createFile();

    const result = await new Promise<{
      samples: Sample[];
      config: VideoDecoderConfig;
      width: number;
      height: number;
    }>((resolve, reject) => {
      let codec = '';
      let codedWidth = 0;
      let codedHeight = 0;
      let description: Uint8Array | undefined;
      let trackTimescale = 0;
      const collectedSamples: Sample[] = [];

      mp4File.onReady = (info: any) => {
        const vt = info.videoTracks?.[0];
        if (!vt) { reject(new Error('No video track')); return; }

        codec = vt.codec;
        codedWidth = vt.video.width;
        codedHeight = vt.video.height;
        trackTimescale = vt.timescale;

        // Extract codec-specific description (avcC / hvcC / vpcC)
        const trak = mp4File.getTrackById(vt.id);
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          const descBox = entry.avcC || entry.hvcC || entry.vpcC;
          if (descBox) {
            const stream = new MP4Box.DataStream(
              undefined, 0, MP4Box.DataStream.BIG_ENDIAN,
            );
            descBox.write(stream);
            description = new Uint8Array(stream.buffer, 8);
            break;
          }
        }

        mp4File.setExtractionOptions(vt.id, null, { nbSamples: Infinity });
        mp4File.start();
      };

      mp4File.onSamples = (_id: number, _user: any, samples: any[]) => {
        for (const s of samples) {
          collectedSamples.push({
            timestamp: Math.round((s.cts / trackTimescale) * 1_000_000),
            duration: Math.round((s.duration / trackTimescale) * 1_000_000),
            isKeyframe: s.is_sync,
            data: new Uint8Array(s.data),
          });
        }
      };

      mp4File.onError = (e: any) => reject(new Error(`mp4box: ${e}`));

      (buffer as any).fileStart = 0;
      mp4File.appendBuffer(buffer);
      mp4File.flush();

      // After flush, everything is synchronous
      if (collectedSamples.length === 0) {
        reject(new Error('No samples extracted'));
        return;
      }

      collectedSamples.sort((a, b) => a.timestamp - b.timestamp);

      const config: VideoDecoderConfig = { codec, codedWidth, codedHeight };
      if (description) config.description = description;

      resolve({
        samples: collectedSamples,
        config,
        width: codedWidth,
        height: codedHeight,
      });
    });

    // Verify the browser supports this decoder config
    const support = await VideoDecoder.isConfigSupported(result.config);
    if (!support.supported) {
      throw new Error(`Unsupported decoder config: ${result.config.codec}`);
    }

    this.samples = result.samples;
    this.decoderConfig = result.config;
    this._width = result.width;
    this._height = result.height;

    if (this.samples.length > 0) {
      const last = this.samples[this.samples.length - 1];
      this._duration = (last.timestamp + last.duration) / 1_000_000;
    }

    // Create the VideoDecoder
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        // Store frame keyed by its timestamp
        this.decodedFrames.set(frame.timestamp, frame);
      },
      error: (e: DOMException) => {
        console.error('[ExportDecoder] VideoDecoder error:', e);
      },
    });
    this.decoder.configure(this.decoderConfig);
  }

  private async initFallback(file: File): Promise<void> {
    this._useFallback = true;
    this.fallbackUrl = URL.createObjectURL(file);
    this.fallbackVideo = document.createElement('video');
    this.fallbackVideo.playsInline = true;
    this.fallbackVideo.preload = 'auto';
    this.fallbackVideo.muted = true;
    this.fallbackVideo.src = this.fallbackUrl;

    await new Promise<void>((resolve, reject) => {
      this.fallbackVideo!.addEventListener('loadedmetadata', () => {
        this._duration = this.fallbackVideo!.duration;
        this._width = this.fallbackVideo!.videoWidth;
        this._height = this.fallbackVideo!.videoHeight;
        resolve();
      }, { once: true });
      this.fallbackVideo!.addEventListener('error', () => {
        reject(new Error('Failed to load video'));
      }, { once: true });
    });
  }

  /**
   * Get a decoded VideoFrame at the specified time (seconds).
   * For sequential export this is near-instant on the fast path.
   * Caller MUST close the returned frame.
   */
  async getFrameAt(timeSeconds: number): Promise<VideoFrame> {
    if (this._useFallback) return this.getFrameFallback(timeSeconds);
    return this.getFrameFast(timeSeconds);
  }

  private async getFrameFast(timeSeconds: number): Promise<VideoFrame> {
    const targetUs = Math.round(timeSeconds * 1_000_000);
    const sampleIdx = this.findSampleIndex(targetUs);
    if (sampleIdx < 0) throw new Error(`No sample for t=${timeSeconds}`);

    const targetTimestamp = this.samples[sampleIdx].timestamp;

    // Check if already decoded
    const cached = this.decodedFrames.get(targetTimestamp);
    if (cached) {
      return new VideoFrame(cached, { timestamp: cached.timestamp });
    }

    // Need to decode up to this sample
    // If target is behind current position, reset from nearest keyframe
    if (sampleIdx < this.nextDecodeIndex) {
      if (this.decoder && this.decoder.state === 'configured') {
        await this.decoder.flush();
      }
      this.clearFrameCache();
      // Find nearest keyframe at or before target
      let kf = sampleIdx;
      while (kf > 0 && !this.samples[kf].isKeyframe) kf--;
      this.nextDecodeIndex = kf;

      // Need to reset the decoder for a new keyframe sequence
      if (this.decoder && this.decoder.state !== 'closed') {
        this.decoder.reset();
        this.decoder.configure(this.decoderConfig!);
      }
    }

    // Decode from nextDecodeIndex through sampleIdx
    for (let i = this.nextDecodeIndex; i <= sampleIdx; i++) {
      if (this._disposed) throw new Error('Disposed');
      const sample = this.samples[i];
      this.decoder!.decode(new EncodedVideoChunk({
        type: sample.isKeyframe ? 'key' : 'delta',
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data,
      }));

      // Backpressure
      if (this.decoder!.decodeQueueSize > 30) {
        await this.decoder!.flush();
      }
    }

    await this.decoder!.flush();
    this.nextDecodeIndex = sampleIdx + 1;

    // Evict frames we won't need (keep last 5 for safety)
    this.evictOldFrames(targetTimestamp);

    const frame = this.decodedFrames.get(targetTimestamp);
    if (!frame) throw new Error(`Decode failed for sample ${sampleIdx}`);
    return new VideoFrame(frame, { timestamp: frame.timestamp });
  }

  private getFrameFallback(timeSeconds: number): Promise<VideoFrame> {
    const video = this.fallbackVideo!;
    const target = Math.max(0, Math.min(timeSeconds, this._duration));

    // Short-circuit if already at target
    if (Math.abs(video.currentTime - target) <= 1 / 60) {
      try {
        return Promise.resolve(new VideoFrame(video, {
          timestamp: Math.round(target * 1_000_000),
        }));
      } catch { /* fall through to seek */ }
    }

    return new Promise<VideoFrame>((resolve, reject) => {
      video.currentTime = target;
      video.requestVideoFrameCallback((_, meta) => {
        try {
          resolve(new VideoFrame(video, {
            timestamp: Math.round(meta.mediaTime * 1_000_000),
          }));
        } catch (e) { reject(e); }
      });
      video.addEventListener('error', () => reject(new Error('seek error')), { once: true });
    });
  }

  private findSampleIndex(targetUs: number): number {
    const samples = this.samples;
    if (samples.length === 0) return -1;
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].timestamp < targetUs) lo = mid + 1;
      else hi = mid;
    }
    // Check if previous sample is closer
    if (lo > 0 && Math.abs(samples[lo - 1].timestamp - targetUs) < Math.abs(samples[lo].timestamp - targetUs)) {
      return lo - 1;
    }
    return lo;
  }

  private evictOldFrames(currentTimestamp: number): void {
    for (const [ts, frame] of this.decodedFrames) {
      if (ts < currentTimestamp - 200_000) { // older than 200ms
        frame.close();
        this.decodedFrames.delete(ts);
      }
    }
  }

  private clearFrameCache(): void {
    for (const frame of this.decodedFrames.values()) frame.close();
    this.decodedFrames.clear();
  }

  dispose(): void {
    this._disposed = true;
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
    this.clearFrameCache();
    this.samples = [];
    if (this.fallbackVideo) {
      this.fallbackVideo.src = '';
      this.fallbackVideo.load();
    }
    if (this.fallbackUrl) URL.revokeObjectURL(this.fallbackUrl);
  }
}

// ── ExportDecoderPool ─────────────────────────────────────────────────────────

export class ExportDecoderPool {
  private pool = new Map<string, ExportDecoder>();

  get(clipId: string): ExportDecoder | undefined {
    return this.pool.get(clipId);
  }

  getOrCreate(clipId: string, file: File): ExportDecoder {
    let decoder = this.pool.get(clipId);
    if (!decoder) {
      decoder = new ExportDecoder(file);
      this.pool.set(clipId, decoder);
    }
    return decoder;
  }

  disposeAll(): void {
    for (const decoder of this.pool.values()) decoder.dispose();
    this.pool.clear();
  }
}
