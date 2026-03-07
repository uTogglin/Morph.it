// Web Worker for Whisper STT — runs model loading and transcription off the main thread

import { detectDevice, patchWebGPUReadback } from "./utils/worker-gpu-utils";

const ctx = self as unknown as Worker;

const pipelines: Map<string, any> = new Map();
let detectedDevice: "webgpu" | "wasm" | null = null;

const MODELS: Record<string, { id: string; label: string }> = {
  base: { id: "onnx-community/whisper-base", label: "Base" },
  small: { id: "onnx-community/whisper-small", label: "Small" },
  medium: { id: "Xenova/whisper-medium", label: "Medium" },
  "large-v3-turbo": { id: "onnx-community/whisper-large-v3-turbo", label: "Large V3 Turbo" },
};

async function getDevice(forceDevice?: string): Promise<"webgpu" | "wasm"> {
  if (detectedDevice && forceDevice !== "wasm") return detectedDevice;
  detectedDevice = await detectDevice(forceDevice);
  console.log(`[Whisper Worker] device=${detectedDevice}`);
  return detectedDevice;
}

function getDtype(modelKey: string, device: "webgpu" | "wasm"): any {
  if (device === "webgpu") {
    if (modelKey === "large-v3-turbo" || modelKey === "medium") {
      return { encoder_model: "fp16", decoder_model_merged: "q4" };
    }
    return "fp32";
  }
  if (modelKey === "large-v3-turbo") return "q4";
  return "q8";
}

ctx.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "load") {
    const { modelKey } = e.data;
    const cfg = MODELS[modelKey];
    if (!cfg) { ctx.postMessage({ type: "error", message: `Unknown model: ${modelKey}` }); return; }
    if (pipelines.has(modelKey)) { ctx.postMessage({ type: "loaded" }); return; }

    try {
      const { pipeline } = await import("@huggingface/transformers");
      const device = await getDevice(e.data.forceDevice);
      const dtype = getDtype(modelKey, device);
      const dtypeLabel = typeof dtype === "string" ? dtype : "mixed";
      ctx.postMessage({ type: "progress", pct: 10, msg: `Loading ${cfg.label} model (${device}, ${dtypeLabel})...` });

      const fileProgress: Map<string, { loaded: number; total: number }> = new Map();
      let fromCache = true;
      let lastCall = 0;

      const pipe = await pipeline("automatic-speech-recognition", cfg.id, {
        dtype,
        device: device as any,
        progress_callback: (info: any) => {
          if (info.status === "progress" && typeof info.progress === "number") {
            const fname = info.file || "";
            if (info.loaded && info.total) {
              fileProgress.set(fname, { loaded: info.loaded, total: info.total });
              if (info.loaded < info.total * 0.95) fromCache = false;
            }
            const now = performance.now();
            if (now - lastCall < 200) return;
            lastCall = now;
            let totalLoaded = 0, totalSize = 0;
            for (const fp of fileProgress.values()) { totalLoaded += fp.loaded; totalSize += fp.total; }
            const overallPct = totalSize > 0 ? totalLoaded / totalSize : 0;
            const pct = Math.round(10 + overallPct * 40);
            const loaded = (totalLoaded / 1024 / 1024).toFixed(0);
            const total = (totalSize / 1024 / 1024).toFixed(0);
            const action = fromCache ? "Loading" : "Downloading";
            ctx.postMessage({ type: "progress", pct, msg: `${action} ${cfg.label} model — ${loaded} / ${total} MB` });
          } else if (info.status === "ready") {
            console.log(`[Whisper Worker] Model ${cfg.label} ready (${device}, ${dtypeLabel})`);
            ctx.postMessage({ type: "progress", pct: 50, msg: `${cfg.label} model loaded!` });
          }
        },
      });

      // WebGPU fix: patch model.__call__ to force tensor readback to CPU
      patchWebGPUReadback(pipe.model, device, "Whisper Worker");

      pipelines.set(modelKey, pipe);
      ctx.postMessage({ type: "loaded" });
    } catch (err: any) {
      ctx.postMessage({ type: "error", message: err?.message || "Failed to load Whisper model" });
    }
    return;
  }

  if (type === "transcribe") {
    const { modelKey, audioData, options } = e.data;
    const pipe = pipelines.get(modelKey);
    if (!pipe) { ctx.postMessage({ type: "error", message: "Model not loaded" }); return; }

    try {
      ctx.postMessage({ type: "progress", pct: 55, msg: "Transcribing..." });

      const pipelineOpts: any = {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      };
      if (options?.language) {
        pipelineOpts.language = options.language;
        pipelineOpts.task = "transcribe";
      }

      const result = await pipe(audioData, pipelineOpts);

      ctx.postMessage({ type: "progress", pct: 90, msg: "Formatting subtitles..." });
      ctx.postMessage({ type: "result", chunks: result.chunks || [], text: result.text || "" });
    } catch (err: any) {
      ctx.postMessage({ type: "error", message: err?.message || "Transcription failed" });
    }
    return;
  }
};
