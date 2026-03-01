// ── Shared lazy Tesseract worker ─────────────────────────────────────────────
let ocrWorker: any = null;
let ocrWorkerLoading: Promise<any> | null = null;
let loadedLang: string | null = null;

export async function getOcrWorker(lang: string, onProgress?: (pct: number, msg: string) => void): Promise<any> {
  if (ocrWorker && loadedLang === lang) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; ocrWorkerLoading = null; }

  if (ocrWorkerLoading) { await ocrWorkerLoading; return ocrWorker; }

  ocrWorkerLoading = (async () => {
    const Tesseract = await import("tesseract.js");
    onProgress?.(0, `Loading OCR engine (${lang})...`);
    const worker = await Tesseract.createWorker(lang, undefined, {
      logger: (m: any) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          onProgress?.(Math.round(m.progress * 100), "Recognizing text...");
        } else if (m.status === "loading tesseract core") {
          onProgress?.(5, "Loading OCR engine...");
        } else if (m.status === "loading language traineddata") {
          onProgress?.(10, `Downloading ${lang} language data...`);
        } else if (m.status === "initializing api") {
          onProgress?.(20, "Initializing OCR...");
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
