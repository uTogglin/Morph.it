// ── Shared lazy Tesseract worker ─────────────────────────────────────────────
let ocrWorker: any = null;
let ocrWorkerLoading: Promise<any> | null = null;
let loadedLang: string | null = null;

/**
 * Mutable progress callback — the logger captures this reference so callers
 * can swap it out between worker-loading and recognition phases.
 */
let _ocrProgress: ((pct: number, msg: string) => void) | null = null;

/** Replace the active progress callback (used by ocr-tool to remap ranges). */
export function setOcrProgress(fn: ((pct: number, msg: string) => void) | null) {
  _ocrProgress = fn;
}

export async function getOcrWorker(lang: string, onProgress?: (pct: number, msg: string) => void): Promise<any> {
  if (ocrWorker && loadedLang === lang) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; ocrWorkerLoading = null; }

  if (ocrWorkerLoading) { await ocrWorkerLoading; return ocrWorker; }

  _ocrProgress = onProgress ?? null;

  ocrWorkerLoading = (async () => {
    const Tesseract = await import("tesseract.js");
    _ocrProgress?.(0, `Loading OCR engine (${lang})...`);
    const worker = await Tesseract.createWorker(lang, undefined, {
      logger: (m: any) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          _ocrProgress?.(Math.round(m.progress * 100), "Recognizing text...");
        } else if (m.status === "loading tesseract core") {
          _ocrProgress?.(5, "Loading OCR engine...");
        } else if (m.status === "loading language traineddata") {
          _ocrProgress?.(10, `Downloading ${lang} language data...`);
        } else if (m.status === "initializing api") {
          _ocrProgress?.(20, "Initializing OCR...");
        }
      },
    });
    ocrWorker = worker;
    loadedLang = lang;
  })();

  try {
    await ocrWorkerLoading;
  } catch (err) {
    ocrWorkerLoading = null;
    throw err;
  }
  return ocrWorker;
}
