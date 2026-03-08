import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import JSZip from "jszip";

class jszipHandler implements FormatHandler {

  public name: string = "jszip";

  public supportedFormats: FileFormat[] = [
    CommonFormats.ZIP.builder("zip").allowTo()
  ];

  public supportAnyInput: boolean = true;

  public ready: boolean = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    const outputFiles: FileData[] = [];
    const zip = new JSZip();

    for (let i = 0; i < inputFiles.length; i++) {
      zip.file(inputFiles[i].name, inputFiles[i].bytes);
      if (i % 10 === 9) {
        await new Promise(r => requestAnimationFrame(r));
      }
    }

    const output = await zip.generateAsync({ type: "uint8array" });

    outputFiles.push({ bytes: output, name: "output.zip" });
    return outputFiles;
  }
}

export default jszipHandler;
