import type { FileData } from "./FormatHandler.ts";
import { extractAudioAsWav } from "./video-editor.ts";

// ── Whisper STT via Web Worker ──────────────────────────────────────────────
let whisperWorker: Worker | null = null;
let loadedModelKey: string | null = null;

function createWhisperWorker() {
  if (whisperWorker) return;
  whisperWorker = new Worker(
    new URL('./whisper-worker.ts', import.meta.url),
    { type: 'module' }
  );
}

function whisperRequest(
  msg: any,
  transfer: Transferable[] | undefined,
  onProgress?: (stage: string, pct: number) => void,
): Promise<any> {
  return new Promise((resolve, reject) => {
    whisperWorker!.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (data.type === 'progress') onProgress?.(data.msg, data.pct);
      else if (data.type === 'loaded') resolve(data);
      else if (data.type === 'result') resolve(data);
      else if (data.type === 'error') reject(new Error(data.message));
    };
    whisperWorker!.postMessage(msg, transfer || []);
  });
}

/**
 * Check if any Whisper model has been loaded into memory.
 */
export function isWhisperLoaded(): boolean {
  return loadedModelKey !== null;
}

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 */
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

export interface GenerateSubtitleOptions {
  language?: string;
  model?: "base" | "small" | "medium" | "large-v3-turbo";
}

/**
 * Generate subtitles from a video file using Whisper AI.
 * Returns an SRT file as FileData.
 */
export async function generateSubtitles(
  file: File,
  onProgress?: (stage: string, pct: number) => void,
  options?: GenerateSubtitleOptions,
): Promise<FileData> {
  const modelKey = options?.model || "large-v3-turbo";
  const language = options?.language || undefined;

  // Step 1: Extract audio as WAV (16kHz mono)
  onProgress?.("Extracting audio...", 5);
  const wavBytes = await extractAudioAsWav(file);

  // Step 2: Load Whisper model in worker (lazy, cached per model key)
  createWhisperWorker();
  await whisperRequest({ type: 'load', modelKey }, undefined, onProgress);
  loadedModelKey = modelKey;

  // Step 3: Convert WAV bytes to Float32Array for Whisper
  // WAV format: 44 byte header, then PCM data (16-bit LE)
  const audioData = new Float32Array((wavBytes.length - 44) / 2);
  const dataView = new DataView(wavBytes.buffer, wavBytes.byteOffset + 44);
  for (let i = 0; i < audioData.length; i++) {
    audioData[i] = dataView.getInt16(i * 2, true) / 32768;
  }

  // Step 4: Transcribe in worker (transfer buffer for zero-copy)
  const result = await whisperRequest(
    { type: 'transcribe', modelKey, audioData, options: { language } },
    [audioData.buffer],
    onProgress,
  );

  // Step 5: Format output as SRT
  onProgress?.("Formatting subtitles...", 90);

  const chunks: Array<{ text: string; timestamp: [number, number | null] }> =
    result.chunks || [];

  if (chunks.length === 0 && result.text) {
    chunks.push({ text: result.text.trim(), timestamp: [0, null] });
  }

  let srt = "";
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const start = chunk.timestamp[0] ?? 0;
    const end = chunk.timestamp[1] ?? (chunks[i + 1]?.timestamp[0] ?? start + 5);
    const text = chunk.text.trim();
    if (!text) continue;

    srt += `${i + 1}\n`;
    srt += `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n`;
    srt += `${text}\n\n`;
  }

  if (!srt.trim()) {
    srt = "1\n00:00:00,000 --> 00:00:05,000\n(No speech detected)\n\n";
  }

  onProgress?.("Done!", 100);

  const baseName = file.name.replace(/\.[^.]+$/, "");
  const encoder = new TextEncoder();
  return {
    name: `${baseName}_subtitles.srt`,
    bytes: encoder.encode(srt),
  };
}
