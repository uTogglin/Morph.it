import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { getBaseName } from "../utils/file-utils.ts";

/** Render a canvas to image bytes via toBlob (no base64 round-trip). */
function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) { reject(new Error("Canvas is empty — failed to encode image.")); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      mime,
      quality,
    );
  });
}

class pdftoimgHandler implements FormatHandler {

  public name: string = "pdftoimg";

  public supportedFormats: FileFormat[] = [
    CommonFormats.PDF.builder("pdf").allowFrom(),
    CommonFormats.PNG.supported("png", false, true),
    CommonFormats.JPEG.supported("jpeg", false, true),
  ];

  public ready: boolean = true;

  async init () {
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    if (
      outputFormat.format !== "png"
      && outputFormat.format !== "jpeg"
    ) throw "Invalid output format.";

    const mime = outputFormat.format === "jpeg" ? "image/jpeg" : "image/png";
    const quality = outputFormat.format === "jpeg" ? 0.92 : undefined;

    // Render with pdfjs-dist directly — same engine the OCR/editor tools use,
    // so we don't bundle a second copy of pdf.js just for this handler.
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {

      // getDocument detaches the buffer it's given; copy so the caller's bytes
      // (which may be reused for other outputs) stay intact.
      const data = inputFile.bytes.slice();
      const pdf = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;

      const baseName = getBaseName(inputFile.name);

      try {
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 2 }); // 2x for crisp output
          const canvas = document.createElement("canvas");
          canvas.width = vp.width;
          canvas.height = vp.height;
          const ctx = canvas.getContext("2d")!;
          // pdf.js renders onto a transparent canvas; JPEG has no alpha, so a
          // transparent page would encode as black. Paint white first.
          if (mime === "image/jpeg") {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          await page.render({ canvasContext: ctx, viewport: vp }).promise;

          const bytes = await canvasToBytes(canvas, mime, quality);
          const name = `${baseName}_${i - 1}.${outputFormat.extension}`;
          outputFiles.push({ bytes, name });

          // Release page + canvas memory before the next page.
          page.cleanup();
          canvas.width = canvas.height = 0;
        }
      } finally {
        await pdf.destroy();
      }

    }

    return outputFiles;

  }

}

export default pdftoimgHandler;
