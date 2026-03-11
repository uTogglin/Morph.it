// ── Exporter ──────────────────────────────────────────────────────────────────
// Renders the full timeline to a WebM file using WebCodecs VideoEncoder +
// AudioEncoder, composited through EffectChain and mixed via OfflineAudioContext.
//
// Strategy:
//   1. Video: Create a fresh EffectChain + ClipDecoderPool (independent of live
//      preview). Encode each frame VP9/VP8 via VideoEncoder.
//   2. Audio: Render the entire audio mix to a PCM AudioBuffer via
//      OfflineAudioContext (no real-time playback required). Encode to Opus
//      via AudioEncoder.
//   3. Mux: Interleave video + audio SimpleBlocks into WebM clusters.
//
// Output: video/webm  (VP9+Opus or VP8+Opus; video-only if audio fails or
//         AudioEncoder is unavailable).
//
// Requires WebCodecs (Chrome 94+, Edge 94+, Safari 16.4+).

import type { Project, Clip } from './types.ts';
import { clipActiveAt, clipSourceTime, adjustmentClipActiveAt } from './types.ts';
import { EffectChain } from './EffectChain.ts';
import { ClipDecoderPool, ClipDecoder } from './ClipDecoder.ts';
import { evaluateEffectParam } from './KeyframeEngine.ts';
import { TextRenderer } from './TextRenderer.ts';
import { textClipActiveAt } from './TextClip.ts';

export interface ExportOptions {
  /** Target bitrate in bits/s. Default: width * height * fps * 0.07 */
  bitrate?: number;
  /** Called each rendered frame with 0–1 progress. */
  onProgress?: (progress: number) => void;
  /** AbortSignal — reject and clean up if aborted. */
  signal?: AbortSignal;
  /** Called when EffectChain encounters a GPU limitation during export. */
  onWarning?: (msg: string) => void;
}

export interface ExportResult {
  blob:     Blob;
  mimeType: string;
  filename: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export class Exporter {
  /**
   * Render the project to a WebM video (+ audio when available).
   * Creates and tears down its own EffectChain + ClipDecoderPool so the
   * live preview is unaffected.
   */
  static async export(project: Project, opts: ExportOptions = {}): Promise<ExportResult> {
    const { onProgress, signal, onWarning } = opts;

    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs VideoEncoder is not available in this browser.');
    }

    const { width, height, frameRate, duration, sampleRate } = project;
    if (duration <= 0) throw new Error('Project has no content to export.');

    const bitrate = opts.bitrate ?? Math.round(width * height * frameRate * 0.07);
    const { codec, codecId } = await pickVideoCodec(width, height, bitrate);

    const totalFrames   = Math.ceil(duration * frameRate);
    const frameDuration = 1_000_000 / frameRate; // microseconds per frame

    const effectChain  = new EffectChain(width, height, onWarning);
    const decoders     = new ClipDecoderPool();
    const textRenderer = new TextRenderer(width, height);

    // Pre-seed decoders for all video clips
    for (const track of project.tracks.filter(t => t.kind === 'video')) {
      for (const clip of track.clips) decoders.getOrCreate(clip.id, clip.sourceFile);
    }

    // Wait for all decoders to be ready
    const readyAll = project.tracks
      .filter(t => t.kind === 'video')
      .flatMap(t => t.clips.map(c => decoders.get(c.id)!.ready));
    await Promise.all(readyAll);

    const videoChunks: EncodedVideoChunk[] = [];
    // Capture encoder errors so we can re-throw after flush rather than throwing
    // into the encoder's dead async stack (which produces an unhandled rejection).
    let encodeError: unknown = null;

    const encoder = await createConfiguredEncoder(
      (chunk) => videoChunks.push(chunk),
      (e) => { encodeError = e; },
      { codec, width, height, bitrate, framerate: frameRate },
    );

    // Start audio mix early — it runs on a separate OfflineAudioContext and
    // can execute in parallel with the video encoding loop.
    const audioMixPromise = renderAudioMix(project, signal).catch(e => {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      console.warn('[Exporter] Audio mix failed, falling back to video-only:', e);
      return null;
    });

    const offscreen = new OffscreenCanvas(width, height);
    const ctx2d     = offscreen.getContext('2d')!;

    try {
      for (let i = 0; i < totalFrames; i++) {
        if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');

        const t           = i / frameRate;
        const timestampUs = Math.round(i * frameDuration);

        ctx2d.clearRect(0, 0, width, height);

        // Collect active clips across all video tracks (preserving draw order)
        const activeClips: { clip: Clip; decoder: ClipDecoder; srcTime: number }[] = [];
        for (const track of project.tracks.filter(tr => tr.kind === 'video')) {
          if (track.muted) continue;
          for (const clip of track.clips) {
            if (!clipActiveAt(clip, t)) continue;
            const decoder = decoders.get(clip.id);
            if (decoder) activeClips.push({ clip, decoder, srcTime: clipSourceTime(clip, t) });
          }
        }

        // Decode all active clips in parallel — this is the main speedup since
        // seekTo() waits on the hardware decoder (~16-50ms per call).
        const decoded = await Promise.all(
          activeClips.map(async ({ clip, decoder, srcTime }) => {
            try {
              const frame = await decoder.seekTo(srcTime);
              return { clip, frame, srcTime };
            } catch { return null; }
          }),
        );

        // Process effects and composite in track order (must be serial for
        // correct layer ordering, but decoding already happened in parallel).
        for (const entry of decoded) {
          if (!entry) continue;
          const { clip, frame, srcTime } = entry;
          try {
            const clipRelT = srcTime - clip.sourceStart;
            const interpolatedEffects = clip.effects.map(e =>
              clip.keyframeTracks.some(kt => kt.property.startsWith(e.id + '.'))
                ? { ...e, params: evaluateEffectParam(e, clip, clipRelT) }
                : e
            );
            const bitmap = await effectChain.process(frame, interpolatedEffects);
            ctx2d.drawImage(bitmap, 0, 0, width, height);
            bitmap.close();
          } finally {
            frame.close();
          }
        }

        // Phase 2 — apply adjustment layer effects to the composited video result
        const adjTracks = project.tracks.filter(tr => tr.kind === 'adjustment' && !tr.muted);
        if (adjTracks.length > 0) {
          // Snapshot the OffscreenCanvas composite as an ImageBitmap
          let compositeBitmap = offscreen.transferToImageBitmap();

          for (const adjTrack of adjTracks) {
            for (const adjClip of adjTrack.adjustmentClips ?? []) {
              if (!adjustmentClipActiveAt(adjClip, t)) continue;
              const adjClipRelT = t - adjClip.timelineStart;
              const interpolatedEffects = adjClip.effects.map(e =>
                adjClip.keyframeTracks.some(kt => kt.property.startsWith(e.id + '.'))
                  ? { ...e, params: evaluateEffectParam(e, { keyframeTracks: adjClip.keyframeTracks } as Clip, adjClipRelT) }
                  : e
              );
              try {
                const result = await effectChain.process(compositeBitmap, interpolatedEffects);
                compositeBitmap.close();
                compositeBitmap = result;
              } catch { /* skip adjustment clip on error */ }
            }
          }

          // Draw the adjusted result back to the OffscreenCanvas for encoding
          ctx2d.clearRect(0, 0, width, height);
          ctx2d.drawImage(compositeBitmap, 0, 0, width, height);
          compositeBitmap.close();
        }

        // Phase 3: Text overlays — final compositing pass (on top of everything)
        const textTracks = project.tracks.filter(tr => tr.kind === 'text' && !tr.muted);
        for (const track of textTracks) {
          for (const textClip of track.textClips ?? []) {
            if (!textClipActiveAt(textClip, t)) continue;
            const clipRelT = t - textClip.timelineStart;
            const bitmap = textRenderer.render(textClip, clipRelT);
            ctx2d.drawImage(bitmap, 0, 0);
            bitmap.close();
          }
        }

        const frameForEncoder = new VideoFrame(offscreen, {
          timestamp:    timestampUs,
          duration:     Math.round(frameDuration),
          displayWidth:  width,
          displayHeight: height,
        });

        // Guard: if encoder errored/closed asynchronously, stop immediately
        if (encoder.state !== 'configured') {
          frameForEncoder.close();
          if (encodeError) throw encodeError;
          throw new Error('VideoEncoder entered unexpected state: ' + encoder.state);
        }

        const keyframe = i % (frameRate * 2) === 0;
        encoder.encode(frameForEncoder, { keyFrame: keyframe });
        frameForEncoder.close();

        // Backpressure: if the encoder queue is building up (slow hardware encoder),
        // wait for a dequeue event before submitting more frames to avoid a
        // QuotaExceededError which would otherwise go to the error callback.
        if (encoder.encodeQueueSize > 10) {
          await new Promise<void>(r => encoder.addEventListener('dequeue', () => r(), { once: true }));
          // Re-check after waiting — encoder may have errored during backpressure wait
          if (encoder.state !== 'configured') {
            if (encodeError) throw encodeError;
            throw new Error('VideoEncoder closed during backpressure wait');
          }
        }

        // Video encoding is ~80 % of the total work budget
        onProgress?.((i + 1) / totalFrames * 0.8);

        if (i % 60 === 0) await yieldToMain();
      }

      await encoder.flush();
      if (encodeError) throw encodeError;
    } finally {
      if (encoder.state !== 'closed') encoder.close();
      effectChain.dispose();
      decoders.disposeAll();
    }

    if (videoChunks.length === 0) throw new Error('Encoder produced no output chunks.');

    // ── Audio mix + encode (mix already started in parallel) ─────────────────
    let audioChunks: EncodedAudioChunk[] | null = null;
    try {
      onProgress?.(0.82);
      const audioBuffer = await audioMixPromise;
      if (audioBuffer) {
        onProgress?.(0.88);
        audioChunks = await encodeOpus(audioBuffer, sampleRate, signal);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      console.warn('[Exporter] Audio skipped:', e);
      audioChunks = null;
    }

    onProgress?.(1.0);

    const webmBlob = muxWebM(
      videoChunks, audioChunks, codecId,
      width, height, frameRate, duration, sampleRate,
    );
    const filename = sanitizeFilename(project.name) + '.webm';

    return { blob: webmBlob, mimeType: 'video/webm', filename };
  }
}

// ── Codec selection ───────────────────────────────────────────────────────────

async function pickVideoCodec(
  width: number, height: number, bitrate: number,
): Promise<{ codec: string; codecId: string }> {
  const candidates: Array<{ codec: string; codecId: string }> = [
    { codec: 'vp09.00.10.08', codecId: 'V_VP9' },
    { codec: 'vp8',           codecId: 'V_VP8' },
  ];
  for (const c of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate });
      if (r.supported) return c;
    } catch { /* try next */ }
  }
  throw new Error('No supported video encoder found (VP9 or VP8 required).');
}

// ── Encoder creation with hardware → software fallback ───────────────────────

async function createConfiguredEncoder(
  output: (chunk: EncodedVideoChunk) => void,
  error: (e: DOMException) => void,
  config: { codec: string; width: number; height: number; bitrate: number; framerate: number },
): Promise<VideoEncoder> {
  // Try hardware acceleration first, then fall back to software.
  // Some systems report codec support via isConfigSupported but fail to
  // instantiate the platform encoder, producing "Encoder creation error".
  const accelerationModes: HardwareAcceleration[] = ['prefer-hardware', 'prefer-software'];

  for (const hw of accelerationModes) {
    const encoder = new VideoEncoder({ output, error });
    const fullConfig: VideoEncoderConfig = {
      ...config,
      hardwareAcceleration: hw,
      latencyMode: 'quality',
    };
    try {
      encoder.configure(fullConfig);
      // configure() is async internally — yield to let the error callback fire
      // if the platform encoder can't be created.
      await new Promise(r => setTimeout(r, 0));
      if (encoder.state === 'configured') return encoder;
      // Encoder moved to 'closed' — clean up and try next mode
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      if (encoder.state !== 'closed') encoder.close();
    }
  }

  throw new Error(
    'Failed to create video encoder. Your browser may not support encoding at this resolution.',
  );
}

// ── Audio mix (OfflineAudioContext) ───────────────────────────────────────────

async function renderAudioMix(
  project: Project,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const audioTracks = project.tracks.filter(t => t.kind === 'audio' && !t.muted);
  if (!audioTracks.some(t => t.clips.length > 0)) return null;

  const { sampleRate, duration } = project;
  const numFrames = Math.ceil(duration * sampleRate);
  const offCtx    = new OfflineAudioContext(2, numFrames, sampleRate);
  const master    = offCtx.createGain();
  master.connect(offCtx.destination);

  // Apply solo logic: if any track is soloed, only soloed tracks are audible
  const hasSolo = audioTracks.some(t => t.solo);

  for (const track of audioTracks) {
    if (hasSolo && !track.solo) continue;

    const trackGain = offCtx.createGain();
    trackGain.gain.value = track.volume;

    const panner = offCtx.createStereoPanner();
    panner.pan.value = track.pan;

    trackGain.connect(panner);
    panner.connect(master);

    for (const clip of track.clips) {
      if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');

      let arrayBuf: ArrayBuffer;
      try { arrayBuf = await clip.sourceFile.arrayBuffer(); }
      catch { continue; }

      let audioBuf: AudioBuffer;
      try { audioBuf = await offCtx.decodeAudioData(arrayBuf); }
      catch { continue; }

      const source = offCtx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(trackGain);

      const srcDuration = clip.sourceEnd - clip.sourceStart;
      source.start(clip.timelineStart, clip.sourceStart, srcDuration);
    }
  }

  return offCtx.startRendering();
}

// ── Opus encoding (AudioEncoder) ──────────────────────────────────────────────

async function encodeOpus(
  audioBuffer: AudioBuffer,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<EncodedAudioChunk[]> {
  if (typeof AudioEncoder === 'undefined') {
    throw new Error('AudioEncoder is not available in this browser.');
  }

  const config = { codec: 'opus' as const, sampleRate, numberOfChannels: 2, bitrate: 128_000 };
  const support = await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) throw new Error('Opus AudioEncoder not supported.');

  const chunks: EncodedAudioChunk[] = [];
  let audioEncodeError: unknown = null;
  const enc = new AudioEncoder({
    output: (chunk) => chunks.push(chunk),
    error:  (e) => { audioEncodeError = e; },
  });
  enc.configure(config);

  const FRAME_SIZE   = 960; // 20 ms at 48 kHz
  const totalSamples = audioBuffer.length;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  for (let offset = 0; offset < totalSamples; offset += FRAME_SIZE) {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');

    const frameCount  = Math.min(FRAME_SIZE, totalSamples - offset);
    const timestampUs = Math.round(offset / sampleRate * 1_000_000);

    // f32-planar layout: all ch0 samples then all ch1 samples
    const planar = new Float32Array(frameCount * 2);
    planar.set(ch0.subarray(offset, offset + frameCount), 0);
    planar.set(ch1.subarray(offset, offset + frameCount), frameCount);

    const audioData = new AudioData({
      format:           'f32-planar',
      sampleRate,
      numberOfFrames:   frameCount,
      numberOfChannels: 2,
      timestamp:        timestampUs,
      data:             planar,
    });
    enc.encode(audioData);
    audioData.close();
  }

  await enc.flush();
  enc.close();
  if (audioEncodeError) throw audioEncodeError;
  return chunks;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function yieldToMain(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'export';
}

// ── Minimal WebM muxer ────────────────────────────────────────────────────────
// Implements the minimum EBML/Matroska structure for a valid video/webm file
// with optional interleaved Opus audio.

function muxWebM(
  videoChunks: EncodedVideoChunk[],
  audioChunks: EncodedAudioChunk[] | null,
  videoCodecId: string,
  width:     number,
  height:    number,
  frameRate: number,
  duration:  number,
  sampleRate: number,
): Blob {
  // ── EBML primitives ──────────────────────────────────────────────────────────

  function u8(arr: number[]): Uint8Array { return new Uint8Array(arr); }

  function concat(parts: (Uint8Array | number[])[]): Uint8Array {
    const arrays = parts.map(p => p instanceof Uint8Array ? p : new Uint8Array(p));
    const total  = arrays.reduce((s, a) => s + a.length, 0);
    const out    = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  function vint(n: number): Uint8Array {
    if (n < 0x7e) return u8([0x80 | n]);
    if (n < 0x3ffe) return u8([0x40 | (n >> 8), n & 0xff]);
    if (n < 0x1ffffe) return u8([0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
    if (n < 0x0ffffffe) return u8([0x10 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    return u8([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  }

  const UNKNOWN_SIZE = u8([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  function el(id: number[], data: Uint8Array): Uint8Array {
    return concat([id, vint(data.length), data]);
  }

  function elUnknown(id: number[], data: Uint8Array): Uint8Array {
    return concat([id, UNKNOWN_SIZE, data]);
  }

  function uint(n: number, bytes: number): Uint8Array {
    const a = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) { a[i] = n & 0xff; n >>>= 8; }
    return a;
  }

  function uintLE(n: number, bytes: number): Uint8Array {
    const a = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) { a[i] = n & 0xff; n >>>= 8; }
    return a;
  }

  function float64(n: number): Uint8Array {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    return new Uint8Array(buf);
  }

  function str(s: string): Uint8Array { return new TextEncoder().encode(s); }

  // ── EBML Header ──────────────────────────────────────────────────────────────
  const ebmlHeader = el([0x1A, 0x45, 0xDF, 0xA3], concat([
    el([0x42, 0x86], uint(1, 1)),
    el([0x42, 0xF7], uint(1, 1)),
    el([0x42, 0xF2], uint(4, 1)),
    el([0x42, 0xF3], uint(8, 1)),
    el([0x42, 0x82], str('webm')),
    el([0x42, 0x87], uint(4, 1)),
    el([0x42, 0x85], uint(2, 1)),
  ]));

  // ── Segment Info ─────────────────────────────────────────────────────────────
  const info = el([0x15, 0x49, 0xA9, 0x66], concat([
    el([0x2A, 0xD7, 0xB1], uint(1_000_000, 4)),
    el([0x44, 0x89], float64(duration * 1000)),
    el([0x4D, 0x80], str('morphit-exporter')),
    el([0x57, 0x41], str('morphit-exporter')),
  ]));

  // ── Video TrackEntry ─────────────────────────────────────────────────────────
  const videoTrackEntry = el([0xAE], concat([
    el([0xD7], uint(1, 1)),
    el([0x73, 0xC5], uint(1, 8)),
    el([0x83], uint(1, 1)),
    el([0x9C], uint(0, 1)),
    el([0x86], str(videoCodecId)),
    el([0xE0], concat([
      el([0xB0], uint(width,  2)),
      el([0xBA], uint(height, 2)),
      el([0x23, 0x83, 0xE3], uint(Math.round(frameRate * 1000), 3)),
    ])),
  ]));

  // ── Audio TrackEntry (Opus) ──────────────────────────────────────────────────
  const hasAudio = audioChunks !== null && audioChunks.length > 0;

  // OpusHead: magic(8) + ver(1) + channels(1) + pre-skip(2 LE) +
  //           sampleRate(4 LE) + outputGain(2 LE) + mappingFamily(1) = 19 bytes
  const opusHead = new Uint8Array(19);
  opusHead.set(str('OpusHead'), 0);
  opusHead[8]  = 1;
  opusHead[9]  = 2;
  opusHead.set(uintLE(312,        2), 10);
  opusHead.set(uintLE(sampleRate, 4), 12);
  opusHead.set(uintLE(0,          2), 16);
  opusHead[18] = 0;

  const audioTrackEntry = el([0xAE], concat([
    el([0xD7], uint(2, 1)),
    el([0x73, 0xC5], uint(2, 8)),
    el([0x83], uint(2, 1)),
    el([0x9C], uint(0, 1)),
    el([0x86], str('A_OPUS')),
    el([0x63, 0xA2], opusHead),
    el([0x56, 0xAA], uint(6_500_000, 4)),   // CodecDelay in nanoseconds
    el([0x56, 0xBB], uint(80_000_000, 4)),  // SeekPreRoll in nanoseconds
    el([0xE1], concat([
      el([0xB5], float64(sampleRate)),
      el([0x9F], uint(2, 1)),
    ])),
  ]));

  const tracks = el([0x16, 0x54, 0xAE, 0x6B],
    hasAudio ? concat([videoTrackEntry, audioTrackEntry]) : videoTrackEntry,
  );

  // ── Interleave video + audio blocks by timestamp ──────────────────────────
  type MediaBlock = { ms: number; isKey: boolean; trackVint: number; data: Uint8Array };

  function toBlocks(
    chunks: EncodedVideoChunk[] | EncodedAudioChunk[],
    trackVint: number,
  ): MediaBlock[] {
    return (chunks as EncodedVideoChunk[]).map(chunk => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      return { ms: Math.round(chunk.timestamp / 1000), isKey: chunk.type === 'key', trackVint, data };
    });
  }

  let allBlocks: MediaBlock[] = toBlocks(videoChunks, 0x81);
  if (hasAudio) {
    const audioBs = toBlocks(audioChunks!, 0x82);
    // Merge two already-sorted arrays
    const merged: MediaBlock[] = [];
    let vi = 0, ai = 0;
    while (vi < allBlocks.length || ai < audioBs.length) {
      const vt = vi < allBlocks.length ? allBlocks[vi].ms : Infinity;
      const at = ai < audioBs.length   ? audioBs[ai].ms  : Infinity;
      merged.push(vt <= at ? allBlocks[vi++] : audioBs[ai++]);
    }
    allBlocks = merged;
  }

  // ── Build clusters ────────────────────────────────────────────────────────
  const CLUSTER_DURATION_MS = 5000;
  const clusterParts: Uint8Array[] = [];
  let clusterStartMs = -1;
  let clusterBlocks:  Uint8Array[] = [];

  function flushCluster(): void {
    if (clusterBlocks.length === 0) return;
    const body = concat([
      el([0xE7], uint(Math.max(0, clusterStartMs), 4)),
      ...clusterBlocks,
    ]);
    clusterParts.push(elUnknown([0x1F, 0x43, 0xB6, 0x75], body));
    clusterBlocks = [];
    clusterStartMs = -1;
  }

  for (const { ms, isKey, trackVint, data } of allBlocks) {
    // New cluster at start, or at a video keyframe after CLUSTER_DURATION_MS
    if (clusterStartMs < 0 ||
        (trackVint === 0x81 && isKey && ms - clusterStartMs >= CLUSTER_DURATION_MS)) {
      flushCluster();
      clusterStartMs = ms;
    }

    let relMs = ms - clusterStartMs;
    if (relMs > 32767 || relMs < 0) {
      flushCluster();
      clusterStartMs = ms;
      relMs = 0;
    }

    const flags  = (trackVint === 0x81 && isKey) ? 0x80 : 0x00;
    const header = u8([trackVint, (relMs >> 8) & 0xff, relMs & 0xff, flags]);
    clusterBlocks.push(el([0xA3], concat([header, data])));
  }
  flushCluster();

  // ── Assemble ─────────────────────────────────────────────────────────────────
  const segmentBody = concat([info, tracks, ...clusterParts]);
  const segment     = elUnknown([0x18, 0x53, 0x80, 0x67], segmentBody);
  return new Blob([concat([ebmlHeader, segment]) as unknown as BlobPart], { type: 'video/webm' });
}
