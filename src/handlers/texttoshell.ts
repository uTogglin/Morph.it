import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { getBaseName } from "../utils/file-utils.ts";

class textToShellHandler implements FormatHandler {

  public name: string = "textToSH";

  public supportedFormats: FileFormat[] = [
    CommonFormats.TEXT.supported("txt", true, false, true),
    CommonFormats.SH.supported("sh", false, true, true)
  ];

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

    for (const file of inputFiles) {
      if (inputFormat.internal !== "txt" || outputFormat.internal !== "sh") {
        throw new Error("Invalid output format.");
      }

      let text = new TextDecoder().decode(file.bytes).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("!", "\\!");

      let newText = `#!/bin/sh\necho "${text}"`;
      const name = getBaseName(file.name) +
        "." +
        outputFormat.extension;

      outputFiles.push({
        bytes: new TextEncoder().encode(newText), 
        name: name
      });
    }

    return outputFiles;
  }
}

export default textToShellHandler;
