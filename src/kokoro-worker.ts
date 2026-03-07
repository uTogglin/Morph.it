// Web Worker for Kokoro TTS — runs model loading and inference off the main thread

const ctx = self as unknown as Worker;

let tts: any = null;

ctx.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    if (tts) { ctx.postMessage({ type: "ready" }); return; }
    try {
      const { KokoroTTS } = await import("kokoro-js");

      const hasWebGPU = "gpu" in navigator &&
        !!(await (navigator as any).gpu?.requestAdapter().catch(() => null));
      const device = hasWebGPU ? "webgpu" : "wasm";
      const dtype = hasWebGPU ? "fp32" : "q8";

      console.log(`[Kokoro Worker] device=${device}, dtype=${dtype}`);
      ctx.postMessage({ type: "progress", pct: 0, msg: `Loading Kokoro model (${device})...` });

      let lastUpdate = 0;
      tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
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

      // WebGPU fix: patch model.__call__ to force tensor readback to CPU
      if (device === "webgpu" && tts.model?.__call__) {
        const origCall = tts.model.__call__.bind(tts.model);
        tts.model.__call__ = async function (...args: any[]) {
          const output = await origCall(...args);
          for (const key of Object.keys(output)) {
            const tensor = output[key];
            if (tensor && typeof tensor.getData === "function") await tensor.getData();
          }
          return output;
        };
        console.log("[Kokoro Worker] Patched __call__ for WebGPU tensor readback");
      }

      console.log("[Kokoro Worker] Model loaded");
      ctx.postMessage({ type: "ready" });
    } catch (err: any) {
      ctx.postMessage({ type: "error", message: err?.message || "Failed to load Kokoro model" });
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
