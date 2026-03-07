import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { getBaseName } from "../utils/file-utils.ts";

import { parseODT, parseODP, parseODS } from "./envelope/parseODF.js";
import parseDOCX from "./envelope/parseDOCX.js";
import parsePPTX from "./envelope/parsePPTX.js";
import parseXLSX from "./envelope/parseXLSX.js";
import CommonFormats from "src/CommonFormats.ts";

function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on') || attr.value.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

class envelopeHandler implements FormatHandler {

  public name: string = "envelope";

  public supportedFormats: FileFormat[] = [
    CommonFormats.DOCX.builder("docx").allowFrom(),
    // Currently, Pancoc handles PPTX and XLSX better than Envelope.
    // CommonFormats.PPTX.builder("pptx").allowFrom(),
    // CommonFormats.XLSX.builder("xlsx").allowFrom(),
    {
      name: "OpenDocument Text",
      format: "odt",
      extension: "odt",
      mime: "application/vnd.oasis.opendocument.text",
      from: true,
      to: false,
      internal: "odt",
      category: "document"
    },
    {
      name: "OpenDocument Presentation",
      format: "odp",
      extension: "odp",
      mime: "application/vnd.oasis.opendocument.presentation",
      from: true,
      to: false,
      internal: "odp",
      category: "presentation"
    },
    {
      name: "OpenDocument Spreadsheet",
      format: "ods",
      extension: "ods",
      mime: "application/vnd.oasis.opendocument.spreadsheet",
      from: true,
      to: false,
      internal: "ods",
      category: "spreadsheet"
    },
    // Technically not "lossless", but it's about as close as we'll ever get
    CommonFormats.HTML.supported("html", false, true, true)
  ];

  public ready: boolean = true;

  async init () {
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    if (outputFormat.internal !== "html") throw "Invalid output format.";

    let parser: (bytes: Uint8Array) => Promise<string>;
    switch (inputFormat.internal) {
      case "odt": parser = parseODT; break;
      case "odp": parser = parseODP; break;
      case "ods": parser = parseODS; break;
      case "docx": parser = parseDOCX; break;
      case "pptx": parser = parsePPTX; break;
      case "xlsx": parser = parseXLSX; break;
      default: throw "Invalid input format.";
    }

    const outputFiles: FileData[] = [];

    const encoder = new TextEncoder();

    for (const inputFile of inputFiles) {
      const parsedContent = sanitizeHtml(await parser(inputFile.bytes));
      const html = `<div style="background: #fff">
        ${parsedContent}
      </div>`;
      const bytes = encoder.encode(html);
      const baseName = getBaseName(inputFile.name);
      const name = baseName + "." + outputFormat.extension;
      outputFiles.push({ bytes, name });
    }

    return outputFiles;

  }

}

export default envelopeHandler;
