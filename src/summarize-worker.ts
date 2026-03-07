// Web Worker for BART/DistilBART summarization inference

import { detectDevice, getDefaultDtype } from "./utils/worker-gpu-utils";

const ctx = self as unknown as Worker;

const MODELS: Record<string, { id: string; label: string }> = {
  "distilbart-6-6":  { id: "Xenova/distilbart-cnn-6-6",  label: "DistilBART 6-6" },
  "distilbart-12-6": { id: "Xenova/distilbart-cnn-12-6", label: "DistilBART 12-6" },
  "bart-large-cnn":  { id: "Xenova/bart-large-cnn",      label: "BART Large CNN" },
};

let summarizer: any = null;
let loadedModelKey: string | null = null;

ctx.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "load") {
    const { modelKey } = e.data;
    const modelInfo = MODELS[modelKey] || MODELS["distilbart-12-6"];

    // If model changed, discard old pipeline
    if (summarizer && loadedModelKey !== modelKey) {
      summarizer = null;
    }
    if (summarizer) { ctx.postMessage({ type: "loaded" }); return; }

    try {
      const { pipeline } = await import("@huggingface/transformers");

      const device = await detectDevice(e.data.forceDevice);
      const dtype = getDefaultDtype(device);

      console.log(`[Summarize Worker] device=${device}, dtype=${dtype}`);
      ctx.postMessage({ type: "progress", pct: 0, msg: `Loading ${modelInfo.label} (${device})...` });

      let lastUpdate = 0;
      summarizer = await pipeline("summarization", modelInfo.id, {
        device,
        dtype,
        progress_callback: (info: any) => {
          if (info.status === "progress" && typeof info.progress === "number") {
            const now = performance.now();
            if (now - lastUpdate < 200) return;
            lastUpdate = now;
            const loaded = info.loaded ? (info.loaded / 1024 / 1024).toFixed(0) : "";
            const total = info.total ? (info.total / 1024 / 1024).toFixed(0) : "";
            const sizeInfo = loaded && total ? ` — ${loaded} / ${total} MB` : "";
            ctx.postMessage({ type: "progress", pct: Math.round(info.progress), msg: `Downloading ${modelInfo.label}${sizeInfo}` });
          }
        },
      } as any);

      loadedModelKey = modelKey;
      console.log(`[Summarize Worker] ${modelInfo.label} loaded (${device})`);
      ctx.postMessage({ type: "loaded" });
    } catch (err: any) {
      summarizer = null;
      ctx.postMessage({ type: "error", message: err?.message || "Failed to load summarization model" });
    }
    return;
  }

  if (type === "summarize") {
    const { text, maxLength, minLength } = e.data;
    if (!summarizer) { ctx.postMessage({ type: "error", message: "Model not loaded" }); return; }

    try {
      const result = await summarizer(text, { max_length: maxLength, min_length: minLength });
      ctx.postMessage({ type: "result", summary: result[0].summary_text });
    } catch (err: any) {
      ctx.postMessage({ type: "error", message: err?.message || "Summarization failed" });
    }
    return;
  }
};
