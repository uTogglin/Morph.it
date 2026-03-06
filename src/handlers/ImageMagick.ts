import {
  initializeImageMagick,
  Magick,
  MagickFormat,
  MagickImageCollection,
  MagickReadSettings
} from "@imagemagick/magick-wasm";

import mime from "mime";
import normalizeMimeType from "../normalizeMimeType.ts";

import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { cdnFetch } from "../cdn.ts";

class ImageMagickHandler implements FormatHandler {

  public name: string = "ImageMagick";

  public supportedFormats: FileFormat[] = [];

  public ready: boolean = false;

  async init () {

    const wasmBytes = await cdnFetch("magickWasm").then(r => r.bytes());

    await initializeImageMagick(wasmBytes);

    Magick.supportedFormats.forEach(format => {
      const formatName = format.format.toLowerCase();
      if (formatName === "apng") return;
      if (formatName === "svg") return;
      if (formatName === "ttf") return;
      if (formatName === "otf") return;
      const mimeType = format.mimeType || mime.getType(formatName);
      if (
        !mimeType
        || mimeType.startsWith("text/")
        || mimeType.startsWith("video/")
        || mimeType === "application/json"
      ) return;
      this.supportedFormats.push({
        name: format.description,
        format: formatName === "jpg" ? "jpeg" : formatName,
        extension: formatName,
        mime: normalizeMimeType(mimeType),
        from: mimeType === "application/pdf" ? false : format.supportsReading,
        to: format.supportsWriting,
        internal: format.format,
        category: mimeType.split("/")[0],
        lossless: ["png", "bmp", "tiff"].includes(formatName)
      });
    });

    // ====== Manual fine-tuning ======

    const prioritize = ["png", "jpeg", "gif", "pdf"];
    prioritize.reverse();

    this.supportedFormats.sort((a, b) => {
      const priorityIndexA = prioritize.indexOf(a.format);
      const priorityIndexB = prioritize.indexOf(b.format);
      return priorityIndexB - priorityIndexA;
    });

    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    const inputMagickFormat = inputFormat.internal as MagickFormat;
    const outputMagickFormat = outputFormat.internal as MagickFormat;

    const inputSettings = new MagickReadSettings();
    inputSettings.format = inputMagickFormat;


    const bytes: Uint8Array = await new Promise((resolve, reject) => {
      try {
        MagickImageCollection.use(outputCollection => {
          for (const inputFile of inputFiles) {
             if (inputFormat.format == "rgb") {
               // Guess square dimensions from pixel count
               const pixelCount = inputFile.bytes.length / 3;
               const side = Math.round(Math.sqrt(pixelCount));
               inputSettings.width = side;
               inputSettings.height = Math.ceil(pixelCount / side);
             }
            MagickImageCollection.use(fileCollection => {
              fileCollection.read(inputFile.bytes, inputSettings);
              while (fileCollection.length > 0) {
                const image = fileCollection.shift();
                if (!image) break;
                outputCollection.push(image);
              }
            });
          }
          outputCollection.write(outputMagickFormat, (bytes) => {
            resolve(new Uint8Array(bytes));
          });
        });
      } catch (e) {
        reject(e);
      }
    });

    const baseName = inputFiles[0].name.replace(/\.[^.]+$/, "") || inputFiles[0].name;
    const name = baseName + "." + outputFormat.extension;
    return [{ bytes, name }];

  }

}

export default ImageMagickHandler;
