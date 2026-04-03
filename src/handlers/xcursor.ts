import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";

class xcursorHandler implements FormatHandler {
  public name: string = "xcursor";
  public supportedFormats: FileFormat[] = [
    CommonFormats.PNG.builder("png").markLossless().allowFrom(false).allowTo(true),
    CommonFormats.JPEG.builder("jpeg").allowFrom(false).allowTo(true),
    {
      name: "X11 cursor",
      format: "xcur",
      extension: "",
      mime: "image/x-x11-cursor",
      from: true,
      to: false,
      internal: "xcur",
      category: "image",
      lossless: true,
    },
  ];
  public ready: boolean = false;

  #canvas?: HTMLCanvasElement;
  #ctx?: CanvasRenderingContext2D;

  async init() {
    this.#canvas = document.createElement("canvas");
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create 2D rendering context.");
    this.#ctx = ctx;

    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    if (!this.ready || !this.#canvas || !this.#ctx) {
      throw new Error("Handler not initialized!");
    }
    if (
      inputFormat.internal !== "xcur" ||
      outputFormat.internal === "xcur" ||
      inputFormat.internal === outputFormat.internal
    ) {
      throw new Error("Invalid input/output format!");
    }

    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {
      const view = new DataView(inputFile.bytes.buffer);

      const magic = Array.from(inputFile.bytes.slice(0, 4))
        .map((c) => String.fromCharCode(c))
        .join("");
      if (magic !== "Xcur") {
        console.error("File is not an X11 cursor.");
        continue;
      }

      const tocLength = view.getUint32(12, true);
      for (let i = 0; i < tocLength; i++) {
        const type = view.getUint32(16 + i * 12, true);
        if (type !== 0xfffd0002) continue;

        const offset = view.getUint32(16 + i * 12 + 8, true);

        const width = view.getUint32(offset + 16, true);
        const height = view.getUint32(offset + 20, true);

        const pixelSlice = inputFile.bytes.slice(offset + 36, offset + 36 + width * height * 4);
        const pixels = new Uint8ClampedArray(pixelSlice.length);
        pixels.set(pixelSlice);

        this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
        this.#canvas.width = width;
        this.#canvas.height = height;

        const imageData = new ImageData(pixels, width, height);
        this.#ctx.putImageData(imageData, 0, 0);

        const bytes: Uint8Array = await new Promise((resolve, reject) => {
          this.#canvas!.toBlob(
            (blob) => {
              if (!blob) return reject("Canvas output failed.");
              blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
            },
            outputFormat.mime
          );
        });

        const name = `${inputFile.name}_${i}.${outputFormat.extension}`;
        outputFiles.push({ bytes, name });
      }
    }

    return outputFiles;
  }
}

export default xcursorHandler;
