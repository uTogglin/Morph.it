import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

class svgForeignObjectHandler implements FormatHandler {

  public name: string = "svgForeignObject";

  public supportedFormats: FileFormat[] = [
    CommonFormats.HTML.supported("html", true, false),
    // Identical to the input HTML, just wrapped in an SVG foreignObject, so it's lossless
    CommonFormats.SVG.supported("svg", false, true, true)
  ];

  public ready: boolean = true;

  async init () {
    this.ready = true;
  }

  static async normalizeHTML (html: string) {
    // To get the size of the input document, we need the browser to actually
    // render it. Render inside a sandboxed iframe with scripting DISABLED so
    // hostile markup (e.g. `<img src=x onerror=...>`) can't execute during
    // conversion. The sandbox grants "allow-same-origin" only — that lets us
    // read the frame's document for measurement/serialization, while the absence
    // of "allow-scripts" keeps inline event handlers and <script> tags inert.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-same-origin");
    iframe.style.visibility = "hidden";
    iframe.style.position = "fixed";
    iframe.style.left = "-99999px";
    iframe.style.top = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    try {
      const doc = iframe.contentDocument;
      if (!doc) throw new Error("Could not access sandboxed iframe document.");

      // Reset default margins; display:flow-root on the container so child
      // margins are contained in the measured bounding box (matches the previous
      // shadow-DOM behaviour). Built via DOM APIs to avoid deprecated document.write.
      const style = doc.createElement("style");
      style.textContent = "html,body{margin:0;padding:0;}#__svgfo{display:flow-root;}";
      doc.head.appendChild(style);

      const container = doc.createElement("div");
      container.id = "__svgfo";
      doc.body.appendChild(container);
      container.innerHTML = html;

      // Wait for images/videos to finish loading so layout is final — but cap
      // the wait so a hung resource can't stall the conversion. The listeners are
      // registered from this (scripted) context; the iframe itself stays unscripted.
      const media = container.querySelectorAll("img, video");
      const mediaLoaded = Promise.all(Array.from(media).map(el => new Promise<void>(resolve => {
        el.addEventListener("load", () => resolve());
        el.addEventListener("loadeddata", () => resolve());
        el.addEventListener("error", () => resolve());
      })));
      await Promise.race([mediaLoaded, new Promise(resolve => setTimeout(resolve, 3000))]);

      // Make sure the browser has had time to render.
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      // Finally, get the bounding box of the input and serialize it to XML.
      const bbox = container.getBoundingClientRect();
      const xml = new XMLSerializer().serializeToString(container);

      return { xml, bbox };
    } finally {
      iframe.remove();
    }
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    if (inputFormat.internal !== "html") throw "Invalid input format.";
    if (outputFormat.internal !== "svg") throw "Invalid output format.";

    const outputFiles: FileData[] = [];

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    for (const inputFile of inputFiles) {
      const { name, bytes } = inputFile;
      const html = decoder.decode(bytes);
      const { xml, bbox } = await svgForeignObjectHandler.normalizeHTML(html);
      const svg = (
        `<svg width="${bbox.width}" height="${bbox.height}" xmlns="http://www.w3.org/2000/svg">
        <foreignObject x="0" y="0" width="${bbox.width}" height="${bbox.height}">
        ${xml}
        </foreignObject>
        </svg>`);
      const outputBytes = encoder.encode(svg);
      const newName = (name.endsWith(".html") ? name.slice(0, -5) : name) + ".svg";
      outputFiles.push({ name: newName, bytes: outputBytes });
    }

    return outputFiles;

  }

}

export default svgForeignObjectHandler;
