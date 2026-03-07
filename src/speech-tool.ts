import { FFmpeg } from "@ffmpeg/ffmpeg";
import { cdnUrl } from "./cdn.ts";
import {
  PLAY_SVG, PAUSE_SVG,
  formatTime, buildWordSpans, buildTimings,
  updateWordHighlight, buildSentenceTimings,
  type WordTiming, type SentenceTiming, type HighlightState,
} from "./utils/tts-player.ts";

// ── FFmpeg instance for WAV→MP3 ────────────────────────────────────────────
let speechFFmpeg: FFmpeg | null = null;
let speechFFmpegReady: Promise<void> | null = null;

async function getSpeechFFmpeg(): Promise<FFmpeg> {
  if (!speechFFmpeg) speechFFmpeg = new FFmpeg();
  if (!speechFFmpegReady) speechFFmpegReady = speechFFmpeg.load({ coreURL: await cdnUrl("ffmpegCore") }).then(() => {});
  await speechFFmpegReady;
  return speechFFmpeg;
}

// ── Kokoro TTS via Web Worker ───────────────────────────────────────────────
let kokoroWorker: Worker | null = null;
let kokoroReady = false;
let kokoroInitPromise: Promise<void> | null = null;
let kokoroInitResolve: (() => void) | null = null;
let kokoroInitReject: ((e: Error) => void) | null = null;
let kokoroProgressCb: ((pct: number, msg: string) => void) | null = null;
let kokoroGenId = 0;
const pendingGens = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

function createKokoroWorker() {
  if (kokoroWorker) return;
  kokoroWorker = new Worker(
    new URL('./kokoro-worker.ts', import.meta.url),
    { type: 'module' }
  );
  kokoroWorker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    switch (msg.type) {
      case 'progress':
        kokoroProgressCb?.(msg.pct, msg.msg);
        break;
      case 'ready':
        kokoroReady = true;
        kokoroInitResolve?.();
        kokoroInitResolve = null;
        kokoroInitReject = null;
        break;
      case 'result': {
        const p = pendingGens.get(msg.id);
        if (p) { pendingGens.delete(msg.id); p.resolve({ data: msg.audio, sampling_rate: msg.sampleRate }); }
        break;
      }
      case 'error': {
        if (msg.id != null) {
          const p = pendingGens.get(msg.id);
          if (p) { pendingGens.delete(msg.id); p.reject(new Error(msg.message)); }
        } else {
          kokoroInitPromise = null;
          kokoroInitReject?.(new Error(msg.message));
          kokoroInitResolve = null;
          kokoroInitReject = null;
        }
        break;
      }
    }
  };
}

const kokoroProxy = {
  generate(text: string, opts: { voice: string; speed: number }): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++kokoroGenId;
      pendingGens.set(id, { resolve, reject });
      kokoroWorker!.postMessage({ type: 'generate', id, text, voice: opts.voice, speed: opts.speed });
    });
  }
};

export async function getKokoro(onProgress?: (pct: number, msg: string) => void): Promise<any> {
  if (kokoroReady) return kokoroProxy;
  if (kokoroInitPromise) { await kokoroInitPromise; return kokoroProxy; }

  createKokoroWorker();
  kokoroProgressCb = onProgress ?? null;

  kokoroInitPromise = new Promise<void>((resolve, reject) => {
    kokoroInitResolve = resolve;
    kokoroInitReject = reject;
  });

  const aiDevice = (() => { try { return localStorage.getItem("convert-ai-device") ?? "auto"; } catch { return "auto"; } })();
  kokoroWorker!.postMessage({ type: 'init', forceDevice: aiDevice === "wasm" ? "wasm" : undefined });

  try {
    await kokoroInitPromise;
  } catch (err) {
    kokoroInitPromise = null;
    throw err;
  }
  return kokoroProxy;
}

// ── Spoken-weight: estimate how long TTS takes to say a word ────────────────
// CJK characters are single chars but full syllables; digits expand to words;
// punctuation is near-silent; Latin length roughly maps to duration.
function isCJK(code: number): boolean {
  return (code >= 0x4E00 && code <= 0x9FFF)   // CJK Unified Ideographs
      || (code >= 0x3400 && code <= 0x4DBF)   // CJK Extension A
      || (code >= 0x3040 && code <= 0x309F)   // Hiragana
      || (code >= 0x30A0 && code <= 0x30FF)   // Katakana
      || (code >= 0xAC00 && code <= 0xD7AF);  // Hangul Syllables
}

// Average spoken syllable counts for digit words (0-9)
const DIGIT_WEIGHTS: Record<string, number> = {
  "0": 4, "1": 3, "2": 3, "3": 5, "4": 4,
  "5": 4, "6": 5, "7": 5, "8": 3, "9": 4,
};

export function spokenWeight(word: string): number {
  let w = 0;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const code = word.charCodeAt(i);
    if (isCJK(code)) {
      w += 4; // each CJK char ≈ a full syllable spoken aloud
    } else if (ch >= "0" && ch <= "9") {
      w += DIGIT_WEIGHTS[ch] || 4; // digit spoken as word
    } else if (/[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0900-\u097F]/.test(ch)) {
      w += 1; // Latin, Cyrillic, Arabic, Devanagari letters
    } else {
      w += 0.3; // punctuation, symbols — small pause
    }
  }
  return Math.max(w, 2);
}

// ── WAV encoder for concatenated Float32Array chunks ───────────────────────
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Write PCM samples (float → 16-bit int)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Init ───────────────────────────────────────────────────────────────────
export function initSpeechTool() {
  // DOM refs
  const tabs = document.querySelectorAll<HTMLButtonElement>(".speech-tab");
  const ttsPanel = document.getElementById("speech-tts-panel") as HTMLDivElement;
  const sttPanel = document.getElementById("speech-stt-panel") as HTMLDivElement;

  // TTS refs
  const ttsInput = document.getElementById("speech-tts-input") as HTMLTextAreaElement;
  const ttsVoice = document.getElementById("speech-tts-voice") as HTMLSelectElement;
  const ttsSpeed = document.getElementById("speech-tts-speed") as HTMLInputElement;
  const ttsSpeedLabel = document.getElementById("speech-tts-speed-label") as HTMLSpanElement;
  const generateBtn = document.getElementById("speech-tts-generate") as HTMLButtonElement;
  const ttsProgress = document.getElementById("speech-tts-progress") as HTMLDivElement;
  const ttsProgressFill = ttsProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const ttsProgressText = ttsProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const freezeWarning = ttsProgress.querySelector(".speech-freeze-warning") as HTMLParagraphElement;

  // Player refs (now in fullscreen overlay)
  const player = document.getElementById("speech-player") as HTMLDivElement;
  const ttsOverlay = document.getElementById("speech-tts-overlay") as HTMLDivElement;
  const ttsBackBtn = document.getElementById("speech-tts-back") as HTMLButtonElement;
  const ttsSentenceEl = document.getElementById("speech-tts-sentence") as HTMLDivElement;
  const wordDisplay = document.getElementById("speech-word-display") as HTMLDivElement;
  const audio = document.getElementById("speech-audio") as HTMLAudioElement;
  const playBtn = document.getElementById("speech-play-btn") as HTMLButtonElement;
  const skipBack = document.getElementById("speech-skip-back") as HTMLButtonElement;
  const skipForward = document.getElementById("speech-skip-forward") as HTMLButtonElement;
  const seekBar = document.getElementById("speech-seek-bar") as HTMLDivElement;
  const seekFill = document.getElementById("speech-seek-fill") as HTMLDivElement;
  const seekThumb = document.getElementById("speech-seek-thumb") as HTMLDivElement;
  const timeCurrent = document.getElementById("speech-time-current") as HTMLSpanElement;
  const timeDuration = document.getElementById("speech-time-duration") as HTMLSpanElement;
  const speedDisplay = document.getElementById("speech-tts-speed-display") as HTMLSpanElement | null;
  const downloadBtn = document.getElementById("speech-download-mp3") as HTMLButtonElement;

  // STT refs
  const sttModes = document.querySelectorAll<HTMLButtonElement>(".speech-stt-mode");
  const sttMicContent = document.getElementById("speech-stt-mic") as HTMLDivElement;
  const sttFileContent = document.getElementById("speech-stt-file") as HTMLDivElement;
  const sttLang = document.getElementById("speech-stt-lang") as HTMLSelectElement;
  const sttMicModel = document.getElementById("speech-stt-mic-model") as HTMLSelectElement;
  const recordBtn = document.getElementById("speech-stt-record") as HTMLButtonElement;
  const micProgress = document.getElementById("speech-stt-mic-progress") as HTMLDivElement;
  const micProgressFill = micProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const micProgressText = micProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const micFreezeWarning = micProgress.querySelector(".speech-freeze-warning") as HTMLParagraphElement;
  const sttFileLang = document.getElementById("speech-stt-file-lang") as HTMLSelectElement;
  const sttFileModel = document.getElementById("speech-stt-file-model") as HTMLSelectElement;
  const fileDrop = document.getElementById("speech-file-drop") as HTMLDivElement;
  const fileInput = document.getElementById("speech-file-input") as HTMLInputElement;
  const fileName = document.getElementById("speech-stt-file-name") as HTMLSpanElement;
  const transcribeBtn = document.getElementById("speech-stt-transcribe") as HTMLButtonElement;
  const sttProgress = document.getElementById("speech-stt-progress") as HTMLDivElement;
  const sttProgressFill = sttProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const sttProgressText = sttProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const sttFreezeWarning = sttProgress.querySelector(".speech-freeze-warning") as HTMLParagraphElement;
  const sttOutput = document.getElementById("speech-stt-output") as HTMLDivElement;
  const sttResult = document.getElementById("speech-stt-result") as HTMLTextAreaElement;
  const sttCopy = document.getElementById("speech-stt-copy") as HTMLButtonElement;

  // ── Apply saved defaults from settings panel ───────────────────────────
  try {
    const savedVoice = localStorage.getItem("convert-tts-voice");
    if (savedVoice) ttsVoice.value = savedVoice;

    const savedSpeed = localStorage.getItem("convert-tts-speed");
    if (savedSpeed) {
      ttsSpeed.value = savedSpeed;
      const label = `${parseFloat(savedSpeed).toFixed(1)}x`;
      ttsSpeedLabel.textContent = label;
      if (speedDisplay) speedDisplay.textContent = label;
    }

    const savedModel = localStorage.getItem("convert-stt-model");
    if (savedModel) {
      sttMicModel.value = savedModel;
      sttFileModel.value = savedModel;
    }

    const savedLang = localStorage.getItem("convert-stt-language");
    if (savedLang !== null) {
      sttLang.value = savedLang;
      sttFileLang.value = savedLang;
    }
  } catch {}

  // ── Sync speech tool changes back to localStorage (& settings panel) ──
  ttsVoice.addEventListener("change", () => {
    try { localStorage.setItem("convert-tts-voice", ttsVoice.value); } catch {}
    const smVoice = document.getElementById("sm-tts-voice") as HTMLSelectElement | null;
    if (smVoice) smVoice.value = ttsVoice.value;
  });
  ttsSpeed.addEventListener("input", () => {
    try { localStorage.setItem("convert-tts-speed", ttsSpeed.value); } catch {}
    const smSpeed = document.getElementById("sm-tts-speed") as HTMLInputElement | null;
    const smLabel = document.getElementById("sm-tts-speed-label") as HTMLSpanElement | null;
    if (smSpeed) smSpeed.value = ttsSpeed.value;
    if (smLabel) smLabel.textContent = `${parseFloat(ttsSpeed.value).toFixed(1)}x`;
  });

  function syncModelToStorage() {
    // Both mic and file model selects should stay in sync
    const val = sttMicModel.value;
    sttFileModel.value = val;
    try { localStorage.setItem("convert-stt-model", val); } catch {}
    const smModel = document.getElementById("sm-stt-model") as HTMLSelectElement | null;
    if (smModel) smModel.value = val;
  }
  function syncFileModelToStorage() {
    const val = sttFileModel.value;
    sttMicModel.value = val;
    try { localStorage.setItem("convert-stt-model", val); } catch {}
    const smModel = document.getElementById("sm-stt-model") as HTMLSelectElement | null;
    if (smModel) smModel.value = val;
  }
  sttMicModel.addEventListener("change", syncModelToStorage);
  sttFileModel.addEventListener("change", syncFileModelToStorage);

  function syncLangToStorage() {
    const val = sttLang.value;
    sttFileLang.value = val;
    try { localStorage.setItem("convert-stt-language", val); } catch {}
    const smLang = document.getElementById("sm-stt-language") as HTMLSelectElement | null;
    if (smLang) smLang.value = val;
  }
  function syncFileLangToStorage() {
    const val = sttFileLang.value;
    sttLang.value = val;
    try { localStorage.setItem("convert-stt-language", val); } catch {}
    const smLang = document.getElementById("sm-stt-language") as HTMLSelectElement | null;
    if (smLang) smLang.value = val;
  }
  sttLang.addEventListener("change", syncLangToStorage);
  sttFileLang.addEventListener("change", syncFileLangToStorage);

  // State
  let currentWavBlob: Blob | null = null;
  let currentAudioUrl: string | null = null;
  let wordTimings: WordTiming[] = [];
  let activeWordIdx = -1;
  let sttFile: File | null = null;
  let isRecording = false;

  // Sentence teleprompter state
  let sentenceTimings: SentenceTiming[] = [];
  let activeSentenceIdx = -1;
  let sentenceWordSpans: HTMLSpanElement[] = [];
  let sentenceActiveIdx = -1;

  // Set initial play icon
  playBtn.innerHTML = PLAY_SVG;

  function setPlayIcon(playing: boolean) {
    playBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  }

  // ── Tab switching ──────────────────────────────────────────────────────
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      ttsPanel.classList.toggle("active", which === "tts");
      sttPanel.classList.toggle("active", which === "stt");
    });
  }

  // ── STT mode switching ─────────────────────────────────────────────────
  for (const mode of sttModes) {
    mode.addEventListener("click", () => {
      sttModes.forEach(m => m.classList.remove("active"));
      mode.classList.add("active");
      const which = mode.dataset.mode;
      sttMicContent.classList.toggle("active", which === "mic");
      sttFileContent.classList.toggle("active", which === "file");
    });
  }

  // ── Speed slider ───────────────────────────────────────────────────────
  ttsSpeed.addEventListener("input", () => {
    const val = `${parseFloat(ttsSpeed.value).toFixed(1)}x`;
    ttsSpeedLabel.textContent = val;
    if (speedDisplay) speedDisplay.textContent = val;
  });

  // ── Highlight state for shared updateWordHighlight ─────────────────────
  const hlState: HighlightState = {
    wordTimings,
    activeWordIdx,
    wordDisplayEl: wordDisplay,
    sentenceTimings,
    activeSentenceIdx,
    sentenceEl: ttsSentenceEl,
    sentenceWordSpans,
    sentenceActiveIdx,
  };

  function doUpdateHighlight() {
    // Keep hlState refs in sync before calling
    hlState.wordTimings = wordTimings;
    hlState.activeWordIdx = activeWordIdx;
    hlState.sentenceTimings = sentenceTimings;
    hlState.activeSentenceIdx = activeSentenceIdx;
    hlState.sentenceWordSpans = sentenceWordSpans;
    hlState.sentenceActiveIdx = sentenceActiveIdx;

    const result = updateWordHighlight(audio.currentTime, hlState);
    activeWordIdx = result.activeWordIdx;
    activeSentenceIdx = result.activeSentenceIdx;
    sentenceWordSpans = result.sentenceWordSpans;
    sentenceActiveIdx = result.sentenceActiveIdx;
  }

  // 60fps highlight loop — runs while audio is playing
  let highlightRaf = 0;
  function highlightLoop() {
    doUpdateHighlight();
    highlightRaf = requestAnimationFrame(highlightLoop);
  }
  audio.addEventListener("play", () => { cancelAnimationFrame(highlightRaf); highlightLoop(); });
  audio.addEventListener("pause", () => cancelAnimationFrame(highlightRaf));
  audio.addEventListener("ended", () => cancelAnimationFrame(highlightRaf));

  // ── TTS Generate (Kokoro streaming) ────────────────────────────────────
  let generating = false;

  generateBtn.addEventListener("click", async () => {
    const text = ttsInput.value.trim();
    if (!text || generating) return;

    generating = true;
    generateBtn.classList.add("disabled");
    ttsProgress.classList.remove("hidden");
    ttsProgressFill.style.width = "0%";
    ttsProgressText.textContent = "Loading Kokoro TTS model...";
    freezeWarning.classList.add("hidden");
    ttsOverlay.classList.add("hidden");

    try {
      const tts = await getKokoro((pct, msg) => {
        ttsProgressFill.style.width = `${Math.round(pct * 0.5)}%`;
        ttsProgressText.textContent = msg;
      });

      ttsProgressText.textContent = "Generating speech...";
      ttsProgressFill.style.width = "55%";

      const voice = ttsVoice.value;
      const speed = parseFloat(ttsSpeed.value);

      // Use streaming to handle long text — collect all chunks
      const audioChunks: Float32Array[] = [];
      const chunkMeta: Array<{ text: string; samples: number }> = [];
      let sampleRate = 24000;

      console.log("[Kokoro TTS] Starting generation...", { voice, speed, textLength: text.length });

      // Split text into sentence-sized chunks for generate()
      // (stream() hangs on WebGPU, so we chunk manually)
      const sentences = text.match(/.*?[.!?]+\s*|.+$/gs) || [text];
      const chunks: string[] = [];
      let current = "";
      for (const s of sentences) {
        if (current.length + s.length > 300 && current) {
          chunks.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim()) chunks.push(current.trim());

      // Build word display from chunks (same source as buildTimings)
      const wordSpans = buildWordSpans(wordDisplay, chunks);

      console.log(`[Kokoro TTS] Split into ${chunks.length} chunk(s)`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[Kokoro TTS] Generating chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`);
        ttsProgressText.textContent = chunks.length > 1
          ? `Generating speech (${i + 1}/${chunks.length})...`
          : "Generating speech (this may take a moment)...";
        ttsProgressFill.style.width = `${Math.min(92, 55 + ((i + 1) / chunks.length) * 37)}%`;

        const t0 = performance.now();
        let result: any;
        try {
          result = await tts.generate(chunk, { voice, speed });
        } catch (genErr: any) {
          console.error(`[Kokoro TTS] generate() failed:`, genErr);
          throw new Error(`Generation failed: ${genErr?.message || genErr}`);
        }
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

        // RawAudio: .data (Float32Array getter), .sampling_rate
        // The model.__call__ patch ensures GPU tensors are read back to CPU,
        // so result.data should work. Fall back to .audio if needed.
        const data: Float32Array = result?.data ?? result?.audio;
        if (!data || !(data instanceof Float32Array) || data.length === 0) {
          console.error("[Kokoro TTS] No audio data from result:", result, {
            keys: result ? Object.getOwnPropertyNames(result) : [],
            proto: result ? Object.getOwnPropertyNames(Object.getPrototypeOf(result)) : [],
          });
          throw new Error("TTS generated empty audio. Try shorter text or a different voice.");
        }
        sampleRate = result.sampling_rate || 24000;
        audioChunks.push(data);
        chunkMeta.push({ text: chunk, samples: data.length });
        console.log(`[Kokoro TTS] Chunk ${i + 1} done in ${elapsed}s: ${data.length} samples`);
      }
      console.log("[Kokoro TTS] All chunks generated");

      ttsProgressFill.style.width = "94%";
      ttsProgressText.textContent = "Encoding audio...";
      freezeWarning.classList.add("hidden");

      // Concatenate all chunks into one Float32Array
      const totalSamples = audioChunks.reduce((sum, c) => sum + c.length, 0);
      const fullAudio = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of audioChunks) {
        fullAudio.set(chunk, offset);
        offset += chunk.length;
      }

      // Build word timing map
      wordTimings = buildTimings(chunkMeta, sampleRate, wordSpans);
      activeWordIdx = -1;
      activeSentenceIdx = -1;

      // Build sentence timings from chunks
      sentenceTimings = buildSentenceTimings(chunkMeta, sampleRate);

      // Encode to WAV
      currentWavBlob = encodeWav(fullAudio, sampleRate);

      // Load into audio player
      if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = URL.createObjectURL(currentWavBlob);
      audio.src = currentAudioUrl;
      audio.load();

      ttsProgressFill.style.width = "100%";
      ttsProgressText.textContent = "Done!";

      setTimeout(() => { ttsProgress.classList.add("hidden"); }, 400);
      ttsOverlay.classList.remove("hidden");
      const topBar = document.getElementById("top-bar");
      if (topBar) document.documentElement.style.setProperty("--top-bar-h", topBar.offsetHeight + "px");
      document.body.classList.add("ocr-tts-active");

    } catch (err: any) {
      console.error("TTS generation failed:", err);
      ttsProgressText.textContent = `Error: ${err?.message || "Generation failed."}`;
      freezeWarning.classList.add("hidden");
    } finally {
      generating = false;
      generateBtn.classList.remove("disabled");
    }
  });

  // ── Playback controls ─────────────────────────────────────────────────
  playBtn.addEventListener("click", () => {
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  });

  audio.addEventListener("play", () => setPlayIcon(true));
  audio.addEventListener("pause", () => setPlayIcon(false));
  audio.addEventListener("ended", () => {
    setPlayIcon(false);
    // Clear word highlight on end
    if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) {
      wordTimings[activeWordIdx].el.classList.remove("active");
    }
    activeWordIdx = -1;
    activeSentenceIdx = -1;
  });

  function closeTtsOverlay() {
    audio.pause();
    audio.currentTime = 0;
    cancelAnimationFrame(highlightRaf);
    setPlayIcon(false);
    if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) wordTimings[activeWordIdx].el.classList.remove("active");
    activeWordIdx = -1;
    activeSentenceIdx = -1;
    sentenceActiveIdx = -1;
    sentenceWordSpans = [];
    ttsSentenceEl.textContent = "";
    ttsOverlay.classList.add("hidden");
    document.body.classList.remove("ocr-tts-active");
  }

  // Try Another — close overlay
  ttsBackBtn.addEventListener("click", closeTtsOverlay);

  skipBack.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  skipForward.addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });

  // ── Progress / seek bar + word highlighting ────────────────────────────
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
    timeCurrent.textContent = formatTime(audio.currentTime);
    timeDuration.textContent = formatTime(audio.duration);
    if (audio.paused) doUpdateHighlight();
  });

  audio.addEventListener("loadedmetadata", () => {
    timeCurrent.textContent = "0:00";
    timeDuration.textContent = formatTime(audio.duration);
  });

  let seeking = false;

  function seekTo(e: MouseEvent | Touch) {
    const rect = seekBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  }

  seekBar.addEventListener("mousedown", (e) => {
    seeking = true;
    seekTo(e);
  });
  window.addEventListener("mousemove", (e) => { if (seeking) seekTo(e); });
  window.addEventListener("mouseup", () => { seeking = false; });

  seekBar.addEventListener("touchstart", (e) => {
    seeking = true;
    seekTo(e.touches[0]);
  }, { passive: true });
  window.addEventListener("touchmove", (e) => { if (seeking) seekTo(e.touches[0]); }, { passive: true });
  window.addEventListener("touchend", () => { seeking = false; });

  // ── MP3 download ───────────────────────────────────────────────────────
  let downloading = false;

  downloadBtn.addEventListener("click", async () => {
    if (!currentWavBlob || downloading) return;
    downloading = true;
    downloadBtn.classList.add("converting");

    try {
      const wavBytes = new Uint8Array(await currentWavBlob.arrayBuffer());

      const ff = await getSpeechFFmpeg();
      await ff.writeFile("input.wav", wavBytes);
      const pArgs: string[] = [];
      try { if (localStorage.getItem("convert-privacy") === "true") pArgs.push("-map_metadata", "-1"); } catch {}
      const code = await ff.exec(["-i", "input.wav", "-codec:a", "libmp3lame", "-qscale:a", "2", ...pArgs, "output.mp3"]);
      if (typeof code === "number" && code !== 0) throw new Error(`FFmpeg exit code ${code}`);
      const mp3Data = await ff.readFile("output.mp3") as Uint8Array;
      await ff.deleteFile("input.wav").catch(() => {});
      await ff.deleteFile("output.mp3").catch(() => {});

      const blob = new Blob([mp3Data as BlobPart], { type: "audio/mpeg" });
      downloadBlob(blob, "speech.mp3");
    } catch (err) {
      console.error("MP3 conversion failed:", err);
    } finally {
      downloading = false;
      downloadBtn.classList.remove("converting");
    }
  });

  // ── STT: Microphone (MediaRecorder + Whisper) ──────────────────────────
  let mediaRecorder: MediaRecorder | null = null;
  let micChunks: Blob[] = [];

  function setRecordingUI(recording: boolean) {
    isRecording = recording;
    recordBtn.classList.toggle("recording", recording);
    const dot = recordBtn.querySelector(".speech-record-dot");
    if (dot) {
      recordBtn.textContent = "";
      recordBtn.appendChild(dot);
      recordBtn.append(recording ? " Stop Recording" : " Start Recording");
    }
  }

  recordBtn.addEventListener("click", async () => {
    // Stop recording → transcribe
    if (isRecording && mediaRecorder) {
      mediaRecorder.stop();
      return;
    }

    // Start recording
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      sttOutput.classList.remove("hidden");
      sttResult.value = err?.name === "NotAllowedError"
        ? "Microphone access denied. Please allow microphone access and try again."
        : `Could not access microphone: ${err?.message || err}`;
      return;
    }

    micChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) micChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      // Stop all mic tracks
      stream.getTracks().forEach(t => t.stop());
      setRecordingUI(false);

      if (micChunks.length === 0) return;

      // Build a File from the recorded audio for Whisper
      const blob = new Blob(micChunks, { type: mediaRecorder!.mimeType });
      const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "mp4" : "ogg";
      const file = new File([blob], `recording.${ext}`, { type: blob.type });

      // Transcribe using Whisper
      micProgress.classList.remove("hidden");
      micFreezeWarning.classList.add("hidden");
      micProgressFill.style.width = "0%";
      micProgressText.textContent = "Processing recording...";
      recordBtn.classList.add("disabled");

      try {
        const { generateSubtitles } = await import("./subtitle-generator.ts");
        const language = sttLang.value || undefined;
        const model = sttMicModel.value as "base" | "small" | "medium" | "large-v3-turbo";

        const result = await generateSubtitles(file, (stage, pct) => {
          micProgressFill.style.width = `${pct}%`;
          micProgressText.textContent = stage;
        }, { language, model });

        const srtText = new TextDecoder().decode(result.bytes);
        const plainText = srtText
          .split("\n")
          .filter(line => {
            if (/^\d+$/.test(line.trim())) return false;
            if (/-->/.test(line)) return false;
            if (!line.trim()) return false;
            return true;
          })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        sttOutput.classList.remove("hidden");
        // Append to existing text if any
        const existing = sttResult.value.trim();
        sttResult.value = existing ? existing + " " + plainText : (plainText || "(No speech detected)");

      } catch (err: any) {
        console.error("Mic transcription failed:", err);
        micProgressText.textContent = `Error: ${err?.message || "Unknown error"}`;
        micFreezeWarning.classList.add("hidden");
        sttOutput.classList.remove("hidden");
        sttResult.value = `Transcription failed: ${err?.message || err}\n\nTry a smaller model or check browser console for details.`;
      } finally {
        recordBtn.classList.remove("disabled");
        setTimeout(() => micProgress.classList.add("hidden"), 1500);
      }
    };

    mediaRecorder.start();
    setRecordingUI(true);
  });

  // ── STT: File upload ───────────────────────────────────────────────────
  fileDrop.addEventListener("click", () => fileInput.click());

  fileDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    fileDrop.classList.add("dragover");
  });
  fileDrop.addEventListener("dragleave", () => {
    fileDrop.classList.remove("dragover");
  });
  fileDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileDrop.classList.remove("dragover");
    const file = e.dataTransfer?.files[0];
    if (file) loadSTTFile(file);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) loadSTTFile(fileInput.files[0]);
    fileInput.value = "";
  });

  function loadSTTFile(file: File) {
    sttFile = file;
    fileName.textContent = file.name;
    transcribeBtn.classList.remove("disabled");
  }

  transcribeBtn.addEventListener("click", async () => {
    if (!sttFile || transcribeBtn.classList.contains("disabled")) return;

    transcribeBtn.classList.add("disabled");
    sttProgress.classList.remove("hidden");
    sttFreezeWarning.classList.add("hidden");
    sttProgressFill.style.width = "0%";
    sttProgressText.textContent = "Extracting audio...";

    try {
      const { generateSubtitles } = await import("./subtitle-generator.ts");

      const language = sttFileLang.value || undefined;
      const model = sttFileModel.value as "base" | "small" | "medium" | "large-v3-turbo";

      const result = await generateSubtitles(sttFile, (stage, pct) => {
        sttProgressFill.style.width = `${pct}%`;
        sttProgressText.textContent = stage;
      }, { language, model });

      const srtText = new TextDecoder().decode(result.bytes);
      const plainText = srtText
        .split("\n")
        .filter(line => {
          if (/^\d+$/.test(line.trim())) return false;
          if (/-->/.test(line)) return false;
          if (!line.trim()) return false;
          return true;
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      sttOutput.classList.remove("hidden");
      sttResult.value = plainText || "(No speech detected)";

    } catch (err: any) {
      console.error("Transcription failed:", err);
      const msg = err?.message || "Unknown error";
      sttProgressText.textContent = `Error: ${msg}`;
      sttFreezeWarning.classList.add("hidden");
      sttOutput.classList.remove("hidden");
      sttResult.value = `Transcription failed: ${msg}\n\nTry a smaller model or check browser console for details.`;
    } finally {
      transcribeBtn.classList.remove("disabled");
      setTimeout(() => sttProgress.classList.add("hidden"), 1500);
    }
  });

  // ── Copy button ────────────────────────────────────────────────────────
  sttCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(sttResult.value);
      const original = sttCopy.innerHTML;
      sttCopy.textContent = "Copied!";
      setTimeout(() => { sttCopy.innerHTML = original; }, 1500);
    } catch {
      sttResult.select();
      document.execCommand("copy");
    }
  });

  /** Stop TTS audio and close overlay — called when navigating away. */
  return { stopTts: closeTtsOverlay };
}
