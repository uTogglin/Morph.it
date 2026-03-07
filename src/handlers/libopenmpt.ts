import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";
import { cdnFetch, cdnUrl } from "../cdn.ts";
import { buildWav } from "../utils/build-wav.ts";
import { getBaseName } from "../utils/file-utils.ts";

interface LibOpenMPTModule {
  __render(fileData: Uint8Array, sampleRate: number): Int16Array;
}

const TRACKER_FORMATS: Array<{ ext: string; name: string; mime?: string }> = [
  { ext: "mptm", name: "OpenMPT Module" },
  { ext: "mod",  name: "Amiga MOD",                                   mime: "audio/x-mod" },
  { ext: "s3m",  name: "Scream Tracker 3 Module",                     mime: "audio/x-s3m" },
  { ext: "xm",   name: "FastTracker 2 Extended Module",               mime: "audio/x-xm"  },
  { ext: "it",   name: "Impulse Tracker Module",                      mime: "audio/x-it"  },
  { ext: "667",  name: "UNIS 669 Composer Module" },
  { ext: "669",  name: "UNIS 669 Composer Module" },
  { ext: "amf",  name: "ASYLUM / DSMI Advanced Module Format" },
  { ext: "ams",  name: "Extreme Tracker / Velvet Studio Module" },
  { ext: "c67",  name: "CDFM / Composer 670 Module" },
  { ext: "cba",  name: "Chuck Biscuits AmigaTracker Module" },
  { ext: "dbm",  name: "DigiBooster Pro Module" },
  { ext: "digi", name: "Digital Tracker Module" },
  { ext: "dmf",  name: "X-Tracker Module" },
  { ext: "dsm",  name: "DSIK Module" },
  { ext: "dsym", name: "Digital Symphony Module" },
  { ext: "dtm",  name: "Digital Tracker Module" },
  { ext: "etx",  name: "Estrayk Tracker Module" },
  { ext: "far",  name: "Farandole Composer Module" },
  { ext: "fc",   name: "Future Composer Module" },
  { ext: "fc13", name: "Future Composer 1.3 Module" },
  { ext: "fc14", name: "Future Composer 1.4 Module" },
  { ext: "fmt",  name: "FM Tracker Module" },
  { ext: "fst",  name: "Future Composer BSI Module" },
  { ext: "ftm",  name: "Face The Music Module" },
  { ext: "gdm",  name: "General Digital Music Module" },
  { ext: "gmc",  name: "Game Music Creator Module" },
  { ext: "gtk",  name: "Graoumf Tracker Module" },
  { ext: "gt2",  name: "Graoumf Tracker 2 Module" },
  { ext: "ice",  name: "Imago Orpheus Module" },
  { ext: "imf",  name: "Imago Orpheus Module" },
  { ext: "ims",  name: "Images Music System Module" },
  { ext: "j2b",  name: "GALAXY Music System / Jazz Jackrabbit 2 Module" },
  { ext: "m15",  name: "Ultimate Soundtracker Module" },
  { ext: "mdl",  name: "DigiTrakker Module" },
  { ext: "med",  name: "OctaMED Module" },
  { ext: "mmcmp",name: "Memory Music Compression Module" },
  { ext: "mms",  name: "MultiMedia Sound Module" },
  { ext: "mo3",  name: "MO3 Module",                                  mime: "audio/x-mo3" },
  { ext: "mt2",  name: "MadTracker 2 Module" },
  { ext: "mtm",  name: "MultiTracker Module" },
  { ext: "mus",  name: "Doom / Heretic / Hexen MUS Module" },
  { ext: "nst",  name: "NoiseTracker Module" },
  { ext: "okt",  name: "Oktalyzer Module" },
  { ext: "oxm",  name: "OpenXM Module" },
  { ext: "plm",  name: "Disorder Tracker 2 Module" },
  { ext: "psm",  name: "Protracker Studio Module" },
  { ext: "pt36", name: "Protracker 3.6 Module" },
  { ext: "ptm",  name: "PolyTracker Module" },
  { ext: "puma", name: "Puma Tracker Module" },
  { ext: "ppm",  name: "Disorder Tracker Module" },
  { ext: "rtm",  name: "Real Tracker Module" },
  { ext: "sfx",  name: "SoundFX Module" },
  { ext: "sfx2", name: "SoundFX 2 Module" },
  { ext: "smod", name: "Soundtracker Module" },
  { ext: "st26", name: "Soundtracker 2.6 Module" },
  { ext: "stk",  name: "Soundtracker Module" },
  { ext: "stm",  name: "Scream Tracker 2 Module" },
  { ext: "stx",  name: "Scream Tracker Music Interface Kit" },
  { ext: "stp",  name: "Soundtracker Pro II Module" },
  { ext: "symmod",name: "Symphonie Module" },
  { ext: "tcb",  name: "TC Browser Module" },
  { ext: "ult",  name: "UltraTracker Module" },
  { ext: "umx",  name: "Unreal Music Package" },
  { ext: "unic", name: "UNIC Tracker Module" },
  { ext: "wow",  name: "Grave Composer Module" },
  { ext: "xmf",  name: "Extensible Music Format" },
  { ext: "xpk",  name: "XPKF/SQSH Compressed Module" },
];

const SAMPLE_RATE = 48000;

class libopenmptHandler implements FormatHandler {

  public name: string = "libopenmpt";
  public supportedFormats: FileFormat[] = [];
  public ready: boolean = false;

  #module?: LibOpenMPTModule;

  async init (): Promise<void> {
    // Pre-fetch the WASM binary so the Emscripten module can use it directly.
    const wasmBinary = await cdnFetch("libopenmptWasm")
      .then(r => r.arrayBuffer());

    // Set the global that Emscripten picks up:
    //   var Module = typeof libopenmpt != "undefined" ? libopenmpt : {}
    // libopenmpt.js was patched to attach __readyPromise (resolves with Module)
    // and __render (uses closure-scoped HEAPU8/HEAP16) before calling run().
    (globalThis as any).libopenmpt = { wasmBinary };

    // Load as a classic <script> tag so it is never run through Rollup/Vite's
    // module pipeline (which would break the Emscripten global-variable pattern).
    const libopenmptJsUrl = await cdnUrl("libopenmptJs");
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = libopenmptJsUrl;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load libopenmpt.js"));
      document.head.appendChild(script);
    });

    // __readyPromise was attached by our libopenmpt.js patch and resolves with
    // the Module object once onRuntimeInitialized fires.
    this.#module = await (globalThis as any).libopenmpt.__readyPromise;

    for (const fmt of TRACKER_FORMATS) {
      this.supportedFormats.push({
        name: fmt.name,
        format: fmt.ext,
        extension: fmt.ext,
        mime: fmt.mime ?? `audio/x-${fmt.ext}`,
        from: true,
        to: false,
        internal: fmt.ext,
        category: "audio",
        lossless: true
      });
    }

    this.supportedFormats.push(CommonFormats.WAV.builder("wav").allowTo().markLossless());

    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    _outputFormat: FileFormat
  ): Promise<FileData[]> {
    if (!this.ready || !this.#module) throw "Handler not initialized.";

    const mod = this.#module;
    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {
      const bytes = new Uint8Array(inputFile.bytes);
      const pcmData = mod.__render(bytes, SAMPLE_RATE);
      const pcmBytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
      const wavBytes = buildWav(pcmBytes, SAMPLE_RATE, 2, 16);
      const name = getBaseName(inputFile.name) + ".wav";
      outputFiles.push({ bytes: wavBytes, name });
    }

    return outputFiles;
  }

}

export default libopenmptHandler;
