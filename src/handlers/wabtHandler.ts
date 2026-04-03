import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { Category } from "../CommonFormats.ts";

class wabtHandler implements FormatHandler {
  public name: string = "wabt";
  public supportedFormats?: FileFormat[];
  public ready: boolean = false;

  private wabtModule?: any;

  private wasm2wat(bytes: Uint8Array): Uint8Array {
    const wasmModule = this.wabtModule!.readWasm(bytes, {});
    const str = wasmModule.toText({});
    const encoded = new TextEncoder().encode(str);
    wasmModule.destroy();
    return encoded;
  }

  private wat2wasm(filename: string, bytes: Uint8Array): Uint8Array {
    const wasmModule = this.wabtModule!.parseWat(filename, bytes);
    const outBytes = wasmModule.toBinary({});
    const buffer = outBytes.buffer;
    wasmModule.destroy();
    return buffer;
  }

  async init() {
    this.supportedFormats = [
      {
        name: "WebAssembly Binary (Wasm)",
        format: "wasm",
        extension: "wasm",
        mime: "application/wasm",
        from: true,
        to: true,
        internal: "wasm",
        category: Category.CODE,
        lossless: true,
      },
      {
        name: "WebAssembly Text Format (WAT)",
        format: "wat",
        extension: "wat",
        mime: "text/plain",
        from: true,
        to: true,
        internal: "wat",
        category: Category.CODE,
        lossless: true,
      },
    ];

    const wabt = (await import("wabt")).default;
    this.wabtModule = await wabt();

    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    if (inputFormat.internal === "wasm" && outputFormat.internal === "wat") {
      for (const file of inputFiles) {
        outputFiles.push({
          name: file.name.split(".").slice(0, -1).join(".") + `.${outputFormat.extension}`,
          bytes: this.wasm2wat(file.bytes),
        });
      }
      return outputFiles;
    }

    if (inputFormat.internal === "wat" && outputFormat.internal === "wasm") {
      for (const file of inputFiles) {
        outputFiles.push({
          name: file.name.split(".").slice(0, -1).join(".") + `.${outputFormat.extension}`,
          bytes: this.wat2wasm(file.name, file.bytes),
        });
      }
      return outputFiles;
    }

    throw new Error(
      `wabtHandler does not support route: ${inputFormat.internal} -> ${outputFormat.internal}`
    );
  }
}

export default wabtHandler;
