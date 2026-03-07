import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { Replay } from "./bsor/replay.ts";
import { render } from "./bsor/renderer.ts";
import CommonFormats from "src/CommonFormats.ts";
import { canvasToBytes } from "../utils/canvas-to-bytes.ts";
import { getBaseName } from "../utils/file-utils.ts";

class bsorHandler implements FormatHandler {
  public name: string = "bsor";
  public supportedFormats: FileFormat[] = [
    {
      name: "Beat Saber Open Replay",
      format: "bsor",
      extension: "bsor",
      mime: "application/x-bsor",
      from: true,
      to: false,
      internal: "bsor"
    },
    CommonFormats.PNG.supported("png", false, true),
    CommonFormats.JPEG.supported("jpeg", false, true),
    CommonFormats.JSON.supported("json", false, true, true)
  ];

  public ready: boolean = true;

  async init() {
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    let frameIndex = 0;
    return (await Promise.all(inputFiles.map(async(file) => {
      const replay = new Replay(file.bytes);
      if(outputFormat.internal == "json") {
        return [{
          name: getBaseName(file.name) + ".json",
          bytes: new TextEncoder().encode(JSON.stringify(replay))
        }];
      }
      let outputs: FileData[] = [];
      await new Promise<void>(resolve => {
        render(replay, 640, 480,
          async(renderer) => {
            const bytes = await canvasToBytes(renderer.domElement, outputFormat.mime);
            outputs.push({
              name: getBaseName(file.name)+"_"+(frameIndex++)+"."+outputFormat.extension,
              bytes: bytes
            });
          },
          async() => resolve()
        );
      })
      return outputs;
    }))).flat();
  }

}

export default bsorHandler;
