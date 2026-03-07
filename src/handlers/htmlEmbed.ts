import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { getBaseName } from "../utils/file-utils.ts";

class htmlEmbedHandler implements FormatHandler {

  public name: string = "htmlEmbed";
  public supportedFormats: FileFormat[] = [
    CommonFormats.HTML.supported("html", false, true, true),
    CommonFormats.PNG.supported("png", true, false),
    CommonFormats.JPEG.supported("jpeg", true, false),
    CommonFormats.WEBP.supported("webp", true, false),
    CommonFormats.GIF.supported("gif", true, false),
    CommonFormats.SVG.supported("svg", true, false),
    CommonFormats.TEXT.supported("text", true, false),
    CommonFormats.MP4.builder("mp4").allowFrom(),
    CommonFormats.MP3.supported("mp3", true, false)
  ];
  public ready: boolean = false;

  async init () {
    this.ready = true;
  }

  static bytesToBase64 (bytes: Uint8Array): string {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 32768) {
      const byteChunk = bytes.subarray(i, i + 32768);
      chunks.push(String.fromCharCode(...byteChunk));
    }
    return btoa(chunks.join(""));
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    if (outputFormat.internal !== "html") throw "Invalid output format.";

    const encoder = new TextEncoder();
    let html = "";

    if (inputFormat.internal === "text") {
      const decoder = new TextDecoder();
      for (const inputFile of inputFiles) {
        const text = decoder.decode(inputFile.bytes)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll("\n", "<br>");
        html += `<p>${text}</p>`;
      }
    } else {
      const escapedMime = inputFormat.mime.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      for (const inputFile of inputFiles) {

        const base64 = htmlEmbedHandler.bytesToBase64(inputFile.bytes);

        if (inputFormat.mime.startsWith("image/")) {
          html += `<img src="data:${escapedMime};base64,${base64}"><br>`;
        } else if (inputFormat.mime.startsWith("audio/")) {
          html += `<audio controls>
            <source src="data:${escapedMime};base64,${base64}" type="${escapedMime}"></source>
          </audio><br>`;
        } else {
          html += `<video controls>
            <source src="data:${escapedMime};base64,${base64}" type="${escapedMime}"></source>
          </video><br>`;
        }

      }
    }

    const bytes = encoder.encode(html);
    const name = getBaseName(inputFiles[0].name) + "." + outputFormat.extension;
    return [{ bytes, name }];

  }

}

export default htmlEmbedHandler;