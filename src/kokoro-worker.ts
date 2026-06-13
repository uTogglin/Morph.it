// Web Worker for Kokoro TTS — runs model loading and inference off the main thread

import { detectDevice, getDefaultDtype, patchWebGPUReadback } from "./utils/worker-gpu-utils";

const ctx = self as unknown as Worker;

let tts: any = null;

ctx.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    if (tts) { ctx.postMessage({ type: "ready" }); return; }
    try {
      const { KokoroTTS } = await import("kokoro-js");

      const device = await detectDevice(e.data.forceDevice);
      const dtype = getDefaultDtype(device);

      console.log(`[Kokoro Worker] device=${device}, dtype=${dtype}`);
      ctx.postMessage({ type: "progress", pct: 0, msg: `Loading Kokoro model (${device})...` });

      let lastUpdate = 0;
      const loadModel = () => KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: dtype as any,
        device: device as any,
        progress_callback: (info: any) => {
          if (info.status === "progress" && typeof info.progress === "number") {
            const now = performance.now();
            if (now - lastUpdate < 200) return;
            lastUpdate = now;
            const loaded = info.loaded ? (info.loaded / 1024 / 1024).toFixed(0) : "";
            const total = info.total ? (info.total / 1024 / 1024).toFixed(0) : "";
            const sizeInfo = loaded && total ? ` — ${loaded} / ${total} MB` : "";
            ctx.postMessage({ type: "progress", pct: Math.round(info.progress), msg: `Downloading Kokoro model${sizeInfo}` });
          }
        },
      });

      // The model is large and downloaded as several shards; a single transient
      // network blip shouldn't be fatal. Retry a few times with backoff before
      // giving up — already-fetched shards come from cache, so retries resume
      // quickly rather than restarting the whole download.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; ; attempt++) {
        try {
          tts = await loadModel();
          break;
        } catch (err: any) {
          if (attempt >= MAX_ATTEMPTS) throw err;
          ctx.postMessage({ type: "progress", pct: 0, msg: `Download failed — retrying (${attempt + 1}/${MAX_ATTEMPTS})…` });
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }

      // WebGPU fix: patch model.__call__ to force tensor readback to CPU
      patchWebGPUReadback(tts.model, device, "Kokoro Worker");

      console.log("[Kokoro Worker] Model loaded");
      ctx.postMessage({ type: "ready" });
    } catch (err: any) {
      const raw = err?.message || "Failed to load Kokoro model";
      const friendly = /network|fetch|load failed|timed? ?out/i.test(raw)
        ? "Network error downloading the TTS model. Check your connection and try again."
        : raw;
      ctx.postMessage({ type: "error", message: friendly });
    }
    return;
  }

  if (type === "generate") {
    const { id, text, voice, speed } = e.data;
    try {
      if (!tts) throw new Error("Model not loaded");
      const result = await tts.generate(text, { voice, speed });
      const data: Float32Array = result?.data ?? result?.audio;
      if (!data || !(data instanceof Float32Array) || data.length === 0) {
        throw new Error("TTS generated empty audio. Try shorter text or a different voice.");
      }
      const sampleRate = result.sampling_rate || 24000;
      // Clone before transferring so the model's internal buffer is not detached
      const cloned = new Float32Array(data);
      ctx.postMessage({ type: "result", id, audio: cloned, sampleRate }, [cloned.buffer]);
    } catch (err: any) {
      ctx.postMessage({ type: "error", id, message: err?.message || "Generation failed" });
    }
    return;
  }
};
