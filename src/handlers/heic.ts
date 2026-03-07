import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";
import { Category } from "src/CommonFormats.ts";
import { getBaseName } from "../utils/file-utils.ts";
import { canvasToBytes } from "../utils/canvas-to-bytes.ts";

class heicHandler implements FormatHandler {

  public name: string = "heic";

  public supportedFormats = [
    {
      name: "High Efficiency Image Format",
      format: "heif",
      extension: "heif",
      mime: "image/heif",
      from: true,
      to: false,
      internal: "heic",
      category: Category.IMAGE
    },
    {
      name: "High Efficiency Image Coding",
      format: "heic",
      extension: "heic",
      mime: "image/heic",
      from: true,
      to: false,
      internal: "heic",
      category: Category.IMAGE
    },
    CommonFormats.PNG.builder("png").allowTo().markLossless(),
    CommonFormats.JPEG.builder("jpeg").allowTo(),
    CommonFormats.WEBP.builder("webp").allowTo(),
    CommonFormats.AVIF.builder("avif").allowTo()
  ];

  public ready: boolean = false;

  private convert: any = null;

  async init() {
    const mod = await import("heic-convert/browser");
    this.convert = mod.default ?? mod;
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {
      const buffer = inputFile.bytes;

      if (outputFormat.internal === "webp" || outputFormat.internal === "avif") {
        // heic-convert doesn't support WebP/AVIF directly, so decode to PNG then re-encode via canvas
        const pngBuffer: Uint8Array = await this.convert({
          buffer,
          format: "PNG"
        });

        const blob = new Blob([pngBuffer as BlobPart], { type: "image/png" });
        const bitmap = await createImageBitmap(blob);

        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        const bytes = await canvasToBytes(canvas, outputFormat.mime);
        const name = getBaseName(inputFile.name) + "." + outputFormat.extension;
        outputFiles.push({ bytes, name });
      } else {
        const format = outputFormat.internal === "jpeg" ? "JPEG" : "PNG";
        const options: any = { buffer, format };
        if (format === "JPEG") options.quality = 0.92;

        const result: Uint8Array = await this.convert(options);
        const ext = outputFormat.extension;
        const name = getBaseName(inputFile.name) + "." + ext;
        outputFiles.push({ bytes: new Uint8Array(result), name });
      }
    }

    return outputFiles;
  }
}

export default heicHandler;
