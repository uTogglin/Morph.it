// Web Worker for Kokoro TTS — runs model loading and inference off the main thread

import { detectDevice, getDefaultDtype, patchWebGPUReadback } from "./utils/worker-gpu-utils";

const ctx = self as unknown as Worker;

// We keep up to two model instances alive: the fast WebGPU one and a stable
// WASM (CPU) fallback. On a very long run the GPU process can crash/reset and
// the WebGPU device is permanently lost, so any chunk that hits that runs on
// CPU and we then try to bring GPU back for the following chunks.
let gpuModel: any = null;
let wasmModel: any = null;
let useGpu = false;              // whether GPU is currently our preferred path
let gpuStrikes = 0;             // consecutive GPU losses (reset on a healthy run)
const MAX_GPU_STRIKES = 2;      // after this many in a row, stay on CPU

/** Heuristic: did this error come from the WebGPU device being lost / reset? */
function isGpuDeviceLost(err: any): boolean {
  const msg = (err?.message || String(err) || "").toLowerCase();
  return /external instance|device.*lost|lost.*device|gpubuffer|mapasync|webgpu|gpu device|out of memory/.test(msg);
}

/**
 * Load the Kokoro model on the given (or auto-detected) device.
 *
 * The model is large and downloaded as several shards; a single transient
 * network blip shouldn't be fatal, so the download is retried a few times with
 * backoff (already-fetched shards come from cache, so retries resume quickly).
 *
 * @returns the loaded model plus the device it actually loaded on.
 */
async function loadKokoro(forceDevice?: string): Promise<{ model: any; device: "webgpu" | "wasm" }> {
  const { KokoroTTS } = await import("kokoro-js");

  const device = await detectDevice(forceDevice);
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

  const MAX_ATTEMPTS = 3;
  let model: any;
  for (let attempt = 1; ; attempt++) {
    try {
      model = await loadModel();
      break;
    } catch (err: any) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      ctx.postMessage({ type: "progress", pct: 0, msg: `Download failed — retrying (${attempt + 1}/${MAX_ATTEMPTS})…` });
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  // WebGPU fix: patch model.__call__ to force tensor readback to CPU
  patchWebGPUReadback(model.model, device, "Kokoro Worker");
  console.log("[Kokoro Worker] Model loaded");
  return { model, device };
}

/** Ensure the WASM (CPU) fallback model is loaded. */
async function ensureWasm(): Promise<any> {
  if (!wasmModel) wasmModel = (await loadKokoro("wasm")).model;
  return wasmModel;
}

/** Try to (re)load the model on WebGPU. Returns true if it's now GPU-backed. */
async function reviveGpu(): Promise<boolean> {
  try {
    ctx.postMessage({ type: "progress", pct: 0, msg: "Retrying on GPU…" });
    const { model, device } = await loadKokoro(); // auto-detect
    if (device === "webgpu") { gpuModel = model; return true; }
    // No GPU available right now — keep what we loaded as the CPU fallback.
    if (!wasmModel) wasmModel = model;
    return false;
  } catch {
    return false;
  }
}

/**
 * Generate one chunk, preferring GPU but seamlessly surviving a GPU device
 * loss: the offending chunk is produced on CPU, then GPU is retried for the
 * next chunk. GPU is only abandoned after MAX_GPU_STRIKES consecutive losses.
 */
async function generateChunk(text: string, voice: string, speed: number): Promise<any> {
  // If GPU is our preferred path but we lost the model, try to bring it back.
  if (useGpu && !gpuModel) {
    const revived = await reviveGpu();
    if (!revived) {
      gpuStrikes++;
      if (gpuStrikes >= MAX_GPU_STRIKES) {
        useGpu = false;
        ctx.postMessage({ type: "progress", pct: 0, msg: "GPU unavailable — continuing on CPU (slower but stable)…" });
      }
    }
  }

  if (useGpu && gpuModel) {
    try {
      const out = await gpuModel.generate(text, { voice, speed });
      gpuStrikes = 0; // a healthy GPU run clears the strike counter
      return out;
    } catch (err: any) {
      if (!isGpuDeviceLost(err)) throw err;
      console.warn("[Kokoro Worker] GPU device lost — running this part on CPU", err);
      gpuModel = null;
      gpuStrikes++;
      if (gpuStrikes >= MAX_GPU_STRIKES) {
        useGpu = false;
        ctx.postMessage({ type: "progress", pct: 0, msg: "GPU unstable — continuing on CPU (slower but stable)…" });
      } else {
        ctx.postMessage({ type: "progress", pct: 0, msg: "GPU hiccup — this part on CPU, will retry GPU…" });
      }
      await ensureWasm();
      return await wasmModel.generate(text, { voice, speed });
    }
  }

  // GPU disabled or unavailable → CPU.
  await ensureWasm();
  return await wasmModel.generate(text, { voice, speed });
}

ctx.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    if (gpuModel || wasmModel) { ctx.postMessage({ type: "ready" }); return; }
    try {
      const { model, device } = await loadKokoro(e.data.forceDevice);
      if (device === "webgpu") { gpuModel = model; useGpu = true; }
      else { wasmModel = model; useGpu = false; }
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
      if (!gpuModel && !wasmModel) throw new Error("Model not loaded");
      const result = await generateChunk(text, voice, speed);

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
