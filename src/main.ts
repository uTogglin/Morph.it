import type { FileFormat, FileData, FormatHandler, ConvertPathNode } from "./FormatHandler.js";
import normalizeMimeType from "./normalizeMimeType.js";
import { prescanFiles, getCachedDetectedMime, isZipBasedExtension } from "./utils/detect-format.js";
import handlers from "./handlers";
import { TraversionGraph, type DeadRoute } from "./TraversionGraph.js";
import JSZip from "jszip";
import { gzip as pakoGzip } from "pako";
import { createTar } from "./handlers/archive.js";
import { applyFileCompression } from "./compress.js";
import { processVideo, probeVideoInfo, extractSubtitles, addSubtitlesToVideo, mergeVideos } from "./video-editor.js";
import type { SubtitleStreamInfo } from "./video-editor.js";
import { generateSubtitles } from "./subtitle-generator.js";
import { initSpeechTool } from "./speech-tool.js";
import { initSummarizeTool } from "./summarize-tool.js";
import { initOcrTool } from "./ocr-tool.js";
import { initPdfEditorTool } from "./pdf-editor-tool.js";
import { cachedFetch, requestPersistentStorage, showCachePrompt, clearModelCache, applyHfCachePolicy } from "./cached-fetch.js";
import { cdnFetch } from "./cdn.js";

// ── In-app console log capture ─────────────────────────────────────────────
interface AppLogEntry { level: "error" | "warn" | "info"; msg: string; time: string; }
const appLogBuffer: AppLogEntry[] = [];

function _fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
  if (typeof a === "object" && a !== null) { try { return JSON.stringify(a, null, 2); } catch { return String(a); } }
  return String(a);
}

let _errorCount = 0;
function _appendAppLog(level: AppLogEntry["level"], args: unknown[]) {
  const msg = args.map(_fmtArg).join(" ");
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => n.toString().padStart(2, "0")).join(":");
  const entry: AppLogEntry = { level, msg, time };
  appLogBuffer.push(entry);
  if (appLogBuffer.length > 1000) appLogBuffer.splice(0, appLogBuffer.length - 1000);
  if (level === "error") _errorCount++;
  const badge = document.getElementById("log-badge");
  if (badge) {
    badge.textContent = String(_errorCount);
    badge.classList.toggle("hidden", _errorCount === 0);
  }
  const list = document.getElementById("app-log-list");
  if (list) {
    // Prepend new entry instead of full rebuild
    const empty = list.querySelector(".app-log-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = `app-log-row app-log-${entry.level}`;
    const timeEl = document.createElement("span"); timeEl.className = "app-log-time"; timeEl.textContent = entry.time;
    const lbl = document.createElement("span"); lbl.className = "app-log-level"; lbl.textContent = entry.level.toUpperCase();
    const msgEl = document.createElement("span"); msgEl.className = "app-log-msg"; msgEl.textContent = entry.msg;
    row.append(timeEl, lbl, msgEl);
    list.prepend(row);
  }
}

function _renderAppLogInto(list: HTMLElement) {
  list.innerHTML = "";
  if (appLogBuffer.length === 0) {
    const empty = document.createElement("p");
    empty.className = "app-log-empty";
    empty.textContent = "No activity logged yet.";
    list.appendChild(empty);
    return;
  }
  for (const entry of [...appLogBuffer].reverse()) {
    const row = document.createElement("div");
    row.className = `app-log-row app-log-${entry.level}`;
    const time = document.createElement("span"); time.className = "app-log-time"; time.textContent = entry.time;
    const lbl  = document.createElement("span"); lbl.className  = "app-log-level"; lbl.textContent = entry.level.toUpperCase();
    const msgEl = document.createElement("span"); msgEl.className = "app-log-msg"; msgEl.textContent = entry.msg;
    row.append(time, lbl, msgEl);
    list.appendChild(row);
  }
}

const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);
console.error = (...args: unknown[]) => { _origConsoleError(...args); _appendAppLog("error", args); };
console.warn  = (...args: unknown[]) => { _origConsoleWarn(...args);  _appendAppLog("warn",  args); };
// ──────────────────────────────────────────────────────────────────────────────

/** Read a setting from localStorage with JSON.parse, returning fallback on missing key or parse error */
function loadSetting<T>(key: string, fallback: T): T {
  try {
    const val = localStorage.getItem(key);
    if (val === null) return fallback;
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

/** Files currently selected for conversion */
let selectedFiles: File[] = [];
/**
 * Whether to use "simple" mode.
 * - In **simple** mode, the input/output lists are grouped by file format.
 * - In **advanced** mode, these lists are grouped by format handlers, which
 *   requires the user to manually select the tool that processes the output.
 */
let simpleMode: boolean = true;

/** Auto-download: when true, files download immediately; when false, only appear in output tray */
let autoDownload: boolean = loadSetting("convert-auto-download", true);

/** Archive multi-file output: when true, multiple converted files are zipped; when false, downloaded separately */
let archiveMultiOutput: boolean = loadSetting("convert-archive-multi", true);

/** Apply edits to all files: when true, current settings are applied to every loaded file during processing */
let applyAll: boolean = loadSetting("convert-apply-all", false);

/** Remove background: when true, image outputs have their background removed */
let removeBg: boolean = loadSetting("convert-remove-bg", false);

/** Background removal mode: "local" uses RMBG-1.4, "api" uses remove.bg */
let bgMode: "local" | "api" = (() => {
  try { return localStorage.getItem("convert-bg-mode") === "api" ? "api" : "local"; } catch { return "local" as const; }
})();

/** remove.bg API key */
let bgApiKey: string = (() => {
  try { return localStorage.getItem("convert-bg-api-key") ?? ""; } catch { return ""; }
})();

/** Correction: when true, preserves text/graphics during background removal */
let bgCorrection: boolean = loadSetting("convert-bg-correction", false);

/** Image rescaling settings */
let rescaleEnabled: boolean = loadSetting("convert-rescale", false);
let rescaleWidth: number = (() => {
  try { return parseInt(localStorage.getItem("convert-rescale-width") ?? "0") || 0; } catch { return 0; }
})();
let rescaleHeight: number = (() => {
  try { return parseInt(localStorage.getItem("convert-rescale-height") ?? "0") || 0; } catch { return 0; }
})();
let rescaleLockRatio: boolean = loadSetting("convert-rescale-lock", true);

/** Inpainting (object removal) settings */
let inpaintEnabled: boolean = loadSetting("convert-inpaint", false);
let inpaintFeather: boolean = loadSetting("convert-inpaint-feather", false);
let inpaintModel: "migan" | "lama" = (() => {
  try { const v = localStorage.getItem("convert-inpaint-model"); return v === "lama" ? "lama" : "migan"; } catch { return "migan" as const; }
})();

/** OpenRouter API key for AI image generation */
let openrouterApiKey: string = (() => {
  try { return localStorage.getItem("convert-openrouter-key") ?? ""; } catch { return ""; }
})();

/** Inpainting session state */
let inpaintSession: any = null;
let inpaintSessionModel: string = "";

/** Privacy mode: strips metadata and randomizes filenames for API calls */
let privacyMode: boolean = loadSetting("convert-privacy", false);

/** Compression: compress output files to fit a target size or re-encode for quality */
let compressEnabled: boolean = loadSetting("convert-compress", false);
let compressTargetMB: number = (() => {
  try { return parseFloat(localStorage.getItem("convert-compress-target") ?? "0") || 0; } catch { return 0; }
})();
let compressMode: "auto" | "lossy" = (() => {
  try { return localStorage.getItem("convert-compress-mode") === "lossy" ? "lossy" : "auto"; } catch { return "auto" as const; }
})();
let compressCodec: "h264" | "h265" = (() => {
  try {
    const v = localStorage.getItem("convert-compress-codec");
    return v === "h265" ? v : "h264";
  } catch { return "h264" as const; }
})();
let compressSpeed: "fast" | "balanced" | "quality" = (() => {
  try {
    const v = localStorage.getItem("convert-compress-speed");
    if (v === "fast" || v === "balanced") return v;
    return "balanced";
  } catch { return "balanced" as const; }
})();
let compressWebmMode: boolean = loadSetting("convert-compress-webm", false);
/** Default TTS voice */
let ttsVoiceDefault: string = (() => {
  try { return localStorage.getItem("convert-tts-voice") ?? "af_heart"; } catch { return "af_heart"; }
})();

/** Default TTS speed */
let ttsSpeedDefault: string = (() => {
  try { return localStorage.getItem("convert-tts-speed") ?? "1"; } catch { return "1"; }
})();

/** Default STT model */
let sttModelDefault: string = (() => {
  try { return localStorage.getItem("convert-stt-model") ?? "base"; } catch { return "base"; }
})();

/** Default STT language */
let sttLanguageDefault: string = (() => {
  try { return localStorage.getItem("convert-stt-language") ?? ""; } catch { return ""; }
})();

/** Default summarize word limit */
let sumWordLimitDefault: string = (() => {
  try { return localStorage.getItem("convert-sum-word-limit") ?? "150"; } catch { return "150"; }
})();

/** Queue for mixed-category batch conversion */
let conversionQueue: File[][] = [];
let currentQueueIndex = 0;
/** True when all uploaded files share the same media category */
let isSameCategoryBatch = false;
/** All files from the original upload (before queue splitting) */
let allUploadedFiles: File[] = [];

/** Name of the folder picked via "Open Folder", or null if files were added individually */
let activeFolderName: string | null = null;

/** Image tools state */
let imgToolFiles: File[] = [];
let imgActiveIndex: number = 0;
let imgProcessedData: Map<number, FileData> = new Map();
let imgOriginalUrls: Map<number, string> = new Map();
let imgProcessedUrls: Map<number, string> = new Map();
let imgShowAfter: boolean = false;
let miniPaintReady: boolean = false;

/** Video editor state */
let vidFiles: File[] = [];
let vidActiveIndex: number = 0;
let vidProcessedResults: Map<number, FileData> = new Map();
let vidThumbUrls: Map<number, string> = new Map();
let vidFile: File | null = null;
let vidDuration: number = 0;
let vidTrimStart: number = 0;
let vidTrimEnd: number = 0;
let vidRemoveAudio: boolean = false;
let vidRemoveSubtitles: boolean = false;
let vidHasAudio: boolean = false;
let vidHasSubtitles: boolean = false;
let vidSubtitleCount: number = 0;
let vidProcessedData: FileData | null = null;
let vidObjectUrl: string | null = null;
let vidProcessedUrl: string | null = null;
let vidIsProcessing: boolean = false;
let vidSubStreams: SubtitleStreamInfo[] = [];
let vidSubFile: File | null = null;
let vidAddSubMux: boolean = false;
let vidAddSubBurn: boolean = false;
const vidEqFreqs = [60, 230, 910, 3600, 14000];
let vidEqBands: number[] = [0, 0, 0, 0, 0];

/** Crop state */
let vidCropEnabled: boolean = false;
let vidCropX: number = 0;
let vidCropY: number = 0;
let vidCropW: number = 0;
let vidCropH: number = 0;
let vidOrigWidth: number = 0;
let vidOrigHeight: number = 0;
let vidCropPreset: string = "";
let vidCropLockRatio: boolean = false;

/** Merge state */
let vidMergeFiles: File[] = [];
let vidMergeReEncode: boolean = false;

/** Clear cached processed video data and revoke its object URL */
function vidInvalidateProcessed() {
  vidProcessedData = null;
  if (vidProcessedUrl) { URL.revokeObjectURL(vidProcessedUrl); vidProcessedUrl = null; }
  vidUpdateActionButton();
}

/** Returns the broad media category from a file's MIME type.
 *  Prefers magic-byte detected MIME when available. */
function getMediaCategory(file: File): string {
  const detectedMime = getCachedDetectedMime(file);
  const mime = detectedMime || file.type;
  return mime.split("/")[0] || "unknown";
}

/** Finds the matching allOptions entry for a file (O(1) MIME lookup via Map).
 *  Prefers magic-byte detected MIME over browser-reported MIME for more
 *  reliable detection of files with wrong or missing extensions. */
function findInputOption(file: File): { format: FileFormat; handler: FormatHandler } | null {
  const browserMime = normalizeMimeType(file.type);
  const ext = file.name.split(".").pop()?.toLowerCase();
  const detectedMime = getCachedDetectedMime(file);

  // Determine effective MIME: prefer magic bytes, but for ZIP-based
  // containers (DOCX, XLSX, etc.) defer to extension-based detection
  // since they all share the PK\x03\x04 signature.
  let effectiveMime = browserMime;
  if (detectedMime) {
    const normalizedDetected = normalizeMimeType(detectedMime);
    if (normalizedDetected === "application/zip" && isZipBasedExtension(ext)) {
      // ZIP-based container: trust the extension / browser MIME instead
      effectiveMime = browserMime;
    } else if (normalizedDetected !== browserMime) {
      console.info(
        `[magic-bytes] Overriding MIME for "${file.name}": ` +
        `browser="${browserMime}" → detected="${normalizedDetected}"`
      );
      effectiveMime = normalizedDetected;
    }
  }

  const matches = mimeToOptions.get(effectiveMime);
  if (!matches || matches.length === 0) {
    // Fall back to extension match
    return allOptions.find(o => o.format.from && o.format.extension?.toLowerCase() === ext) || null;
  }
  if (matches.length > 1 && ext) {
    const extMatch = matches.find(o => o.format.extension?.toLowerCase() === ext);
    if (extMatch) return extMatch;
  }
  return matches[0];
}

/** Handlers that support conversion from any formats. */
const conversionsFromAnyInput: ConvertPathNode[] = handlers
.filter(h => h.supportAnyInput && h.supportedFormats)
.flatMap(h => h.supportedFormats!
  .filter(f => f.to)
  .map(f => ({ handler: h, format: f})))

const ui = {
  fileInput: document.querySelector("#file-input") as HTMLInputElement,
  fileSelectArea: document.querySelector("#file-area") as HTMLDivElement,
  convertButton: document.querySelector("#convert-button") as HTMLButtonElement,
  modeToggleButton: document.querySelector("#mode-button") as HTMLButtonElement,
  inputList: document.querySelector("#from-list") as HTMLDivElement,
  outputList: document.querySelector("#to-list") as HTMLDivElement,
  inputSearch: document.querySelector("#search-from") as HTMLInputElement,
  outputSearch: document.querySelector("#search-to") as HTMLInputElement,
  popupBox: document.querySelector("#popup") as HTMLDivElement,
  popupBackground: document.querySelector("#popup-bg") as HTMLDivElement,
  archivePanel: document.querySelector("#archive-panel") as HTMLDivElement,
  archiveFmtBtns: document.querySelectorAll(".archive-fmt-btn") as NodeListOf<HTMLButtonElement>,
  createArchiveBtn: document.querySelector("#create-archive-btn") as HTMLButtonElement,
  themeToggle: document.querySelector("#theme-toggle") as HTMLButtonElement,
  logsToggle: document.querySelector("#logs-toggle") as HTMLButtonElement,
  logsPopout: document.querySelector("#logs-popout") as HTMLDivElement,
  logsOverlay: document.querySelector("#logs-overlay") as HTMLDivElement,
  settingsToggle: document.querySelector("#settings-toggle") as HTMLButtonElement,
  settingsModal: document.querySelector("#settings-modal") as HTMLDivElement,
  settingsOverlay: document.querySelector("#settings-overlay") as HTMLDivElement,
  accentColors: document.querySelectorAll(".color-dot") as NodeListOf<HTMLButtonElement>,
  customAccent: document.querySelector("#custom-accent") as HTMLInputElement,
  autoDownloadToggle: document.querySelector("#auto-download-toggle") as HTMLButtonElement,
  archiveMultiToggle: document.querySelector("#archive-multi-toggle") as HTMLButtonElement,
  removeBgToggle: document.querySelector("#remove-bg-toggle") as HTMLButtonElement,
  bgModeToggle: document.querySelector("#bg-mode-toggle") as HTMLButtonElement,
  bgCorrectionToggle: document.querySelector("#bg-correction-toggle") as HTMLButtonElement,
  bgApiKeyRow: document.querySelector("#bg-api-key-row") as HTMLDivElement,
  bgApiKeyInput: document.querySelector("#bg-api-key") as HTMLInputElement,
  rescaleToggle: document.querySelector("#rescale-toggle") as HTMLButtonElement,
  rescaleOptions: document.querySelector("#rescale-options") as HTMLDivElement,
  rescaleWidthInput: document.querySelector("#rescale-width") as HTMLInputElement,
  rescaleHeightInput: document.querySelector("#rescale-height") as HTMLInputElement,
  rescaleLockInput: document.querySelector("#rescale-lock-ratio") as HTMLInputElement,
  privacyToggle: document.querySelector("#privacy-toggle") as HTMLButtonElement,
  cacheModelsToggle: document.querySelector("#cache-models-toggle") as HTMLButtonElement,
  aiDeviceSelect: document.querySelector("#sm-ai-device") as HTMLSelectElement,
  compressOptions: document.querySelector("#compress-options") as HTMLDivElement,
  compressTargetInput: document.querySelector("#compress-target-mb") as HTMLInputElement,
  compressPresetSelect: document.querySelector("#compress-preset-select") as HTMLSelectElement,
  codecPresetBtns: document.querySelectorAll(".codec-preset-btn") as NodeListOf<HTMLButtonElement>,
  codecHint: document.querySelector("#codec-hint") as HTMLParagraphElement,
  speedPresetBtns: document.querySelectorAll(".speed-preset-btn") as NodeListOf<HTMLButtonElement>,
  webmModeToggle: document.querySelector("#webm-mode-toggle") as HTMLButtonElement,
  webmHint: document.querySelector("#webm-hint") as HTMLParagraphElement,
  outputTray: document.querySelector("#output-tray") as HTMLDivElement,
  outputTrayGrid: document.querySelector("#output-tray-grid") as HTMLDivElement,
  downloadAllBtn: document.querySelector("#download-all-btn") as HTMLButtonElement,
  clearOutputBtn: document.querySelector("#clear-output-btn") as HTMLButtonElement,
  homePage: document.querySelector("#home-page") as HTMLElement,
  backToHome: document.querySelector("#back-to-home") as HTMLButtonElement,
  // Image tools UI
  imgDropZone: document.querySelector("#img-drop-zone") as HTMLDivElement,
  imgFrame: document.querySelector("#minipaint-frame") as HTMLIFrameElement,
  imgEditorContainer: document.querySelector("#img-editor-container") as HTMLDivElement,
  imgFileInput: document.querySelector("#img-file-input") as HTMLInputElement,
  imgInpaintModelToggle: document.querySelector("#inpaint-model-toggle") as HTMLButtonElement,
  imgInpaintFeatherToggle: document.querySelector("#inpaint-feather-toggle") as HTMLButtonElement,
  openrouterApiKeyInput: document.querySelector("#openrouter-api-key") as HTMLInputElement,
  // Video editor UI
  vidCanvas: document.querySelector("#vid-canvas") as HTMLDivElement,
  vidDropPrompt: document.querySelector("#vid-drop-prompt") as HTMLDivElement,
  vidPreview: document.querySelector("#vid-preview") as HTMLVideoElement,
  vidWorkspace: document.querySelector("#vid-workspace") as HTMLDivElement,
  vidPlayBtn: document.querySelector("#vid-play-btn") as HTMLButtonElement,
  vidTimeDisplay: document.querySelector("#vid-time-display") as HTMLSpanElement,
  vidTrimInfo: document.querySelector("#vid-trim-info") as HTMLSpanElement,
  vidTimeline: document.querySelector(".vid-timeline") as HTMLDivElement,
  vidTrimRegion: document.querySelector(".vid-trim-region") as HTMLDivElement,
  vidHandleLeft: document.querySelector(".vid-handle-left") as HTMLDivElement,
  vidHandleRight: document.querySelector(".vid-handle-right") as HTMLDivElement,
  vidPlayhead: document.querySelector(".vid-playhead") as HTMLDivElement,
  vidTrimCollapsible: document.querySelector("#vid-trim-collapsible") as HTMLDivElement,
  vidTrimColToggle: document.querySelector("#vid-trim-col-toggle") as HTMLButtonElement,
  vidTrimStartInput: document.querySelector("#vid-trim-start") as HTMLInputElement,
  vidTrimEndInput: document.querySelector("#vid-trim-end") as HTMLInputElement,
  vidTrimReset: document.querySelector("#vid-trim-reset") as HTMLButtonElement,
  vidRemoveAudioToggle: document.querySelector("#vid-remove-audio") as HTMLButtonElement,
  vidSubsCollapsible: document.querySelector("#vid-subs-collapsible") as HTMLDivElement,
  vidSubsColToggle: document.querySelector("#vid-subs-col-toggle") as HTMLButtonElement,
  vidExtractSubs: document.querySelector("#vid-extract-subs") as HTMLButtonElement,
  vidRemoveSubsToggle: document.querySelector("#vid-remove-subs") as HTMLButtonElement,
  vidGenerateSubs: document.querySelector("#vid-generate-subs") as HTMLButtonElement,
  vidGenerateProgress: document.querySelector("#vid-generate-progress") as HTMLDivElement,
  vidProgressFill: document.querySelector(".vid-progress-fill") as HTMLDivElement,
  vidProgressText: document.querySelector(".vid-progress-text") as HTMLSpanElement,
  vidDownloadBtn: document.querySelector("#vid-download-btn") as HTMLButtonElement,
  vidFileInput: document.querySelector("#vid-file-input") as HTMLInputElement,
  vidVolumeSlider: document.querySelector("#vid-volume-slider") as HTMLInputElement,
  vidSubLangSelect: document.querySelector("#vid-sub-lang") as HTMLSelectElement,
  vidAddSubsToggle: document.querySelector("#vid-add-subs-toggle") as HTMLButtonElement,
  vidAddSubsCollapsible: document.querySelector("#vid-add-subs-collapsible") as HTMLDivElement,
  vidSubFileBtn: document.querySelector("#vid-sub-file-btn") as HTMLButtonElement,
  vidSubFileName: document.querySelector("#vid-sub-file-name") as HTMLSpanElement,
  vidMuxToggle: document.querySelector("#vid-mux-toggle") as HTMLButtonElement,
  vidBurnToggle: document.querySelector("#vid-burn-toggle") as HTMLButtonElement,
  vidSubFileInput: document.querySelector("#vid-sub-file-input") as HTMLInputElement,
  vidGenLangSelect: document.querySelector("#vid-gen-lang") as HTMLSelectElement,
  vidGenModelSelect: document.querySelector("#vid-gen-model") as HTMLSelectElement,
  vidEqCollapsible: document.querySelector("#vid-eq-collapsible") as HTMLDivElement,
  vidEqToggle: document.querySelector("#vid-eq-toggle") as HTMLButtonElement,
  vidEqSliders: document.querySelectorAll(".vid-eq-slider") as NodeListOf<HTMLInputElement>,
  vidEqValues: document.querySelectorAll(".vid-eq-value") as NodeListOf<HTMLSpanElement>,
  vidEqReset: document.querySelector("#vid-eq-reset") as HTMLButtonElement,
  vidFullscreenBtn: document.querySelector("#vid-fullscreen-btn") as HTMLButtonElement,
  vidCanvasCol: document.querySelector("#vid-canvas-col") as HTMLDivElement,
  // Crop UI
  vidCropToggle: document.querySelector("#vid-crop-toggle") as HTMLButtonElement,
  vidCropLockRatioToggle: document.querySelector("#vid-crop-lock-ratio") as HTMLButtonElement,
  vidCropOverlay: document.querySelector("#vid-crop-overlay") as HTMLDivElement,
  vidCropBox: document.querySelector("#vid-crop-box") as HTMLDivElement,
  vidCropPresets: document.querySelectorAll(".vid-crop-preset") as NodeListOf<HTMLButtonElement>,
  vidCropManualCollapsible: document.querySelector("#vid-crop-manual-collapsible") as HTMLDivElement,
  vidCropManualToggle: document.querySelector("#vid-crop-manual-toggle") as HTMLButtonElement,
  vidCropXInput: document.querySelector("#vid-crop-x") as HTMLInputElement,
  vidCropYInput: document.querySelector("#vid-crop-y") as HTMLInputElement,
  vidCropWInput: document.querySelector("#vid-crop-w") as HTMLInputElement,
  vidCropHInput: document.querySelector("#vid-crop-h") as HTMLInputElement,
  vidCropInfo: document.querySelector("#vid-crop-info") as HTMLSpanElement,
  vidCropReset: document.querySelector("#vid-crop-reset") as HTMLButtonElement,
  // Merge UI
  vidMergeCollapsible: document.querySelector("#vid-merge-collapsible") as HTMLDivElement,
  vidMergeToggle: document.querySelector("#vid-merge-toggle") as HTMLButtonElement,
  vidMergeList: document.querySelector("#vid-merge-list") as HTMLDivElement,
  vidMergeAdd: document.querySelector("#vid-merge-add") as HTMLButtonElement,
  vidMergeReEncode: document.querySelector("#vid-merge-reencode") as HTMLButtonElement,
  vidMergeFileInput: document.querySelector("#vid-merge-file-input") as HTMLInputElement,
  // Video settings panel prefs
  vidPrefRemoveAudio: document.querySelector("#vid-pref-remove-audio") as HTMLButtonElement,
  vidPrefRemoveSubs: document.querySelector("#vid-pref-remove-subs") as HTMLButtonElement,
  vidPrefMux: document.querySelector("#vid-pref-mux") as HTMLButtonElement,
  vidPrefBurn: document.querySelector("#vid-pref-burn") as HTMLButtonElement,
  vidPrefGenModel: document.querySelector("#vid-pref-gen-model") as HTMLSelectElement,
  vidPrefGenLang: document.querySelector("#vid-pref-gen-lang") as HTMLSelectElement,
  // Multi-video filmstrip
  vidFilmstrip: document.querySelector("#vid-filmstrip") as HTMLDivElement,
  vidFilmstripGrid: document.querySelector("#vid-filmstrip-grid") as HTMLDivElement,
  vidAddMore: document.querySelector("#vid-add-more") as HTMLButtonElement,
  applyAllToggle: document.querySelector("#apply-all-toggle") as HTMLButtonElement,
  // Speech settings panel
  smTtsVoice: document.querySelector("#sm-tts-voice") as HTMLSelectElement,
  smTtsSpeed: document.querySelector("#sm-tts-speed") as HTMLInputElement,
  smTtsSpeedLabel: document.querySelector("#sm-tts-speed-label") as HTMLSpanElement,
  smSttModel: document.querySelector("#sm-stt-model") as HTMLSelectElement,
  smSttLanguage: document.querySelector("#sm-stt-language") as HTMLSelectElement,
  // Summarize settings panel
  smSumModel: document.querySelector("#sm-sum-model") as HTMLSelectElement,
  smSumWordLimit: document.querySelector("#sm-sum-word-limit") as HTMLInputElement,
  smSumCorsProxy: document.querySelector("#sm-sum-cors-proxy") as HTMLButtonElement,
  // Compress tool UI
  compressDropZone: document.querySelector("#compress-drop-zone") as HTMLDivElement,
  compressWorkspace: document.querySelector("#compress-workspace") as HTMLDivElement,
  compressFileList: document.querySelector("#compress-file-list") as HTMLDivElement,
  compressFileInput: document.querySelector("#compress-file-input") as HTMLInputElement,
};

// ── Page transition helper ───────────────────────────────────────────────────
function animatePageIn(el: HTMLElement) {
  el.classList.remove("page-enter");
  void el.offsetWidth; // force reflow so re-adding class restarts animation
  el.classList.add("page-enter");
  el.addEventListener("animationend", () => el.classList.remove("page-enter"), { once: true });
}

// ── Recent file history ─────────────────────────────────────────────────────
interface RecentEntry { name: string; tool: string; time: number; }
const RECENT_KEY = "convert-recent-files";
const RECENT_MAX = 10;

function getRecentFiles(): RecentEntry[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}
function saveRecentFile(name: string, tool: string) {
  const list = getRecentFiles();
  list.unshift({ name, tool, time: Date.now() });
  // Deduplicate by name+tool, keep latest
  const seen = new Set<string>();
  const deduped = list.filter(e => {
    const key = e.name + "|" + e.tool;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(deduped.slice(0, RECENT_MAX))); } catch {}
}

const toolLabels: Record<string, string> = {
  convert: "Convert", compress: "Compress", image: "Image Tools",
  video: "Video Editor", speech: "Text & Speech", summarize: "Summarize",
  ocr: "OCR", "pdf-editor": "PDF Editor",
};
const toolIcons: Record<string, string> = {
  convert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
  compress: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="6" y1="10" x2="18" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="10" y1="18" x2="14" y2="18"/></svg>',
  image: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  video: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  speech: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  summarize: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  ocr: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><circle cx="17.5" cy="17.5" r="3.5"/><line x1="22" y1="22" x2="20" y2="20"/></svg>',
  "pdf-editor": '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
};

function renderRecentFiles() {
  const container = document.getElementById("recent-history")!;
  const list = document.getElementById("recent-list")!;
  const entries = getRecentFiles();
  if (entries.length === 0) { container.classList.add("hidden"); return; }
  container.classList.remove("hidden");
  list.innerHTML = "";
  for (const entry of entries) {
    const btn = document.createElement("button");
    btn.className = "recent-item";
    const ago = formatTimeAgo(entry.time);
    btn.innerHTML = `
      <div class="recent-item-icon">${toolIcons[entry.tool] || toolIcons.convert}</div>
      <div class="recent-item-info">
        <div class="recent-item-name">${escapeHtml(entry.name)}</div>
        <div class="recent-item-meta">${escapeHtml(toolLabels[entry.tool] || entry.tool)}</div>
      </div>
      <span class="recent-item-time">${ago}</span>`;
    btn.addEventListener("click", () => showToolView(entry.tool as any));
    list.appendChild(btn);
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function formatTimeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Home page / tool navigation ──────────────────────────────────────────────
/** Which tool view is active, or null when on the home page */
let activeTool: "convert" | "compress" | "image" | "video" | "speech" | "summarize" | "ocr" | "pdf-editor" | null = null;
let ocrTool: { stopTts: () => void };
let speechTool: { stopTts: () => void };

const compressPage = document.querySelector("#compress-page") as HTMLElement;
const imagePage = document.querySelector("#image-page") as HTMLElement;
const videoPage = document.querySelector("#video-page") as HTMLElement;
const speechPage = document.querySelector("#speech-page") as HTMLElement;
const summarizePage = document.querySelector("#summarize-page") as HTMLElement;
const ocrPage = document.querySelector("#ocr-page") as HTMLElement;
const pdfEditorPage = document.querySelector("#pdf-editor-page") as HTMLElement;

function showHomePage() {
  // Clean up tool state when navigating away
  if (activeTool === "compress") compressResetState();
  if (activeTool === "image") imgResetState();
  if (activeTool === "video") vidResetState();
  if (activeTool === "ocr") ocrTool.stopTts();
  if (activeTool === "speech") speechTool.stopTts();
  activeTool = null;
  document.body.classList.add("tool-view-hidden");
  document.body.removeAttribute("data-tool");
  ui.homePage.classList.remove("hidden");
  ui.backToHome.classList.add("hidden");
  compressPage.classList.add("hidden");
  imagePage.classList.add("hidden");
  videoPage.classList.add("hidden");
  speechPage.classList.add("hidden");
  summarizePage.classList.add("hidden");
  ocrPage.classList.add("hidden");
  pdfEditorPage.classList.add("hidden");
  animatePageIn(ui.homePage);
  renderRecentFiles();
}

function showToolView(tool: "convert" | "compress" | "image" | "video" | "speech" | "summarize" | "ocr" | "pdf-editor") {
  // Clean up tool state when switching away
  if (activeTool === "compress" && tool !== "compress") compressResetState();
  if (activeTool === "image" && tool !== "image") imgResetState();
  if (activeTool === "video" && tool !== "video") vidResetState();
  if (activeTool === "ocr" && tool !== "ocr") ocrTool.stopTts();
  if (activeTool === "speech" && tool !== "speech") speechTool.stopTts();
  activeTool = tool;
  document.body.classList.remove("tool-view-hidden");
  document.body.setAttribute("data-tool", tool);
  ui.homePage.classList.add("hidden");
  ui.backToHome.classList.remove("hidden");

  compressPage.classList.add("hidden");
  imagePage.classList.add("hidden");
  videoPage.classList.add("hidden");
  speechPage.classList.add("hidden");
  summarizePage.classList.add("hidden");
  ocrPage.classList.add("hidden");
  pdfEditorPage.classList.add("hidden");

  let pageEl: HTMLElement | null = null;
  if (tool === "compress") {
    compressPage.classList.remove("hidden");
    pageEl = compressPage;
    // Auto-enable compression — always on for compress tool
    if (!compressEnabled) {
      compressEnabled = true;
      try { localStorage.setItem("convert-compress", "true"); } catch {}
    }
    // Show drop zone, hide workspace (fresh state)
    ui.compressDropZone?.classList.remove("hidden");
    ui.compressWorkspace?.classList.add("hidden");
  } else if (tool === "image") {
    imagePage.classList.remove("hidden");
    pageEl = imagePage;
    syncImageSettingsUI();
  } else if (tool === "video") {
    videoPage.classList.remove("hidden");
    pageEl = videoPage;
  } else if (tool === "speech") {
    speechPage.classList.remove("hidden");
    pageEl = speechPage;
  } else if (tool === "summarize") {
    summarizePage.classList.remove("hidden");
    pageEl = summarizePage;
  } else if (tool === "ocr") {
    ocrPage.classList.remove("hidden");
    pageEl = ocrPage;
  } else if (tool === "pdf-editor") {
    pdfEditorPage.classList.remove("hidden");
    pageEl = pdfEditorPage;
  } else if (tool === "convert") {
    pageEl = document.getElementById("file-area");
  }
  if (pageEl) animatePageIn(pageEl);
  updateProcessButton();
}

// Start on the home page
document.body.classList.add("tool-view-hidden");
renderRecentFiles();

// Clear recent history
document.getElementById("recent-clear")?.addEventListener("click", () => {
  try { localStorage.removeItem(RECENT_KEY); } catch {}
  renderRecentFiles();
});

// Back button
ui.backToHome.addEventListener("click", showHomePage);

// Home card clicks
for (const card of document.querySelectorAll<HTMLButtonElement>(".home-card")) {
  card.addEventListener("click", () => {
    const tool = card.dataset.tool as "convert" | "compress" | "image" | "video" | "speech" | "summarize" | "ocr" | "pdf-editor";
    if (tool) showToolView(tool);
  });
}

// Clicking logo goes home
document.querySelector("#logo")?.addEventListener("click", showHomePage);

// Apply caching preference early — before any AI model is loaded.
requestPersistentStorage();
applyHfCachePolicy();

// On first visit, ask user if they want to cache models locally.
showCachePrompt();

// Initialize speech tool
speechTool = initSpeechTool();

// Initialize summarize tool
initSummarizeTool();

// Initialize OCR tool
ocrTool = initOcrTool();

// Initialize PDF Editor tool
initPdfEditorTool();

// ── Speech settings panel ───────────────────────────────────────────────────
// Restore saved values into settings selects
if (ui.smTtsVoice) ui.smTtsVoice.value = ttsVoiceDefault;
if (ui.smTtsSpeed) { ui.smTtsSpeed.value = ttsSpeedDefault; if (ui.smTtsSpeedLabel) ui.smTtsSpeedLabel.textContent = `${parseFloat(ttsSpeedDefault).toFixed(1)}x`; }
if (ui.smSttModel) ui.smSttModel.value = sttModelDefault;
if (ui.smSttLanguage) ui.smSttLanguage.value = sttLanguageDefault;

ui.smTtsVoice?.addEventListener("change", () => {
  ttsVoiceDefault = ui.smTtsVoice.value;
  try { localStorage.setItem("convert-tts-voice", ttsVoiceDefault); } catch {}
  const el = document.getElementById("speech-tts-voice") as HTMLSelectElement | null;
  if (el) el.value = ttsVoiceDefault;
});
ui.smTtsSpeed?.addEventListener("input", () => {
  ttsSpeedDefault = ui.smTtsSpeed.value;
  if (ui.smTtsSpeedLabel) ui.smTtsSpeedLabel.textContent = `${parseFloat(ttsSpeedDefault).toFixed(1)}x`;
  try { localStorage.setItem("convert-tts-speed", ttsSpeedDefault); } catch {}
  const el = document.getElementById("speech-tts-speed") as HTMLInputElement | null;
  const lbl = document.getElementById("speech-tts-speed-label") as HTMLSpanElement | null;
  const disp = document.getElementById("speech-tts-speed-display") as HTMLSpanElement | null;
  const val = `${parseFloat(ttsSpeedDefault).toFixed(1)}x`;
  if (el) el.value = ttsSpeedDefault;
  if (lbl) lbl.textContent = val;
  if (disp) disp.textContent = val;
});
ui.smSttModel?.addEventListener("change", () => {
  sttModelDefault = ui.smSttModel.value;
  try { localStorage.setItem("convert-stt-model", sttModelDefault); } catch {}
  const mic = document.getElementById("speech-stt-mic-model") as HTMLSelectElement | null;
  const file = document.getElementById("speech-stt-file-model") as HTMLSelectElement | null;
  if (mic) mic.value = sttModelDefault;
  if (file) file.value = sttModelDefault;
});
ui.smSttLanguage?.addEventListener("change", () => {
  sttLanguageDefault = ui.smSttLanguage.value;
  try { localStorage.setItem("convert-stt-language", sttLanguageDefault); } catch {}
  const mic = document.getElementById("speech-stt-lang") as HTMLSelectElement | null;
  const file = document.getElementById("speech-stt-file-lang") as HTMLSelectElement | null;
  if (mic) mic.value = sttLanguageDefault;
  if (file) file.value = sttLanguageDefault;
});

// ── Summarize settings panel ─────────────────────────────────────────────────
// Model selector
const sumModelDefault = (() => { try { return localStorage.getItem("convert-sum-model") ?? "distilbart-12-6"; } catch { return "distilbart-12-6"; } })();
if (ui.smSumModel) ui.smSumModel.value = sumModelDefault;
ui.smSumModel?.addEventListener("change", () => {
  try { localStorage.setItem("convert-sum-model", ui.smSumModel.value); } catch {}
});

if (ui.smSumWordLimit) ui.smSumWordLimit.value = sumWordLimitDefault;
ui.smSumWordLimit?.addEventListener("change", () => {
  sumWordLimitDefault = ui.smSumWordLimit.value;
  try { localStorage.setItem("convert-sum-word-limit", sumWordLimitDefault); } catch {}
  const toolInput = document.getElementById("sum-word-limit") as HTMLInputElement | null;
  if (toolInput) toolInput.value = sumWordLimitDefault;
});

// CORS proxy toggle
let sumCorsProxy: boolean = loadSetting("convert-sum-cors-proxy", false);
if (ui.smSumCorsProxy) {
  ui.smSumCorsProxy.classList.toggle("active", sumCorsProxy);
  ui.smSumCorsProxy.addEventListener("click", () => {
    sumCorsProxy = !sumCorsProxy;
    ui.smSumCorsProxy.classList.toggle("active", sumCorsProxy);
    try { localStorage.setItem("convert-sum-cors-proxy", String(sumCorsProxy)); } catch {}
    // Notify summarize-tool module
    window.dispatchEvent(new CustomEvent("sum-cors-proxy-change", { detail: sumCorsProxy }));
  });
}

// ── OCR settings panel ──────────────────────────────────────────────────────
const smOcrLang = document.querySelector("#sm-ocr-lang") as HTMLSelectElement;
const ocrLangDefault = (() => { try { return localStorage.getItem("convert-ocr-lang") ?? "eng"; } catch { return "eng"; } })();
if (smOcrLang) smOcrLang.value = ocrLangDefault;
smOcrLang?.addEventListener("change", () => {
  try { localStorage.setItem("convert-ocr-lang", smOcrLang.value); } catch {}
  const toolSelect = document.getElementById("ocr-lang") as HTMLSelectElement | null;
  if (toolSelect) toolSelect.value = smOcrLang.value;
});

// ── PDF Editor settings panel ──────────────────────────────────────────────
const smPdeBrushSize = document.querySelector("#sm-pde-brush-size") as HTMLInputElement;
const smPdeFontSize = document.querySelector("#sm-pde-font-size") as HTMLInputElement;
const pdeBrushDefault = (() => { try { return localStorage.getItem("convert-pde-brush") ?? "3"; } catch { return "3"; } })();
const pdeFontDefault = (() => { try { return localStorage.getItem("convert-pde-font") ?? "16"; } catch { return "16"; } })();
if (smPdeBrushSize) smPdeBrushSize.value = pdeBrushDefault;
if (smPdeFontSize) smPdeFontSize.value = pdeFontDefault;
smPdeBrushSize?.addEventListener("change", () => {
  try { localStorage.setItem("convert-pde-brush", smPdeBrushSize.value); } catch {}
});
smPdeFontSize?.addEventListener("change", () => {
  try { localStorage.setItem("convert-pde-font", smPdeFontSize.value); } catch {}
});

// ── Settings modal ──────────────────────────────────────────────────────────
const smNavBtns = document.querySelectorAll<HTMLButtonElement>(".sm-nav-btn");
const smPanels = document.querySelectorAll<HTMLDivElement>(".sm-panel");

function openSettings(panel?: string) {
  const sidebar = ui.settingsModal.querySelector(".sm-sidebar") as HTMLElement;
  if (activeTool) {
    // On a tool page: hide sidebar, show only that tool's panel + general
    sidebar.classList.add("hidden");
    ui.settingsModal.classList.add("sm-no-sidebar");
    // Build a simple tab bar for the two panels
    const toolPanel = activeTool === "compress" ? "compress" : activeTool === "image" ? "image" : activeTool === "video" ? "video" : activeTool === "speech" ? "speech" : activeTool === "summarize" ? "summarize" : activeTool === "ocr" ? "ocr" : activeTool === "pdf-editor" ? "pdf-editor" : "convert";
    switchSettingsPanel(panel || toolPanel);
    // Show only relevant nav items
    smNavBtns.forEach(b => {
      const p = b.dataset.panel;
      b.classList.toggle("hidden", p !== toolPanel && p !== "convert");
    });
  } else {
    // Home page: show full sidebar
    sidebar.classList.remove("hidden");
    ui.settingsModal.classList.remove("sm-no-sidebar");
    smNavBtns.forEach(b => b.classList.remove("hidden"));
    if (panel) switchSettingsPanel(panel);
  }
  ui.settingsModal.classList.remove("hidden");
  ui.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  ui.settingsModal.classList.add("hidden");
  ui.settingsOverlay.classList.add("hidden");
}

function switchSettingsPanel(panelName: string) {
  smNavBtns.forEach(b => b.classList.toggle("active", b.dataset.panel === panelName));
  smPanels.forEach(p => {
    // General panel stays visible alongside the active tool panel
    const isGeneral = p.dataset.panel === "convert";
    const isActive = p.dataset.panel === panelName;
    const showAsSecondary = isGeneral && activeTool !== null && panelName !== "convert";
    p.classList.toggle("active", isActive || showAsSecondary);
    p.classList.toggle("sm-general-secondary", showAsSecondary);
  });
}

// Nav button clicks
for (const btn of smNavBtns) {
  btn.addEventListener("click", () => {
    if (btn.dataset.panel) switchSettingsPanel(btn.dataset.panel);
  });
}

// Close on overlay click, close button, or Escape
ui.settingsOverlay.addEventListener("click", closeSettings);
document.getElementById("settings-close-btn")?.addEventListener("click", closeSettings);
window.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    // Priority 1: close settings / logs modals
    if (!ui.settingsModal.classList.contains("hidden")) { closeSettings(); return; }
    if (!ui.logsPopout.classList.contains("hidden")) { closeLogs(); return; }
    // Priority 2: close TTS overlay (back to tool page)
    const ocrTtsOverlay = document.getElementById("ocr-tts-overlay");
    const speechTtsOverlay = document.getElementById("speech-tts-overlay");
    if (activeTool === "ocr" && ocrTtsOverlay && !ocrTtsOverlay.classList.contains("hidden")) { ocrTool.stopTts(); return; }
    if (activeTool === "speech" && speechTtsOverlay && !speechTtsOverlay.classList.contains("hidden")) { speechTool.stopTts(); return; }
    // Priority 3: go back to home from any tool page
    if (activeTool !== null) { showHomePage(); return; }
  }
});

// "Configure settings" links on tool pages
for (const link of document.querySelectorAll<HTMLButtonElement>("[data-open-panel]")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    openSettings(link.dataset.openPanel!);
  });
}

/** Active category filter for input and output lists */
let inputCategoryFilter = "all";
let outputCategoryFilter = "all";

/** Maps a format's category field to a filter group */
function getCategoryGroup(cat: string | string[] | undefined): string {
  const cats = Array.isArray(cat) ? cat : cat ? [cat] : [];
  for (const c of cats) {
    const lc = c.toLowerCase();
    if (lc === "image" || lc === "vector") return "image";
    if (lc === "video") return "video";
    if (lc === "data" || lc === "text") return "code";
  }
  if (cats.length === 0) return "other";
  return "other";
}

/** Applies both text search and category filter to a format list */
function applyCombinedFilter(list: HTMLDivElement, isInput: boolean) {
  const searchStr = (isInput ? ui.inputSearch : ui.outputSearch).value.toLowerCase();
  const activeCat = isInput ? inputCategoryFilter : outputCategoryFilter;

  for (const button of Array.from(list.children)) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const formatIndex = button.getAttribute("format-index");

    // Text match
    let textMatch = true;
    if (searchStr) {
      let hasExtension = false;
      if (formatIndex) {
        const format = allOptions[parseInt(formatIndex)];
        hasExtension = format?.format.extension.toLowerCase().includes(searchStr);
      }
      const hasText = button.textContent!.toLowerCase().includes(searchStr);
      textMatch = hasExtension || hasText;
    }

    // Category match
    let catMatch = true;
    if (activeCat !== "all" && formatIndex) {
      const opt = allOptions[parseInt(formatIndex)];
      catMatch = getCategoryGroup(opt?.format.category) === activeCat;
    }

    button.style.display = (textMatch && catMatch) ? "" : "none";
  }
}

/**
 * Filters a list of butttons to exclude those not matching a substring.
 * @param list Button list (div) to filter.
 * @param string Substring for which to search.
 */
const filterButtonList = (list: HTMLDivElement, _string: string) => {
  const isInput = list === ui.inputList;
  applyCombinedFilter(list, isInput);
}

/**
 * Handles search box input by filtering its parent container.
 * @param event Input event from an {@link HTMLInputElement}
 */
const searchHandler = (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const targetParentList = target.parentElement?.querySelector(".format-list");
  if (!(targetParentList instanceof HTMLDivElement)) return;

  const isInput = targetParentList === ui.inputList;
  applyCombinedFilter(targetParentList, isInput);
};

// Assign search handler to both search boxes
ui.inputSearch.oninput = searchHandler;
ui.outputSearch.oninput = searchHandler;

// Map clicks in the file selection area to the file input element
ui.fileSelectArea.onclick = () => {
  ui.fileInput.click();
};

/** Reset UI back to the initial upload prompt state */
function resetToUploadPrompt() {
  selectedFiles = [];
  allUploadedFiles = [];
  conversionQueue = [];
  currentQueueIndex = 0;
  ui.fileSelectArea.classList.remove("has-file");
  ui.fileSelectArea.innerHTML = `
    <h2>Drop files here</h2>
    <p><span id="drop-hint-text">or </span>click to browse</p>
    <button class="browse-btn" onclick="document.getElementById('file-input').click(); event.stopPropagation();">Browse files</button>
  `;
  activeFolderName = null;
  ui.archivePanel.classList.remove("visible");
  appendFolderButton();
  // Clear format selections
  const prevInput = ui.inputList.querySelector(".selected");
  if (prevInput) prevInput.className = "";
  const prevOutput = ui.outputList.querySelector(".selected");
  if (prevOutput) prevOutput.className = "";
  ui.convertButton.className = "disabled";
  ui.convertButton.textContent = "Convert";
  ui.convertButton.removeAttribute("data-process-mode");
  ui.inputSearch.value = "";
  ui.outputSearch.value = "";
  inputCategoryFilter = "all";
  outputCategoryFilter = "all";
  // Reset active states on category pills
  for (const btn of Array.from(document.querySelectorAll(".category-filter-btn"))) {
    btn.classList.toggle("active", btn.textContent === "All");
  }
  filterButtonList(ui.inputList, "");
  filterButtonList(ui.outputList, "");
}

/**
 * Renders thumbnail previews for all selected files inside the upload card.
 * Images show a real thumbnail; other file types show an extension badge.
 */
const renderFilePreviews = (files: File[]) => {
  ui.fileSelectArea.classList.add("has-file");
  ui.fileSelectArea.innerHTML = "";

  const header = document.createElement("div");
  header.className = "file-preview-header";

  const countLabel = document.createElement("span");
  if (conversionQueue.length > 1) {
    countLabel.textContent = `Group ${currentQueueIndex + 1} of ${conversionQueue.length} — ${files.length} file${files.length !== 1 ? "s" : ""}`;
  } else {
    countLabel.textContent = files.length === 1
      ? "1 file selected"
      : `${files.length} files selected`;
  }

  const addMoreBtn = document.createElement("button");
  addMoreBtn.className = "browse-btn";
  addMoreBtn.textContent = "+ Add more";
  addMoreBtn.onclick = (e) => {
    e.stopPropagation();
    ui.fileInput.click();
  };

  header.appendChild(countLabel);
  header.appendChild(addMoreBtn);
  ui.fileSelectArea.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "file-preview-grid";

  for (const file of files) {
    const item = document.createElement("div");
    item.className = "file-preview-item";

    const thumb = document.createElement("div");
    thumb.className = "file-preview-thumb";

    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(url);
      img.src = url;
      img.alt = file.name;
      thumb.appendChild(img);
    } else {
      const badge = document.createElement("div");
      badge.className = "file-ext-badge";
      badge.textContent = file.name.split(".").pop()?.toUpperCase() ?? "?";
      thumb.appendChild(badge);
    }

    const nameEl = document.createElement("div");
    nameEl.className = "file-preview-name";
    nameEl.textContent = file.name;
    nameEl.title = file.name;

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.className = "file-remove-btn";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove file";
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      const idx = selectedFiles.indexOf(file);
      if (idx !== -1) selectedFiles.splice(idx, 1);
      const allIdx = allUploadedFiles.indexOf(file);
      if (allIdx !== -1) allUploadedFiles.splice(allIdx, 1);

      // Also update conversionQueue if active
      if (conversionQueue.length > 1) {
        conversionQueue[currentQueueIndex] = selectedFiles;
        if (selectedFiles.length === 0) {
          conversionQueue.splice(currentQueueIndex, 1);
          if (conversionQueue.length === 0) {
            resetToUploadPrompt();
            return;
          }
          if (currentQueueIndex >= conversionQueue.length) currentQueueIndex = conversionQueue.length - 1;
          presentQueueGroup(currentQueueIndex);
          return;
        }
      }

      if (selectedFiles.length === 0) {
        resetToUploadPrompt();
      } else {
        renderFilePreviews(selectedFiles);
        autoSelectInputFormat(selectedFiles[0]);
      }
    };

    item.appendChild(removeBtn);
    item.appendChild(thumb);
    item.appendChild(nameEl);
    grid.appendChild(item);
  }

  ui.fileSelectArea.appendChild(grid);
  ui.archivePanel.classList.add("visible");

  // Show folder indicator when in folder mode
  if (activeFolderName) {
    const indicator = document.createElement("div");
    indicator.className = "folder-indicator";
    indicator.innerHTML = `&#128193; <strong>${escapeHtml(activeFolderName)}</strong> &mdash; ${allUploadedFiles.length} file${allUploadedFiles.length !== 1 ? "s" : ""}`;
    header.insertBefore(indicator, header.firstChild);
  }
};

/**
 * Validates and stores user selected files. Works for both manual
 * selection and file drag-and-drop.
 * @param event Either a file input element's "change" event,
 * or a "drop" event.
 */
const fileSelectHandler = async (event: Event) => {

  let inputFiles;

  if (event instanceof DragEvent) {
    inputFiles = event.dataTransfer?.files;
    if (inputFiles) event.preventDefault();
  } else if (event instanceof ClipboardEvent) {
    const clipFiles = getClipboardFiles(event);
    if (clipFiles.length === 0) return;
    event.preventDefault();
    inputFiles = clipFiles as unknown as FileList;
  } else {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    inputFiles = target.files;
  }

  if (!inputFiles) return;
  const newFiles = Array.from(inputFiles);
  if (newFiles.length === 0) return;

  // Append to existing files if any, deduplicating by name+size
  const existing = new Set(allUploadedFiles.map(f => `${f.name}|${f.size}`));
  const merged = [...allUploadedFiles, ...newFiles.filter(f => !existing.has(`${f.name}|${f.size}`))];
  merged.sort((a, b) => a.name === b.name ? 0 : (a.name < b.name ? -1 : 1));
  const files = merged;
  allUploadedFiles = files;

  // Pre-scan files for magic-byte MIME detection before categorization
  await prescanFiles(files);

  // Determine if all files share the same media category
  const categories = new Set(files.map(f => getMediaCategory(f)));
  isSameCategoryBatch = categories.size === 1;

  if (isSameCategoryBatch) {
    // Same category: show all files, auto-select input format from first file
    conversionQueue = [];
    currentQueueIndex = 0;
    selectedFiles = files;
    renderFilePreviews(files);
    autoSelectInputFormat(files[0]);
  } else {
    // Mixed categories: group by media category and start queue
    const groupMap = new Map<string, File[]>();
    for (const file of files) {
      const cat = getMediaCategory(file);
      if (!groupMap.has(cat)) groupMap.set(cat, []);
      groupMap.get(cat)!.push(file);
    }
    conversionQueue = Array.from(groupMap.values());
    currentQueueIndex = 0;
    presentQueueGroup(currentQueueIndex);
  }
  updateProcessButton();

  // Reset file input so re-selecting the same file triggers change
  ui.fileInput.value = "";
};

/** Auto-select the input format button for a given file.
 *  Prefers magic-byte detected MIME when available. */
function autoSelectInputFormat(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  const detectedMime = getCachedDetectedMime(file);

  // Prefer magic-byte MIME, but not for ZIP-based containers
  let mimeType: string;
  if (detectedMime && !(normalizeMimeType(detectedMime) === "application/zip" && isZipBasedExtension(ext))) {
    mimeType = normalizeMimeType(detectedMime);
  } else {
    mimeType = normalizeMimeType(file.type);
  }
  const fileExtension = ext;

  const buttonsMatchingMime = Array.from(ui.inputList.children).filter(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    return button.getAttribute("mime-type") === mimeType;
  }) as HTMLButtonElement[];

  let inputFormatButton: HTMLButtonElement;
  if (buttonsMatchingMime.length > 1) {
    inputFormatButton = buttonsMatchingMime.find(button => {
      const formatIndex = button.getAttribute("format-index");
      if (!formatIndex) return;
      const format = allOptions[parseInt(formatIndex)];
      return format.format.extension === fileExtension;
    }) || buttonsMatchingMime[0];
  } else {
    inputFormatButton = buttonsMatchingMime[0];
  }

  if (mimeType && inputFormatButton instanceof HTMLButtonElement) {
    inputFormatButton.click();
    ui.inputSearch.value = mimeType;
    filterButtonList(ui.inputList, ui.inputSearch.value);
    return;
  }

  const buttonExtension = Array.from(ui.inputList.children).find(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    const formatIndex = button.getAttribute("format-index");
    if (!formatIndex) return;
    const format = allOptions[parseInt(formatIndex)];
    return format.format.extension.toLowerCase() === fileExtension;
  });
  if (buttonExtension instanceof HTMLButtonElement) {
    buttonExtension.click();
    ui.inputSearch.value = buttonExtension.getAttribute("mime-type") || "";
  } else {
    ui.inputSearch.value = fileExtension || "";
  }
  filterButtonList(ui.inputList, ui.inputSearch.value);
}

/** Present a specific queue group for conversion */
function presentQueueGroup(index: number) {
  const group = conversionQueue[index];
  selectedFiles = group;
  renderFilePreviews(group);
  autoSelectInputFormat(group[0]);

  // Clear output selection
  const prevOutput = ui.outputList.querySelector(".selected");
  if (prevOutput) prevOutput.className = "";
  ui.convertButton.className = "disabled";
  updateProcessButton();
}

// Add the file selection handler to both the file input element and to
// the window as a drag-and-drop event, and to the clipboard paste event.
ui.fileInput.addEventListener("change", fileSelectHandler);
window.addEventListener("drop", (e) => {
  // On dedicated tool pages, let those tools handle drops
  if (activeTool === "compress" || activeTool === "image" || activeTool === "video" || activeTool === "speech" || activeTool === "summarize" || activeTool === "ocr" || activeTool === "pdf-editor") return;
  fileSelectHandler(e);
});
window.addEventListener("dragover", e => e.preventDefault());
/** Extract File objects from a ClipboardEvent, checking both items and files.
 *  Renames generic clipboard image names (e.g. "image.png") to timestamped
 *  names so users can distinguish multiple pastes. */
function getClipboardFiles(e: ClipboardEvent): File[] {
  const files: File[] = [];
  const items = e.clipboardData?.items;
  if (items) {
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  // Fall back to clipboardData.files if items yielded nothing
  if (files.length === 0 && e.clipboardData?.files.length) {
    files.push(...Array.from(e.clipboardData.files));
  }
  // Rename generic clipboard image names like "image.png"
  return files.map(f => {
    if (/^image\.\w+$/.test(f.name)) {
      const ext = f.name.split(".").pop();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      return new File([f], `clipboard-${stamp}.${ext}`, { type: f.type, lastModified: f.lastModified });
    }
    return f;
  });
}

window.addEventListener("paste", (e) => {
  // Don't intercept paste if the user is typing in an input, textarea, or
  // contentEditable element — let the browser handle normal text paste
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) {
    return;
  }

  const pastedFiles = getClipboardFiles(e);

  // On image page, redirect paste to image tools
  if (activeTool === "image" && pastedFiles.length > 0) {
    e.preventDefault();
    imgLoadFiles(pastedFiles);
    return;
  }
  // On video page, redirect paste to video tools
  if (activeTool === "video" && pastedFiles.length > 0) {
    e.preventDefault();
    vidLoadFiles(pastedFiles);
    return;
  }
  fileSelectHandler(e);
});

// ── Folder input via hidden webkitdirectory input ──

/** Hidden input element for folder selection (works on all browsers) */
const folderInput = document.createElement("input");
folderInput.type = "file";
folderInput.setAttribute("webkitdirectory", "");
folderInput.style.display = "none";
document.body.appendChild(folderInput);

folderInput.addEventListener("change", async () => {
  const fileList = folderInput.files;
  if (!fileList || fileList.length === 0) return;

  // Filter out hidden/system files
  const files: File[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    if (f.name.startsWith(".") || f.name.startsWith("_")) continue;
    files.push(f);
  }

  if (files.length === 0) {
    window.showPopup(
      `<h2>Empty folder</h2>` +
      `<p>No supported files found in this folder.</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
    folderInput.value = "";
    return;
  }

  // Extract folder name from webkitRelativePath (format: "FolderName/file.ext")
  const firstPath = (fileList[0] as any).webkitRelativePath as string || "";
  activeFolderName = firstPath.split("/")[0] || "Folder";

  // Sort alphabetically for consistency
  files.sort((a, b) => a.name.localeCompare(b.name));

  // Pre-scan files for magic-byte MIME detection before categorization
  await prescanFiles(files);

  // Feed into the existing pipeline
  allUploadedFiles = files;
  const categories = new Set(files.map(f => getMediaCategory(f)));
  isSameCategoryBatch = categories.size === 1;

  if (isSameCategoryBatch) {
    conversionQueue = [];
    currentQueueIndex = 0;
    selectedFiles = files;
    renderFilePreviews(files);
    autoSelectInputFormat(files[0]);
  } else {
    const groupMap = new Map<string, File[]>();
    for (const file of files) {
      const cat = getMediaCategory(file);
      if (!groupMap.has(cat)) groupMap.set(cat, []);
      groupMap.get(cat)!.push(file);
    }
    conversionQueue = Array.from(groupMap.values());
    currentQueueIndex = 0;
    presentQueueGroup(currentQueueIndex);
  }
  updateProcessButton();
  folderInput.value = "";
});

/** Append the "Open Folder" button to the file area */
function appendFolderButton() {
  const btn = document.createElement("button");
  btn.className = "browse-btn folder-btn";
  btn.textContent = "Open Folder";
  btn.onclick = (e) => {
    e.stopPropagation();
    folderInput.click();
  };
  ui.fileSelectArea.appendChild(btn);
}

// Inject the folder button on initial load
appendFolderButton();

/**
 * Display an on-screen popup.
 * @param html HTML content of the popup box.
 */
window.showPopup = function (html: string) {
  ui.popupBox.innerHTML = html;
  ui.popupBox.style.display = "block";
  ui.popupBackground.style.display = "block";
}
/**
 * Hide the on-screen popup.
 */
window.hidePopup = function () {
  ui.popupBox.style.display = "none";
  ui.popupBackground.style.display = "none";
}

const allOptions: Array<{ format: FileFormat, handler: FormatHandler }> = [];
/** Map from normalized MIME type to matching allOptions entries (built in buildOptionList) */
let mimeToOptions = new Map<string, Array<{ format: FileFormat, handler: FormatHandler }>>();

window.supportedFormatCache = new Map();
window.traversionGraph = new TraversionGraph();

window.printSupportedFormatCache = () => {
  const entries = [];
  for (const entry of window.supportedFormatCache) {
    entries.push(entry);
  }
  return JSON.stringify(entries, null, 2);
}


/** Renders category filter pill buttons above a format list */
function renderCategoryFilters(container: HTMLDivElement, listEl: HTMLDivElement, isInput: boolean) {
  // Remove existing filter row if any
  container.querySelector(".category-filters")?.remove();

  const row = document.createElement("div");
  row.className = "category-filters";

  const categories = [
    { label: "All", value: "all" },
    { label: "Image", value: "image" },
    { label: "Video", value: "video" },
    { label: "Code", value: "code" },
    { label: "Other", value: "other" },
  ];

  for (const cat of categories) {
    const btn = document.createElement("button");
    btn.className = "category-filter-btn" + ((isInput ? inputCategoryFilter : outputCategoryFilter) === cat.value ? " active" : "");
    btn.textContent = cat.label;
    btn.type = "button";
    btn.onclick = () => {
      if (isInput) inputCategoryFilter = cat.value;
      else outputCategoryFilter = cat.value;
      // Update active states
      for (const b of Array.from(row.children) as HTMLButtonElement[]) {
        b.classList.remove("active");
      }
      btn.classList.add("active");
      applyCombinedFilter(listEl, isInput);
    };
    row.appendChild(btn);
  }

  // Insert between search input and the format-list div
  const formatList = container.querySelector(".format-list");
  if (formatList) {
    container.insertBefore(row, formatList);
  } else {
    container.appendChild(row);
  }
}

async function buildOptionList () {

  allOptions.length = 0;
  ui.inputList.innerHTML = "";
  ui.outputList.innerHTML = "";

  // Track already-added formats for O(1) dedup in simple mode
  const seenInputs = new Set<string>();
  const seenOutputs = new Set<string>();

  // Parallel init: initialize all uncached handlers concurrently
  const uninitializedHandlers = handlers.filter(h => !window.supportedFormatCache.has(h.name));
  if (uninitializedHandlers.length > 0) {
    await Promise.all(uninitializedHandlers.map(async (handler) => {
      console.warn(`Cache miss for formats of handler "${handler.name}".`);
      try {
        await handler.init();
        if (handler.supportedFormats) {
          window.supportedFormatCache.set(handler.name, handler.supportedFormats);
          console.info(`Updated supported format cache for "${handler.name}".`);
        }
      } catch (e) {
        console.warn(`Handler "${handler.name}" init failed:`, e);
      }
    }));
  }

  for (const handler of handlers) {
    const supportedFormats = window.supportedFormatCache.get(handler.name);
    if (!supportedFormats) {
      console.warn(`Handler "${handler.name}" doesn't support any formats.`);
      continue;
    }
    for (const format of supportedFormats) {

      if (!format.mime) continue;

      allOptions.push({ format, handler });

      // In simple mode, display each input/output format only once
      let addToInputs = true, addToOutputs = true;
      if (simpleMode) {
        const key = `${format.mime}|${format.format}`;
        addToInputs = !seenInputs.has(key);
        addToOutputs = !seenOutputs.has(key);
        if ((!format.from || !addToInputs) && (!format.to || !addToOutputs)) continue;
        if (format.from && addToInputs) seenInputs.add(key);
        if (format.to && addToOutputs) seenOutputs.add(key);
      }

      const newOption = document.createElement("button");
      newOption.setAttribute("format-index", (allOptions.length - 1).toString());
      newOption.setAttribute("mime-type", format.mime);

      const formatDescriptor = format.format.toUpperCase();
      if (simpleMode) {
        // Hide any handler-specific information in simple mode
        const cleanName = format.name
          .split("(").join(")").split(")")
          .filter((_, i) => i % 2 === 0)
          .filter(c => c != "")
          .join(" ");
        newOption.appendChild(document.createTextNode(`${formatDescriptor} - ${cleanName} (${format.mime})`));
      } else {
        newOption.appendChild(document.createTextNode(`${formatDescriptor} - ${format.name} (${format.mime}) ${handler.name}`));
      }

      const clickHandler = (event: Event) => {
        if (!(event.target instanceof HTMLButtonElement)) return;

        // Restore queue grouping if archive mode had suspended it
        if (archiveSuspendedQueue) {
          // Deselect archive buttons
          ui.archiveFmtBtns.forEach(b => b.classList.remove("selected"));
          ui.createArchiveBtn.className = "disabled";
          restoreQueueFromArchive();
        }

        const targetParent = event.target.parentElement;
        const previous = targetParent?.getElementsByClassName("selected")?.[0];
        if (previous) previous.className = "";
        event.target.className = "selected";
        const inputSelected = ui.inputList.querySelector(".selected");
        // In same-category batch mode with mixed exact formats, only output selection is needed
        const outputSelected = ui.outputList.querySelector(".selected");
        if (isSameCategoryBatch && allUploadedFiles.length > 1 && outputSelected) {
          ui.convertButton.className = "";
          ui.convertButton.textContent = "Convert";
          ui.convertButton.removeAttribute("data-process-mode");
        } else if (inputSelected && outputSelected) {
          ui.convertButton.className = "";
          ui.convertButton.textContent = "Convert";
          ui.convertButton.removeAttribute("data-process-mode");
        } else {
          ui.convertButton.className = "disabled";
        }
        updateProcessButton();
      };

      if (format.from && addToInputs) {
        const clone = newOption.cloneNode(true) as HTMLButtonElement;
        clone.onclick = clickHandler;
        ui.inputList.appendChild(clone);
      }
      if (format.to && addToOutputs) {
        const clone = newOption.cloneNode(true) as HTMLButtonElement;
        clone.onclick = clickHandler;
        ui.outputList.appendChild(clone);
      }

    }
  }
  window.traversionGraph.init(window.supportedFormatCache, handlers, false, _deadRoutes);

  // Build MIME lookup map for O(1) findInputOption
  mimeToOptions = new Map();
  for (const opt of allOptions) {
    if (!opt.format.from || !opt.format.mime) continue;
    const key = opt.format.mime;
    const arr = mimeToOptions.get(key);
    if (arr) arr.push(opt);
    else mimeToOptions.set(key, [opt]);
  }

  // Render category filters above each format list
  const inputContainer = ui.inputList.parentElement as HTMLDivElement;
  const outputContainer = ui.outputList.parentElement as HTMLDivElement;
  if (inputContainer) renderCategoryFilters(inputContainer, ui.inputList, true);
  if (outputContainer) renderCategoryFilters(outputContainer, ui.outputList, false);

  // Reset category filters on rebuild
  inputCategoryFilter = "all";
  outputCategoryFilter = "all";

  filterButtonList(ui.inputList, ui.inputSearch.value);
  filterButtonList(ui.outputList, ui.outputSearch.value);

  window.hidePopup();

}

// Expose handlers for the dead-route discovery script
(window as any)._handlers = handlers;

let _deadRoutes: DeadRoute[] | undefined;
(async () => {
  try {
    const [cacheRes, deadRes] = await Promise.all([
      fetch("cache.json").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("dead-routes.json").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (cacheRes) window.supportedFormatCache = new Map(cacheRes);
    else console.warn("Missing supported format precache.\n\nConsider saving the output of printSupportedFormatCache() to cache.json.");
    if (deadRes) _deadRoutes = deadRes as DeadRoute[];
  } catch {
    console.warn("Error loading precache files.");
  } finally {
    await buildOptionList();
    console.log("Built initial format list.");
  }
})();

ui.modeToggleButton.addEventListener("click", () => {
  simpleMode = !simpleMode;
  if (simpleMode) {
    ui.modeToggleButton.textContent = "Advanced mode";
    document.body.style.setProperty("--highlight-color", "#1C77FF");
  } else {
    ui.modeToggleButton.textContent = "Simple mode";
    document.body.style.setProperty("--highlight-color", "#FF6F1C");
  }
  buildOptionList();
});

// ──── Theme Toggle ────
function applyTheme(theme: string) {
  document.documentElement.classList.add("theme-transitioning");
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("convert-theme", theme); } catch {}
  setTimeout(() => document.documentElement.classList.remove("theme-transitioning"), 350);
}
try {
  const savedTheme = localStorage.getItem("convert-theme");
  if (savedTheme) {
    applyTheme(savedTheme);
  } else {
    applyTheme(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
} catch { applyTheme("dark"); }

if (ui.themeToggle) {
  ui.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
    applyMiniPaintTheme();
  });
}

// ──── Settings Modal Toggle ────
if (ui.settingsToggle) {
  ui.settingsToggle.addEventListener("click", () => {
    if (ui.settingsModal.classList.contains("hidden")) {
      // Auto-select panel matching current tool page
      const panel = activeTool === "compress" ? "compress"
                  : activeTool === "image" ? "image"
                  : activeTool === "video" ? "video"
                  : activeTool === "speech" ? "speech"
                  : activeTool === "summarize" ? "summarize"
                  : activeTool === "ocr" ? "ocr"
                  : activeTool === "pdf-editor" ? "pdf-editor"
                  : undefined;
      openSettings(panel);
    } else {
      closeSettings();
    }
  });
}

// ──── Logs Modal Toggle ────
function openLogs() {
  ui.logsPopout.classList.remove("hidden");
  ui.logsOverlay.classList.remove("hidden");
  const list = document.getElementById("app-log-list");
  if (list) _renderAppLogInto(list);
}
function closeLogs() {
  ui.logsPopout.classList.add("hidden");
  ui.logsOverlay.classList.add("hidden");
}
if (ui.logsToggle) {
  ui.logsToggle.addEventListener("click", () => {
    if (ui.logsPopout.classList.contains("hidden")) {
      openLogs();
    } else {
      closeLogs();
    }
  });
}
if (ui.logsOverlay) {
  ui.logsOverlay.addEventListener("click", closeLogs);
}
const logsPopoutClose = document.getElementById("logs-popout-close");
if (logsPopoutClose) {
  logsPopoutClose.addEventListener("click", closeLogs);
}
document.getElementById("logs-close-mobile")?.addEventListener("click", closeLogs);

// ──── Accent Color Picker ────
const customSlot1 = document.getElementById("custom-slot-1") as HTMLButtonElement;
const customSlot2 = document.getElementById("custom-slot-2") as HTMLButtonElement;
const customSlot3 = document.getElementById("custom-slot-3") as HTMLButtonElement;
const saveCustomBtn = document.getElementById("save-custom-color") as HTMLButtonElement;
let nextCustomSlot = 1;

function updateNextSlotIndicator() {
  [customSlot1, customSlot2, customSlot3].forEach((el, i) => {
    el?.classList.toggle("custom-slot-next", i + 1 === nextCustomSlot);
  });
}

function applyAccent(color: string) {
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--highlight-color", color);
  try { localStorage.setItem("convert-accent", color); } catch {}
  ui.accentColors.forEach(dot => {
    dot.classList.toggle("active", dot.getAttribute("data-color") === color);
  });
  if (ui.customAccent) ui.customAccent.value = color;
}

function restoreCustomSlots() {
  try {
    const slots = [
      { key: "convert-custom-color-1", el: customSlot1 },
      { key: "convert-custom-color-2", el: customSlot2 },
      { key: "convert-custom-color-3", el: customSlot3 },
    ];
    for (const { key, el } of slots) {
      const c = localStorage.getItem(key);
      if (c && el) {
        el.style.setProperty("background", c, "important");
        el.setAttribute("data-color", c);
        el.classList.add("has-color");
      }
    }
  } catch {}
}
restoreCustomSlots();
updateNextSlotIndicator();

try {
  const savedAccent = localStorage.getItem("convert-accent") || "#7C3AED";
  applyAccent(savedAccent);
} catch { applyAccent("#7C3AED"); }

ui.accentColors.forEach(dot => {
  dot.addEventListener("click", () => {
    const color = dot.getAttribute("data-color");
    if (color) applyAccent(color);
    const slot = (dot as HTMLButtonElement).dataset["slot"];
    if (slot) {
      nextCustomSlot = parseInt(slot, 10);
      updateNextSlotIndicator();
    }
  });
});
if (ui.customAccent) {
  ui.customAccent.addEventListener("input", () => {
    applyAccent(ui.customAccent.value);
  });
}
if (saveCustomBtn) {
  saveCustomBtn.addEventListener("click", () => {
    const color = ui.customAccent?.value;
    if (!color) return;
    const slot = nextCustomSlot === 1 ? customSlot1 : nextCustomSlot === 2 ? customSlot2 : customSlot3;
    const key = `convert-custom-color-${nextCustomSlot}`;
    if (slot) {
      slot.style.setProperty("background", color, "important");
      slot.setAttribute("data-color", color);
      slot.classList.add("has-color");
    }
    try { localStorage.setItem(key, color); } catch {}
    applyAccent(color);
    nextCustomSlot = nextCustomSlot >= 3 ? 1 : nextCustomSlot + 1;
    updateNextSlotIndicator();
  });
}

// ──── Error Log Buttons ────
const copyLogBtn = document.getElementById("copy-log-btn");
if (copyLogBtn) {
  copyLogBtn.addEventListener("click", () => {
    const text = appLogBuffer
      .map(e => `[${e.time}] ${e.level.toUpperCase()} ${e.msg}`)
      .join("\n");
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      (copyLogBtn as HTMLButtonElement).textContent = "Copied!";
      setTimeout(() => { (copyLogBtn as HTMLButtonElement).textContent = "Copy log"; }, 2000);
    }).catch(() => {});
  });
}
const clearLogBtn = document.getElementById("clear-log-btn");
if (clearLogBtn) {
  clearLogBtn.addEventListener("click", () => {
    appLogBuffer.length = 0;
    const list = document.getElementById("app-log-list");
    if (list) _renderAppLogInto(list);
    const badge = document.getElementById("log-badge");
    if (badge) { badge.textContent = "0"; badge.classList.add("hidden"); }
  });
}

// ──── Auto-download Toggle ────
if (ui.autoDownloadToggle) {
  ui.autoDownloadToggle.classList.toggle("active", autoDownload);
  ui.autoDownloadToggle.addEventListener("click", () => {
    autoDownload = !autoDownload;
    ui.autoDownloadToggle.classList.toggle("active", autoDownload);
    try { localStorage.setItem("convert-auto-download", String(autoDownload)); } catch {};
  });
}

// ──── Archive Multi-file Output Toggle ────
if (ui.archiveMultiToggle) {
  ui.archiveMultiToggle.classList.toggle("active", archiveMultiOutput);
  ui.archiveMultiToggle.addEventListener("click", () => {
    archiveMultiOutput = !archiveMultiOutput;
    ui.archiveMultiToggle.classList.toggle("active", archiveMultiOutput);
    try { localStorage.setItem("convert-archive-multi", String(archiveMultiOutput)); } catch {}
  });
}

// ──── Remove Background Toggles ────
function updateBgUI() {
  // Correction only applies to local mode
  const correctionRow = ui.bgCorrectionToggle?.closest(".sm-switch-row");
  if (correctionRow) (correctionRow as HTMLElement).classList.toggle("hidden", bgMode === "api");
  // API key only shown in API mode
  if (ui.bgApiKeyRow) ui.bgApiKeyRow.classList.toggle("hidden", bgMode !== "api");
}

if (ui.removeBgToggle) {
  ui.removeBgToggle.classList.toggle("active", removeBg);
  ui.removeBgToggle.addEventListener("click", () => {
    removeBg = !removeBg;
    ui.removeBgToggle.classList.toggle("active", removeBg);
    updateBgUI();
    try { localStorage.setItem("convert-remove-bg", String(removeBg)); } catch {}
    syncImageSettingsUI();
    updateProcessButton();
  });
}
updateBgUI();

if (ui.bgModeToggle) {
  ui.bgModeToggle.textContent = bgMode === "local" ? "Mode: Local" : "Mode: remove.bg API";
  ui.bgModeToggle.addEventListener("click", () => {
    bgMode = bgMode === "local" ? "api" : "local";
    ui.bgModeToggle.textContent = bgMode === "local" ? "Mode: Local" : "Mode: remove.bg API";
    updateBgUI();
    try { localStorage.setItem("convert-bg-mode", bgMode); } catch {}
    syncImageSettingsUI();
  });
}

if (ui.bgCorrectionToggle) {
  ui.bgCorrectionToggle.classList.toggle("active", bgCorrection);
  ui.bgCorrectionToggle.addEventListener("click", () => {
    bgCorrection = !bgCorrection;
    ui.bgCorrectionToggle.classList.toggle("active", bgCorrection);
    try { localStorage.setItem("convert-bg-correction", String(bgCorrection)); } catch {}
    syncImageSettingsUI();
  });
}

if (ui.bgApiKeyInput) {
  ui.bgApiKeyInput.value = bgApiKey;
  ui.bgApiKeyInput.addEventListener("input", () => {
    bgApiKey = ui.bgApiKeyInput.value.trim();
    try { localStorage.setItem("convert-bg-api-key", bgApiKey); } catch {}
    syncImageSettingsUI();
  });
}
if (ui.openrouterApiKeyInput) {
  ui.openrouterApiKeyInput.value = openrouterApiKey;
  ui.openrouterApiKeyInput.addEventListener("input", () => {
    openrouterApiKey = ui.openrouterApiKeyInput.value.trim();
    try { localStorage.setItem("convert-openrouter-key", openrouterApiKey); } catch {}
  });
}
updateBgUI();

// ──── Image Rescale Toggle ────
if (ui.rescaleToggle) {
  ui.rescaleToggle.classList.toggle("active", rescaleEnabled);
  if (ui.rescaleOptions) ui.rescaleOptions.classList.toggle("hidden", !rescaleEnabled);
  ui.rescaleToggle.addEventListener("click", () => {
    rescaleEnabled = !rescaleEnabled;
    ui.rescaleToggle.classList.toggle("active", rescaleEnabled);
    if (ui.rescaleOptions) ui.rescaleOptions.classList.toggle("hidden", !rescaleEnabled);
    try { localStorage.setItem("convert-rescale", String(rescaleEnabled)); } catch {}
    syncImageSettingsUI();
    updateProcessButton();
  });
}
function updateRescalePlaceholders() {
  if (!ui.rescaleWidthInput || !ui.rescaleHeightInput) return;
  if (rescaleLockRatio) {
    ui.rescaleWidthInput.placeholder = rescaleWidth > 0 ? "" : "auto";
    ui.rescaleHeightInput.placeholder = rescaleHeight > 0 ? "" : "auto";
  } else {
    ui.rescaleWidthInput.placeholder = "";
    ui.rescaleHeightInput.placeholder = "";
  }
}
if (ui.rescaleWidthInput) {
  if (rescaleWidth > 0) ui.rescaleWidthInput.value = String(rescaleWidth);
  ui.rescaleWidthInput.addEventListener("input", () => {
    rescaleWidth = parseInt(ui.rescaleWidthInput.value) || 0;
    if (rescaleLockRatio && rescaleWidth > 0 && ui.rescaleHeightInput) {
      rescaleHeight = 0;
      ui.rescaleHeightInput.value = "";
      try { localStorage.setItem("convert-rescale-height", "0"); } catch {}
    }
    updateRescalePlaceholders();
    try { localStorage.setItem("convert-rescale-width", String(rescaleWidth)); } catch {}
    syncImageSettingsUI();
    updateProcessButton();
  });
}
if (ui.rescaleHeightInput) {
  if (rescaleHeight > 0) ui.rescaleHeightInput.value = String(rescaleHeight);
  ui.rescaleHeightInput.addEventListener("input", () => {
    rescaleHeight = parseInt(ui.rescaleHeightInput.value) || 0;
    if (rescaleLockRatio && rescaleHeight > 0 && ui.rescaleWidthInput) {
      rescaleWidth = 0;
      ui.rescaleWidthInput.value = "";
      try { localStorage.setItem("convert-rescale-width", "0"); } catch {}
    }
    updateRescalePlaceholders();
    try { localStorage.setItem("convert-rescale-height", String(rescaleHeight)); } catch {}
    syncImageSettingsUI();
    updateProcessButton();
  });
}
if (ui.rescaleLockInput) {
  ui.rescaleLockInput.checked = rescaleLockRatio;
  ui.rescaleLockInput.addEventListener("change", () => {
    rescaleLockRatio = ui.rescaleLockInput.checked;
    if (rescaleLockRatio && rescaleWidth > 0 && rescaleHeight > 0) {
      // When locking with both set, keep width and clear height
      rescaleHeight = 0;
      if (ui.rescaleHeightInput) ui.rescaleHeightInput.value = "";
      try { localStorage.setItem("convert-rescale-height", "0"); } catch {}
    }
    updateRescalePlaceholders();
    try { localStorage.setItem("convert-rescale-lock", String(rescaleLockRatio)); } catch {}
    syncImageSettingsUI();
  });
}
updateRescalePlaceholders();

// ──── Privacy Mode Toggle ────
if (ui.privacyToggle) {
  ui.privacyToggle.classList.toggle("active", privacyMode);
  ui.privacyToggle.addEventListener("click", () => {
    privacyMode = !privacyMode;
    ui.privacyToggle.classList.toggle("active", privacyMode);
    try { localStorage.setItem("convert-privacy", String(privacyMode)); } catch {}
  });
}

// ──── Cache Models Toggle ────
if (ui.cacheModelsToggle) {
  const cacheOn = (() => { try { return localStorage.getItem("convert-cache-models") === "yes"; } catch { return false; } })();
  ui.cacheModelsToggle.classList.toggle("active", cacheOn);
  ui.cacheModelsToggle.addEventListener("click", () => {
    const wasOn = ui.cacheModelsToggle.classList.contains("active");
    const nowOn = !wasOn;
    ui.cacheModelsToggle.classList.toggle("active", nowOn);
    try { localStorage.setItem("convert-cache-models", nowOn ? "yes" : "no"); } catch {}
    applyHfCachePolicy();
    if (nowOn) {
      requestPersistentStorage();
    } else {
      clearModelCache();
    }
  });
}

// ──── AI Acceleration Setting ────
if (ui.aiDeviceSelect) {
  try { const saved = localStorage.getItem("convert-ai-device"); if (saved) ui.aiDeviceSelect.value = saved; } catch {}
  ui.aiDeviceSelect.addEventListener("change", () => {
    try { localStorage.setItem("convert-ai-device", ui.aiDeviceSelect.value); } catch {}
  });
}

// ──── Compression Settings ────

// Compression is always enabled on the compress tool page (no toggle needed)

if (ui.compressTargetInput) {
  if (compressTargetMB > 0) ui.compressTargetInput.value = String(compressTargetMB);
  ui.compressTargetInput.addEventListener("input", () => {
    compressTargetMB = parseFloat(ui.compressTargetInput.value) || 0;
    if (ui.compressPresetSelect) ui.compressPresetSelect.value = "";
    try { localStorage.setItem("convert-compress-target", String(compressTargetMB)); } catch {}
    updateProcessButton();
  });
}

if (ui.compressPresetSelect) {
  // Restore saved preset value
  if (compressTargetMB > 0) {
    const opts = Array.from(ui.compressPresetSelect.options);
    const match = opts.find(o => parseFloat(o.value) === compressTargetMB);
    if (match) ui.compressPresetSelect.value = match.value;
  }
  ui.compressPresetSelect.addEventListener("change", () => {
    const size = parseFloat(ui.compressPresetSelect.value) || 0;
    compressTargetMB = size;
    if (ui.compressTargetInput) ui.compressTargetInput.value = size > 0 ? String(size) : "";
    try { localStorage.setItem("convert-compress-target", String(compressTargetMB)); } catch {}
    updateProcessButton();
  });
}

// Codec selection (H.264 / H.265)
const codecHints: Record<string, string> = {
  h264: "",
  h265: "H.265 produces ~50% smaller files but may not play on older devices. Falls back to H.264 if encoding stalls.",
};
function updateCodecHint() {
  if (ui.codecHint) {
    const hint = codecHints[compressCodec] ?? "";
    ui.codecHint.textContent = hint;
    ui.codecHint.classList.toggle("hidden", !hint);
  }
}
ui.codecPresetBtns.forEach(btn => {
  const codec = btn.getAttribute("data-codec") ?? "h264";
  btn.classList.toggle("selected", codec === compressCodec);
  btn.addEventListener("click", () => {
    compressCodec = codec as "h264" | "h265";
    ui.codecPresetBtns.forEach(b => b.classList.toggle("selected", b.getAttribute("data-codec") === codec));
    updateCodecHint();
    try { localStorage.setItem("convert-compress-codec", compressCodec); } catch {}
  });
});
updateCodecHint();

// Encoder speed preset
ui.speedPresetBtns.forEach(btn => {
  const speed = btn.getAttribute("data-speed") ?? "balanced";
  btn.classList.toggle("selected", speed === compressSpeed);
  btn.addEventListener("click", () => {
    compressSpeed = speed as "fast" | "balanced" | "quality";
    ui.speedPresetBtns.forEach(b => b.classList.toggle("selected", b.getAttribute("data-speed") === speed));
    try { localStorage.setItem("convert-compress-speed", compressSpeed); } catch {}
  });
});

// WebM mode toggle
if (ui.webmModeToggle) {
  ui.webmModeToggle.classList.toggle("active", compressWebmMode);
  if (ui.webmHint) ui.webmHint.classList.toggle("hidden", !compressWebmMode);
  ui.webmModeToggle.addEventListener("click", () => {
    compressWebmMode = !compressWebmMode;
    ui.webmModeToggle.classList.toggle("active", compressWebmMode);
    if (ui.webmHint) ui.webmHint.classList.toggle("hidden", !compressWebmMode);
    try { localStorage.setItem("convert-compress-webm", String(compressWebmMode)); } catch {}
  });
}

// ──── Output Tray: Download All / Clear ────
if (ui.downloadAllBtn) {
  ui.downloadAllBtn.addEventListener("click", () => {
    for (const item of Array.from(ui.outputTrayGrid.children)) {
      if (!(item instanceof HTMLElement)) continue;
      const url = item.getAttribute("data-blob-url");
      const name = item.getAttribute("data-file-name");
      if (url && name) triggerDownload(url, name);
    }
  });
}
if (ui.clearOutputBtn) {
  ui.clearOutputBtn.addEventListener("click", () => {
    for (const url of outputTrayUrls) URL.revokeObjectURL(url);
    outputTrayUrls.length = 0;
    ui.outputTrayGrid.innerHTML = "";
    ui.outputTray.classList.remove("visible");
  });
}

let deadEndHashes: Set<string>;
/** Number of routes tried in the last search — used for failure UI */
let _lastSearchRoutesTried = 0;

/** Hash a path prefix for O(1) dead-end lookups */
function hashPath(path: ConvertPathNode[], len: number): string {
  let h = "";
  for (let i = 0; i < len; i++) {
    const p = path[i];
    if (i > 0) h += "|";
    h += p.handler.name + ":" + p.format.mime + ":" + p.format.format;
  }
  return h;
}

function showConversionFailedPopup(fromFmt: string, toFmt: string) {
  const routes = _lastSearchRoutesTried;
  window.showPopup(
    `<h2>Conversion failed</h2>` +
    `<p>Could not find a working route from <b>${fromFmt}</b> to <b>${toFmt}</b>.</p>` +
    (routes > 0
      ? `<p>${routes.toLocaleString()} route${routes !== 1 ? "s" : ""} explored — all failed or led to dead ends.</p>`
      : `<p>No conversion routes exist between these formats.</p>`) +
    `<p style="opacity:0.7;font-size:0.9em">Check the activity log in the top-right corner for details.</p>` +
    `<button onclick="window.hidePopup()">OK</button>`
  );
}

let _conversionCancelled = false;

/** Cancel an in-progress conversion from the UI. */
window._cancelActiveConversion = () => {
  _conversionCancelled = true;
  window.traversionGraph.abortSearch();
  const handler = window._activeConversionHandler as any;
  if (handler?.cancel) handler.cancel();
};

async function attemptConvertPath (files: FileData[], path: ConvertPathNode[]) {

  const pathString = path.map(c => c.format.format).join(" → ");

  // Exit early if any prefix of this path is a known dead end (O(1) per prefix length)
  for (let len = 2; len <= path.length; len++) {
    if (deadEndHashes.has(hashPath(path, len))) {
      console.warn(`Skipping ${pathString} due to known dead-end prefix.`);
      return null;
    }
  }

  // Show conversion popup with elapsed timer and cancel button
  const convertStartTime = Date.now();
  ui.popupBox.innerHTML = `<h2>Converting...</h2>
    <p>Trying <b>${pathString}</b>...</p>
    <p id="convert-elapsed" class="search-status"></p>
    <button onclick="window._cancelActiveConversion()">Cancel</button>`;

  const timerInterval = setInterval(() => {
    const el = document.getElementById("convert-elapsed");
    if (!el) return;
    const seconds = Math.floor((Date.now() - convertStartTime) / 1000);
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    el.textContent = `Elapsed: ${min}:${sec.toString().padStart(2, "0")}`;
  }, 1000);

  for (let i = 0; i < path.length - 1; i ++) {
    const handler = path[i + 1].handler;
    try {
      let supportedFormats = window.supportedFormatCache.get(handler.name);
      if (!handler.ready) {
        await handler.init();
        if (!handler.ready) throw `Handler "${handler.name}" not ready after init.`;
        if (handler.supportedFormats) {
          window.supportedFormatCache.set(handler.name, handler.supportedFormats);
          supportedFormats = handler.supportedFormats;
        }
      }
      if (!supportedFormats) throw `Handler "${handler.name}" doesn't support any formats.`;
      const inputFormat = supportedFormats.find(c =>
        c.from
        && c.mime === path[i].format.mime
        && c.format === path[i].format.format
      )!;
      window._activeConversionHandler = handler;
      files = (await Promise.all([
        handler.doConvert(files, inputFormat, path[i + 1].format),
        // Ensure that we wait long enough for the UI to update
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ]))[0];
      window._activeConversionHandler = null;
      if (files.some(c => !c.bytes.length)) throw "Output is empty.";
    } catch (e) {
      window._activeConversionHandler = null;
      clearInterval(timerInterval);

      // If the user cancelled, don't register as a dead end
      if (_conversionCancelled) return null;

      console.log(path.map(c => c.format.format));
      console.error(handler.name, `${path[i].format.format} → ${path[i + 1].format.format}`, e);

      // Dead ends are added both to the graph and to the attempt system.
      // The graph may still have old paths queued from before they were
      // marked as dead ends, so we catch that here.
      const deadEndPath = path.slice(0, i + 2);
      deadEndHashes.add(hashPath(deadEndPath, deadEndPath.length));
      window.traversionGraph.addDeadEndPath(deadEndPath);

      ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
        <p id="convert-search-status" class="search-status">Looking for a valid path...</p>
        <button onclick="window._cancelActiveConversion()">Cancel</button>`;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return null;

    }
  }

  clearInterval(timerInterval);
  return { files, path };

}

window.tryConvertByTraversing = async function (
  files: FileData[],
  from: ConvertPathNode,
  to: ConvertPathNode
) {
  deadEndHashes = new Set();
  window.traversionGraph.clearDeadEndPaths();
  _conversionCancelled = false;

  // Show initial search popup with cancel button
  ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
    <p id="convert-search-status" class="search-status">Searching\u2026</p>
    <p id="convert-search-path" class="search-path"></p>
    <button onclick="window._cancelActiveConversion()">Cancel</button>`;
  ui.popupBox.style.display = "block";
  ui.popupBackground.style.display = "block";

  // ── Fast path: video → video via WebCodecs (hardware-accelerated) ──
  const reencodeTargetMap: Record<string, "webm" | "mp4" | "mkv"> = {
    webm: "webm", mp4: "mp4", m4v: "mp4", mov: "mp4", mkv: "mkv", matroska: "mkv",
  };
  const reencodeTarget = reencodeTargetMap[to.format.format] ?? reencodeTargetMap[to.format.internal];
  if (from.format.mime?.startsWith("video/") && reencodeTarget) {
    try {
      const { reencodeVideo } = await import("./webcodecs-compress.ts");
      const results: FileData[] = [];
      let allOk = true;
      for (const f of files) {
        const r = await reencodeVideo(f, reencodeTarget);
        if (r) { results.push(r); } else { allOk = false; break; }
      }
      if (allOk && results.length > 0) {
        return { files: results, path: [from, to] };
      }
    } catch (e) { console.warn("[fast-path] error, falling back to graph search:", e); }
  }


  // Live listener: update popup with the path currently being explored
  const searchListener = (state: string, path: ConvertPathNode[]) => {
    const pathEl = document.getElementById("convert-search-path");
    if (!pathEl) return;
    if (state === "searching") {
      pathEl.innerHTML = `Exploring <b>${path.map(p => p.format.format).join(" \u2192 ")}</b>\u2026`;
    } else if (state === "found") {
      pathEl.innerHTML = `Found route: <b>${path.map(p => p.format.format).join(" \u2192 ")}</b>`;
    }
  };
  window.traversionGraph.addPathEventListener(searchListener);

  let result = null;
  _lastSearchRoutesTried = 0;
  for await (const path of window.traversionGraph.searchPath(from, to)) {
    // In advanced mode, skip paths whose final handler doesn't match the
    // user's selected output handler.
    if (!simpleMode && to.handler && path.at(-1)?.handler.name !== to.handler.name) continue;
    _lastSearchRoutesTried++;
    // Use exact output format if the target handler supports it
    if (path.at(-1)?.handler === to.handler) {
      path[path.length - 1] = to;
    }
    const convertResult = await attemptConvertPath(files, path);
    if (_conversionCancelled) break; // user cancelled
    if (convertResult) {
      result = convertResult;
      break;
    }
    // Path failed — dead end is already registered by attemptConvertPath,
    // the running generator will respect it on subsequent expansions.
  }

  window.traversionGraph.removePathEventListener(searchListener);
  return result;
}

/** Track blob URLs for cleanup */
const outputTrayUrls: string[] = [];
const OUTPUT_TRAY_MAX = 100;

/** Image extensions eligible for background removal */
const bgRemovalExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif", "jpg", "jpeg", "bmp"]);

/** Extensions that support transparency — others get forced to PNG */
const alphaExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif"]);

/** Strip metadata from an image by re-encoding through canvas */
async function stripImageMetadata(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart], { type: "image/" + ext });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  const outMime = (ext === "webp") ? "image/webp" : (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "image/png";
  const outBlob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b!), outMime, 1));
  return new Uint8Array(await outBlob.arrayBuffer());
}

/** Apply metadata stripping to all image files if privacy mode is on */
async function applyMetadataStrip(files: FileData[]): Promise<FileData[]> {
  if (!privacyMode) return files;
  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (bgRemovalExts.has(ext)) {
      const stripped = await stripImageMetadata(f.bytes, ext);
      result.push({ name: f.name, bytes: stripped });
    } else {
      result.push(f);
    }
  }
  return result;
}

/** Remove background via remove.bg API */
async function removeBgViaApi(fileBytes: Uint8Array, ext: string): Promise<Uint8Array> {
  if (!bgApiKey) throw new Error("No remove.bg API key provided. Add your key in Settings → Processing.");
  const sendBytes = privacyMode ? await stripImageMetadata(fileBytes, ext) : fileBytes;
  const fileName = privacyMode ? crypto.randomUUID().substring(0, 8) + "." + ext : "image." + ext;
  const formData = new FormData();
  formData.append("image_file", new Blob([sendBytes as BlobPart], { type: "image/" + ext }), fileName);
  formData.append("size", "auto");
  const resp = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": bgApiKey },
    body: formData,
    referrerPolicy: "no-referrer",
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`remove.bg API error (${resp.status}): ${errText}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/** Remove background locally via RMBG-1.4 */
async function removeBgLocal(f: FileData, ext: string): Promise<Uint8Array> {
  const { pipeline, RawImage } = await import("@huggingface/transformers");
  const segmenter = await pipeline("image-segmentation", "briaai/RMBG-1.4", {
    device: navigator.gpu ? "webgpu" : "wasm",
  });

  const inputBlob = new Blob([f.bytes as BlobPart], { type: "image/" + ext });
  const blobUrl = URL.createObjectURL(inputBlob);
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = blobUrl; });

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const rawImg = await RawImage.fromURL(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const output = await segmenter(rawImg);
  const maskResult = (output as { mask: InstanceType<typeof RawImage> }[])[0];
  const mask = maskResult.mask;

  const resizedMask = mask.width !== img.width || mask.height !== img.height
    ? await mask.resize(img.width, img.height)
    : mask;

  const pixels = imageData.data;
  if (bgCorrection) {
    let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
    for (let i = 0; i < resizedMask.data.length; i++) {
      if (resizedMask.data[i] < 30) {
        bgR += pixels[i * 4];
        bgG += pixels[i * 4 + 1];
        bgB += pixels[i * 4 + 2];
        bgCount++;
      }
    }
    if (bgCount > 0) { bgR /= bgCount; bgG /= bgCount; bgB /= bgCount; }

    const colorThreshold = 40;
    for (let i = 0; i < resizedMask.data.length; i++) {
      if (resizedMask.data[i] >= 128) {
        pixels[i * 4 + 3] = 255;
      } else {
        const dr = pixels[i * 4] - bgR;
        const dg = pixels[i * 4 + 1] - bgG;
        const db = pixels[i * 4 + 2] - bgB;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        pixels[i * 4 + 3] = dist > colorThreshold ? 255 : 0;
      }
    }
  } else {
    for (let i = 0; i < resizedMask.data.length; i++) {
      pixels[i * 4 + 3] = resizedMask.data[i];
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const outBlob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b!), "image/png", 1));
  return new Uint8Array(await outBlob.arrayBuffer());
}

/** Apply background removal to image files if the toggle is on */
async function applyBgRemoval(files: FileData[]): Promise<FileData[]> {
  if (!removeBg) return files;
  const eligible = files.filter(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return bgRemovalExts.has(ext);
  });
  if (eligible.length === 0) return files;

  const isApi = bgMode === "api";
  window.showPopup(
    `<h2>Removing background...</h2>` +
    `<p>${isApi ? "Sending" : "Processing"} ${eligible.length} image${eligible.length !== 1 ? "s" : ""}${isApi ? " to remove.bg" : ". This may take a moment on first run"}.</p>`
  );
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!bgRemovalExts.has(ext)) {
      result.push(f);
      continue;
    }

    let outBytes = isApi
      ? await removeBgViaApi(f.bytes, ext)
      : await removeBgLocal(f, ext);

    // Auto-resize remove.bg API output back to original dimensions
    if (isApi) {
      outBytes = await resizeToMatch(outBytes, f.bytes, ext);
    }

    const baseName = f.name.replace(/\.[^.]+$/, "");
    const supportsAlpha = alphaExts.has(ext);
    const outName = supportsAlpha ? f.name : baseName + ".png";
    result.push({ name: outName, bytes: outBytes });
  }
  return result;
}

/** Resize image bytes to match the dimensions of a reference image */
async function resizeToMatch(imgBytes: Uint8Array, refBytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const [imgDims, refDims] = await Promise.all([
    getImageDimensions(imgBytes, ext),
    getImageDimensions(refBytes, ext),
  ]);
  if (imgDims.w === refDims.w && imgDims.h === refDims.h) return imgBytes;
  return resizeImageBytes(imgBytes, ext, refDims.w, refDims.h);
}

/** Lazy-init ImageMagick WASM (called once, cached) */
let magickReady: Promise<void> | null = null;
async function ensureMagick() {
  if (!magickReady) {
    magickReady = (async () => {
      const { initializeImageMagick } = await import("@imagemagick/magick-wasm");
      const wasmResponse = await cdnFetch("magickWasm");
      const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await initializeImageMagick(wasmBytes as any);
    })();
  }
  await magickReady;
}

/** Get dimensions of an image from its bytes via ImageMagick */
async function getImageDimensions(bytes: Uint8Array, _ext: string): Promise<{ w: number; h: number }> {
  await ensureMagick();
  const { ImageMagick } = await import("@imagemagick/magick-wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ImageMagick.read(bytes as any, (img: any) => {
    return { w: img.width as number, h: img.height as number };
  });
}

/** Resize image bytes to target dimensions via ImageMagick (lossless) */
async function resizeImageBytes(bytes: Uint8Array, ext: string, w: number, h: number): Promise<Uint8Array> {
  await ensureMagick();
  const { ImageMagick, MagickFormat } = await import("@imagemagick/magick-wasm");
  const extToMagickFormat: Record<string, typeof MagickFormat[keyof typeof MagickFormat]> = {
    png: MagickFormat.Png, webp: MagickFormat.WebP, avif: MagickFormat.Avif,
    tiff: MagickFormat.Tiff, tif: MagickFormat.Tiff, gif: MagickFormat.Gif,
    jpg: MagickFormat.Jpeg, jpeg: MagickFormat.Jpeg, bmp: MagickFormat.Bmp,
    ico: MagickFormat.Ico, svg: MagickFormat.Svg,
  };
  const fmt = extToMagickFormat[ext] ?? MagickFormat.Png;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ImageMagick.read(bytes as any, (img: any) => {
    img.resize(w, h);
    img.quality = 100;
    return img.write(fmt, (out: any) => new Uint8Array(out));
  });
}

/** Image extensions eligible for rescaling */
const rescaleExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif", "jpg", "jpeg", "bmp", "ico", "svg"]);

/** Inpainting model URLs */
const MIGAN_MODEL_URL = "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx";
const LAMA_MODEL_URL = "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx";

/** Lazy-load ONNX Runtime session for the selected inpainting model */
async function ensureInpaintSession() {
  const wanted = inpaintModel;
  // Re-create session if model selection changed
  if (inpaintSession && inpaintSessionModel === wanted) return inpaintSession;
  if (inpaintSession) { try { inpaintSession.release(); } catch {} inpaintSession = null; }

  const ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
  const url = wanted === "lama" ? LAMA_MODEL_URL : MIGAN_MODEL_URL;
  const modelResp = await cachedFetch(url);
  const modelBytes = new Uint8Array(await modelResp.arrayBuffer());
  // LaMa's Fourier convolutions (FFC) are incompatible with WebGPU — force WASM
  const providers: string[] = [];
  if (wanted !== "lama" && navigator.gpu) providers.push("webgpu");
  providers.push("wasm");
  inpaintSession = await ort.InferenceSession.create(modelBytes.buffer, {
    executionProviders: providers,
  });
  inpaintSessionModel = wanted;
  return inpaintSession;
}

/** Run MI-GAN pipeline inpainting — accepts arbitrary resolution, uint8 in/out */
async function runMiganInpainting(imageBytes: Uint8Array, ext: string, maskImageData: ImageData): Promise<Uint8Array> {
  const ort = await import("onnxruntime-web");
  const session = await ensureInpaintSession();

  // Load image to canvas at original size
  const blob = new Blob([imageBytes as BlobPart], { type: "image/" + ext });
  const blobUrl = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = blobUrl; });
  URL.revokeObjectURL(blobUrl);

  const W = img.width, H = img.height;

  // Get image RGBA pixel data
  const imgCanvas = document.createElement("canvas");
  imgCanvas.width = W; imgCanvas.height = H;
  const imgCtx = imgCanvas.getContext("2d")!;
  imgCtx.drawImage(img, 0, 0);
  const imgData = imgCtx.getImageData(0, 0, W, H);

  // Convert image HWC RGBA → CHW RGB uint8
  const imgCHW = new Uint8Array(3 * H * W);
  for (let h = 0; h < H; h++) {
    for (let w = 0; w < W; w++) {
      const srcIdx = (h * W + w) * 4;
      imgCHW[0 * H * W + h * W + w] = imgData.data[srcIdx];     // R
      imgCHW[1 * H * W + h * W + w] = imgData.data[srcIdx + 1]; // G
      imgCHW[2 * H * W + h * W + w] = imgData.data[srcIdx + 2]; // B
    }
  }

  // Scale mask to image dimensions if needed
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = W; maskCanvas.height = H;
  const maskCtx = maskCanvas.getContext("2d")!;
  if (maskImageData.width !== W || maskImageData.height !== H) {
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = maskImageData.width; tmpCanvas.height = maskImageData.height;
    tmpCanvas.getContext("2d")!.putImageData(maskImageData, 0, 0);
    maskCtx.drawImage(tmpCanvas, 0, 0, W, H);
  } else {
    maskCtx.putImageData(maskImageData, 0, 0);
  }
  const maskData = maskCtx.getImageData(0, 0, W, H);

  // Convert mask: our drawn overlay alpha → MI-GAN convention (0=hole, 255=known)
  const maskCHW = new Uint8Array(1 * H * W);
  for (let i = 0; i < H * W; i++) {
    maskCHW[i] = maskData.data[i * 4 + 3] > 30 ? 0 : 255;
  }

  const imageTensor = new ort.Tensor("uint8", imgCHW, [1, 3, H, W]);
  const maskTensor = new ort.Tensor("uint8", maskCHW, [1, 1, H, W]);

  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = imageTensor;
  feeds[session.inputNames[1]] = maskTensor;

  const results = await session.run(feeds);
  const outTensor = results[session.outputNames[0]];
  const rawData = outTensor.data;
  const isFloat = outTensor.type === "float32";

  // Convert output CHW RGB → canvas RGBA (handle both uint8 and float32)
  const outCanvas = document.createElement("canvas");
  outCanvas.width = W; outCanvas.height = H;
  const outCtx = outCanvas.getContext("2d")!;
  const outImgData = outCtx.createImageData(W, H);
  const size = H * W;
  for (let h = 0; h < H; h++) {
    for (let w = 0; w < W; w++) {
      const dstIdx = (h * W + w) * 4;
      const r = rawData[0 * size + h * W + w] as number;
      const g = rawData[1 * size + h * W + w] as number;
      const b = rawData[2 * size + h * W + w] as number;
      outImgData.data[dstIdx] = isFloat ? Math.max(0, Math.min(255, Math.round(r))) : r;
      outImgData.data[dstIdx + 1] = isFloat ? Math.max(0, Math.min(255, Math.round(g))) : g;
      outImgData.data[dstIdx + 2] = isFloat ? Math.max(0, Math.min(255, Math.round(b))) : b;
      outImgData.data[dstIdx + 3] = 255;
    }
  }
  outCtx.putImageData(outImgData, 0, 0);

  const outBlob = await new Promise<Blob>((res) => outCanvas.toBlob(b => res(b!), "image/png", 1));
  return new Uint8Array(await outBlob.arrayBuffer());
}

/** Run LaMa inpainting — fixed 512x512, float32, composited back to original resolution */
async function runLamaInpainting(imageBytes: Uint8Array, ext: string, maskImageData: ImageData): Promise<Uint8Array> {
  const ort = await import("onnxruntime-web");
  const session = await ensureInpaintSession();

  const blob = new Blob([imageBytes as BlobPart], { type: "image/" + ext });
  const blobUrl = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = blobUrl; });
  URL.revokeObjectURL(blobUrl);

  const origW = img.width, origH = img.height;

  // Resize image to 512x512
  const imgCanvas = document.createElement("canvas");
  imgCanvas.width = 512; imgCanvas.height = 512;
  const imgCtx = imgCanvas.getContext("2d")!;
  imgCtx.drawImage(img, 0, 0, 512, 512);
  const imgData = imgCtx.getImageData(0, 0, 512, 512);

  // Resize mask to 512x512 (process mask first so we can zero out masked image pixels)
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskImageData.width; maskCanvas.height = maskImageData.height;
  maskCanvas.getContext("2d")!.putImageData(maskImageData, 0, 0);
  const mask512 = document.createElement("canvas");
  mask512.width = 512; mask512.height = 512;
  const mask512Ctx = mask512.getContext("2d")!;
  mask512Ctx.drawImage(maskCanvas, 0, 0, 512, 512);
  const maskData = mask512Ctx.getImageData(0, 0, 512, 512);

  if (inpaintFeather) applyGaussianBlur(maskData, 512, 512, 5);

  // Binary mask tensor [1, 1, 512, 512]
  const maskTensor = new Float32Array(512 * 512);
  for (let i = 0; i < 512 * 512; i++) {
    maskTensor[i] = maskData.data[i * 4 + 3] > 30 ? 1.0 : 0.0;
  }

  // Image tensor [1, 3, 512, 512] float32 normalized to [0, 1]
  // LaMa expects masked image: zero out pixels in the masked region so the model
  // knows those areas need to be reconstructed (standard LaMa convention)
  const imgTensor = new Float32Array(3 * 512 * 512);
  for (let i = 0; i < 512 * 512; i++) {
    const keep = 1.0 - maskTensor[i]; // 0 for masked pixels, 1 for known pixels
    imgTensor[i] = (imgData.data[i * 4] / 255.0) * keep;
    imgTensor[512 * 512 + i] = (imgData.data[i * 4 + 1] / 255.0) * keep;
    imgTensor[2 * 512 * 512 + i] = (imgData.data[i * 4 + 2] / 255.0) * keep;
  }

  const inputNames = session.inputNames;
  const imgInputName = inputNames.find((n: string) => n.includes("image") || n === "image") ?? inputNames[0];
  const maskInputName = inputNames.find((n: string) => n.includes("mask") || n === "mask") ?? inputNames[1];

  const feeds: Record<string, any> = {};
  feeds[imgInputName] = new ort.Tensor("float32", imgTensor, [1, 3, 512, 512]);
  feeds[maskInputName] = new ort.Tensor("float32", maskTensor, [1, 1, 512, 512]);

  const results = await session.run(feeds);
  const outputData = results[session.outputNames[0]].data as Float32Array;

  // Detect output range: if max value > 2 the model outputs [0,255], otherwise [0,1]
  let maxVal = 0;
  for (let i = 0; i < outputData.length; i++) {
    if (outputData[i] > maxVal) maxVal = outputData[i];
  }
  const scale = maxVal > 2.0 ? 1.0 : 255.0;

  // Render 512x512 result
  const outCanvas = document.createElement("canvas");
  outCanvas.width = 512; outCanvas.height = 512;
  const outCtx = outCanvas.getContext("2d")!;
  const outImgData = outCtx.createImageData(512, 512);
  for (let i = 0; i < 512 * 512; i++) {
    outImgData.data[i * 4] = Math.max(0, Math.min(255, Math.round(outputData[i] * scale)));
    outImgData.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(outputData[512 * 512 + i] * scale)));
    outImgData.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(outputData[2 * 512 * 512 + i] * scale)));
    outImgData.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(outImgData, 0, 0);

  // Composite into original at full resolution — only replace masked pixels
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = origW; finalCanvas.height = origH;
  const finalCtx = finalCanvas.getContext("2d")!;
  finalCtx.drawImage(img, 0, 0);

  const maskOrigCanvas = document.createElement("canvas");
  maskOrigCanvas.width = origW; maskOrigCanvas.height = origH;
  maskOrigCanvas.getContext("2d")!.drawImage(maskCanvas, 0, 0, origW, origH);
  const maskOrigData = maskOrigCanvas.getContext("2d")!.getImageData(0, 0, origW, origH);

  const inpaintScaled = document.createElement("canvas");
  inpaintScaled.width = origW; inpaintScaled.height = origH;
  inpaintScaled.getContext("2d")!.drawImage(outCanvas, 0, 0, origW, origH);

  const finalData = finalCtx.getImageData(0, 0, origW, origH);
  const inpaintedData = inpaintScaled.getContext("2d")!.getImageData(0, 0, origW, origH);

  for (let i = 0; i < origW * origH; i++) {
    const a = maskOrigData.data[i * 4 + 3] / 255;
    if (a > 0.01) {
      finalData.data[i * 4] = Math.round(finalData.data[i * 4] * (1 - a) + inpaintedData.data[i * 4] * a);
      finalData.data[i * 4 + 1] = Math.round(finalData.data[i * 4 + 1] * (1 - a) + inpaintedData.data[i * 4 + 1] * a);
      finalData.data[i * 4 + 2] = Math.round(finalData.data[i * 4 + 2] * (1 - a) + inpaintedData.data[i * 4 + 2] * a);
    }
  }
  finalCtx.putImageData(finalData, 0, 0);

  const outBlob = await new Promise<Blob>((res) => finalCanvas.toBlob(b => res(b!), "image/png", 1));
  return new Uint8Array(await outBlob.arrayBuffer());
}

/** Run inpainting using the selected model */
async function runInpainting(imageBytes: Uint8Array, ext: string, maskImageData: ImageData): Promise<Uint8Array> {
  return inpaintModel === "lama"
    ? runLamaInpainting(imageBytes, ext, maskImageData)
    : runMiganInpainting(imageBytes, ext, maskImageData);
}

/** Separable box-blur approximation of Gaussian blur on ImageData alpha channel (O(n·r) per pass) */
function applyGaussianBlur(data: ImageData, w: number, h: number, radius: number) {
  const pixels = data.data;
  const size = w * h;
  const alphas = new Float32Array(size);
  for (let i = 0; i < size; i++) alphas[i] = pixels[i * 4 + 3];

  const tmp = new Float32Array(size);

  // 3-pass box blur approximates Gaussian
  let src = alphas, dst = tmp;
  for (let pass = 0; pass < 3; pass++) {
    // Horizontal pass
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.min(w - 1, Math.max(0, x + dx));
          sum += src[y * w + nx];
          count++;
        }
        dst[y * w + x] = sum / count;
      }
    }
    // Vertical pass
    const src2 = dst, dst2 = (pass < 2) ? (dst === tmp ? alphas : tmp) : alphas;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          sum += src2[ny * w + x];
          count++;
        }
        dst2[y * w + x] = sum / count;
      }
    }
    src = dst2;
    dst = dst2 === tmp ? alphas : tmp;
  }
  for (let i = 0; i < size; i++) pixels[i * 4 + 3] = Math.round(alphas[i]);
}

/** Apply inpainting to files — now a no-op since inpainting is done interactively in miniPaint */
async function applyInpainting(files: FileData[]): Promise<FileData[]> {
  return files;
}

/** Apply user-specified rescaling to image files */
async function applyRescale(files: FileData[]): Promise<FileData[]> {
  if (!rescaleEnabled || (rescaleWidth <= 0 && rescaleHeight <= 0)) return files;

  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!rescaleExts.has(ext)) {
      result.push(f);
      continue;
    }

    const dims = await getImageDimensions(f.bytes, ext);
    let targetW = rescaleWidth || 0;
    let targetH = rescaleHeight || 0;

    if (targetW > 0 && targetH <= 0) {
      // Only width set — calculate height from aspect ratio
      targetH = Math.round(dims.h * (targetW / dims.w));
    } else if (targetH > 0 && targetW <= 0) {
      // Only height set — calculate width from aspect ratio
      targetW = Math.round(dims.w * (targetH / dims.h));
    }

    if (targetW === dims.w && targetH === dims.h) {
      result.push(f);
      continue;
    }

    const resized = await resizeImageBytes(f.bytes, ext, targetW, targetH);
    result.push({ name: f.name, bytes: resized });
  }
  return result;
}

/** Apply processing steps gated by the active tool */
async function applyToolProcessing(files: FileData[]): Promise<FileData[]> {
  if (activeTool === "convert") {
    // Convert: only strip metadata (privacy)
    files = await applyMetadataStrip(files);
  } else if (activeTool === "compress") {
    // Compress: strip image metadata (privacy) + compression
    files = await applyMetadataStrip(files);
    files = await applyCompression(files);
  } else if (activeTool === "image") {
    // Image tools: inpainting → BG removal → metadata strip → rescale
    files = await applyInpainting(files);
    files = await applyBgRemoval(files);
    files = await applyMetadataStrip(files);
    files = await applyRescale(files);
  } else {
    // Fallback (shouldn't happen): run all
    files = await applyInpainting(files);
    files = await applyBgRemoval(files);
    files = await applyMetadataStrip(files);
    files = await applyRescale(files);
    files = await applyCompression(files);
  }
  return files;
}

/** Apply file compression: re-encodes video with adaptive CRF, optionally constrained to target size */
async function applyCompression(files: FileData[]): Promise<FileData[]> {
  if (!compressEnabled) return files;
  const targetBytes = compressTargetMB > 0 ? compressTargetMB * 1024 * 1024 : 0;
  return await applyFileCompression(files, targetBytes, compressMode, compressSpeed, 23, compressCodec, compressWebmMode);
}

const videoCompressionExts = new Set([
  "mp4", "webm", "avi", "mov", "mkv", "flv", "wmv", "ogv", "m4v", "3gp", "ts", "mts",
]);

/** Image extensions for redirect suggestion */
const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tiff", "tif"]);

/** Last converted files (for redirect to another tool) */
let lastConvertedFiles: FileData[] = [];

/** Generate redirect suggestion HTML if all output files are images or all are videos */
function getRedirectSuggestionHtml(files: FileData[]): string {
  if (activeTool !== "convert" || files.length === 0) return "";
  const allImages = files.every(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return imageExts.has(ext);
  });
  const allVideos = files.every(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return videoCompressionExts.has(ext);
  });
  if (allImages) {
    return `<br><button class="popup-redirect-btn" data-redirect-tool="image">Continue to Image Tools &rarr;</button>`;
  }
  if (allVideos) {
    return `<br><button class="popup-redirect-btn" data-redirect-tool="compress">Continue to Compress &rarr;</button>` +
           `<br><button class="popup-redirect-btn" data-redirect-tool="video">Continue to Video Editor &rarr;</button>`;
  }
  return "";
}

/** Attach click handlers to redirect buttons in the popup */
function attachRedirectHandlers() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".popup-redirect-btn[data-redirect-tool]")) {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.redirectTool as "image" | "compress" | "video";
      redirectToToolWithFiles(tool);
    });
  }
}

/** Navigate to a tool and load the last converted files as input */
function redirectToToolWithFiles(tool: "image" | "compress" | "video") {
  window.hidePopup();
  // Create File objects from the FileData
  const newFiles: File[] = lastConvertedFiles.map(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
      avif: "image/avif", tiff: "image/tiff", tif: "image/tiff",
      heif: "image/heif", heic: "image/heic",
      mp4: "video/mp4", webm: "video/webm", avi: "video/x-msvideo", mov: "video/quicktime",
      mkv: "video/x-matroska", flv: "video/x-flv", wmv: "video/x-ms-wmv", ogv: "video/ogg",
      m4v: "video/x-m4v", "3gp": "video/3gpp", ts: "video/mp2t", mts: "video/mp2t",
      hevc: "video/hevc", h265: "video/hevc",
    };
    const mime = mimeMap[ext] || "application/octet-stream";
    return new File([f.bytes as BlobPart], f.name, { type: mime });
  });

  showToolView(tool);

  if (tool === "image") {
    // Use image tools workspace
    imgResetState();
    imgLoadFiles(newFiles);
  } else if (tool === "video") {
    vidResetState();
    if (newFiles.length > 0) vidLoadFiles(newFiles);
  } else if (tool === "compress") {
    compressLoadFiles(newFiles);
  } else {
    selectedFiles = newFiles;
    allUploadedFiles = newFiles;
    conversionQueue = [];
    currentQueueIndex = 0;
    isSameCategoryBatch = true;
    renderFilePreviews(newFiles);
    if (newFiles.length > 0) autoSelectInputFormat(newFiles[0]);
    updateProcessButton();
  }
}

function isVideoFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return videoCompressionExts.has(ext);
}

function getVideoCompressionHtml(inputFiles: File[], outputFiles: FileData[]): string {
  const compressionActive = compressEnabled;
  if (!compressionActive) return "";
  const videoInputs = inputFiles.filter(f => isVideoFile(f.name));
  const videoOutputs = outputFiles.filter(f => isVideoFile(f.name));
  if (videoInputs.length === 0 || videoOutputs.length === 0) return "";
  const before = videoInputs.reduce((s, f) => s + f.size, 0);
  const after = videoOutputs.reduce((s, f) => s + f.bytes.length, 0);
  return `<p>Compression: ${formatFileSize(before)} → ${formatFileSize(after)}</p>`;
}

/** Update the convert button to show "Process" mode when processing settings are active but no output format is selected */
function updateProcessButton() {
  const hasFiles = selectedFiles.length > 0;
  const hasImageFiles = hasFiles && selectedFiles.some(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return rescaleExts.has(ext) || bgRemovalExts.has(ext);
  });
  const rescaleReady = rescaleEnabled && (rescaleWidth > 0 || rescaleHeight > 0);
  const compressReady = compressEnabled;
  const hasImageProcessing = rescaleReady || removeBg;
  const hasProcessing = hasImageProcessing || compressReady;
  const outputSelected = document.querySelector("#to-list .selected");

  // Compression applies to any file, image processing only to images
  const canProcess = (hasImageFiles && hasImageProcessing) || (hasFiles && compressReady);

  // Dedicated tool pages: always use process mode (no output format needed)
  if (activeTool === "compress") {
    if (hasFiles && compressReady) {
      ui.convertButton.textContent = "Compress";
      ui.convertButton.className = "";
      ui.convertButton.setAttribute("data-process-mode", "true");
    } else {
      ui.convertButton.textContent = "Compress";
      ui.convertButton.className = "disabled";
      ui.convertButton.removeAttribute("data-process-mode");
    }
    return;
  }

  if (activeTool === "image") {
    // Image tool now uses its own action bar — shared convert button stays hidden
    ui.convertButton.textContent = "Process";
    ui.convertButton.className = "disabled";
    ui.convertButton.removeAttribute("data-process-mode");
    return;
  }

  // Convert tool: button is simply "Convert" — no process mode
  ui.convertButton.textContent = "Convert";
  ui.convertButton.removeAttribute("data-process-mode");
  if (!outputSelected) {
    ui.convertButton.className = "disabled";
  }
}

/** Trigger a browser download from a blob URL */
function triggerDownload(blobUrl: string, name: string) {
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = name;
  link.click();
}

/** Format byte count as human-readable size */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/** Format elapsed milliseconds as human-readable duration */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec}s`;
}

/** Copy file bytes to clipboard (images only — converts to PNG for clipboard compat) */
async function copyToClipboard(bytes: Uint8Array, mime: string): Promise<boolean> {
  try {
    let blob: Blob;
    if (mime === "image/png") {
      blob = new Blob([bytes as BlobPart], { type: "image/png" });
    } else if (mime.startsWith("image/")) {
      // Clipboard API only supports PNG; convert via canvas
      const imgBlob = new Blob([bytes as BlobPart], { type: mime });
      const bitmap = await createImageBitmap(imgBlob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("Canvas toBlob failed")), "image/png");
      });
    } else {
      return false;
    }
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type]: blob })
    ]);
    return true;
  } catch (e) {
    console.error("Copy to clipboard failed:", e);
    return false;
  }
}

// Expose for popup onclick handlers
(window as any)._copyToClipboard = copyToClipboard;

/** Image MIME prefixes eligible for clipboard copy */
const clipboardImageMimes = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp",
  "image/avif", "image/svg+xml", "image/tiff"
]);

/**
 * Build "Copy to Clipboard" button HTML for success popups.
 * Only returns markup when there's a single image output and the API is available.
 * Stores the bytes in a temporary window slot so the onclick can access them.
 */
function getClipboardCopyHtml(files: FileData[], mime: string): string {
  if (files.length !== 1) return "";
  if (!clipboardImageMimes.has(mime)) return "";
  if (typeof navigator.clipboard?.write !== "function") return "";
  // Stash bytes so the inline onclick can reach them
  (window as any)._clipboardBytes = files[0].bytes;
  (window as any)._clipboardMime = mime;
  return `<button id="popup-copy-btn" class="popup-secondary-btn" onclick="(async()=>{` +
    `const btn=document.getElementById('popup-copy-btn');` +
    `btn.disabled=true;btn.textContent='Copying...';` +
    `const ok=await window._copyToClipboard(window._clipboardBytes,window._clipboardMime);` +
    `btn.textContent=ok?'Copied!':'Failed';` +
    `setTimeout(()=>{btn.disabled=false;btn.textContent='Copy to Clipboard'},1500)` +
    `})()">Copy to Clipboard</button>`;
}

/** Add a converted file to the output tray */
function addToOutputTray(bytes: Uint8Array, name: string) {
  // Evict oldest items when the tray is at capacity (FIFO)
  while (outputTrayUrls.length >= OUTPUT_TRAY_MAX) {
    const oldUrl = outputTrayUrls.shift();
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    ui.outputTrayGrid.firstElementChild?.remove();
  }

  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const blobUrl = URL.createObjectURL(blob);
  outputTrayUrls.push(blobUrl);

  const item = document.createElement("div");
  item.className = "output-item";
  item.draggable = true;
  item.setAttribute("data-blob-url", blobUrl);
  item.setAttribute("data-file-name", name);

  const thumb = document.createElement("div");
  thumb.className = "output-item-thumb";

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"];
  if (imageExts.includes(ext)) {
    const img = document.createElement("img");
    img.src = blobUrl;
    img.alt = name;
    thumb.appendChild(img);
  } else {
    const badge = document.createElement("div");
    badge.className = "file-ext-badge";
    badge.textContent = ext.toUpperCase() || "?";
    thumb.appendChild(badge);
  }

  // Download button on the thumbnail
  const dlBtn = document.createElement("button");
  dlBtn.className = "output-download-btn";
  dlBtn.title = "Download";
  dlBtn.innerHTML = "\u2913"; // downwards arrow
  dlBtn.onclick = (e) => {
    e.stopPropagation();
    triggerDownload(blobUrl, name);
  };
  thumb.appendChild(dlBtn);

  // Copy-to-clipboard button (images only)
  if (imageExts.includes(ext) && typeof navigator.clipboard?.write === "function") {
    const extToMime: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
      svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
    };
    const mime = extToMime[ext] ?? "image/png";
    const copyBtn = document.createElement("button");
    copyBtn.className = "output-copy-btn";
    copyBtn.title = "Copy to clipboard";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      copyBtn.disabled = true;
      const ok = await copyToClipboard(bytes, mime);
      copyBtn.textContent = ok ? "Copied!" : "Failed";
      setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.disabled = false; }, 1500);
    };
    thumb.appendChild(copyBtn);
  }

  const nameEl = document.createElement("div");
  nameEl.className = "output-item-name";
  nameEl.textContent = name;
  nameEl.title = name;

  const sizeEl = document.createElement("div");
  sizeEl.className = "output-item-size";
  sizeEl.textContent = formatFileSize(bytes.length);

  item.appendChild(thumb);
  item.appendChild(nameEl);
  item.appendChild(sizeEl);

  // Drag support for drag-to-desktop (Chrome)
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("DownloadURL", `application/octet-stream:${name}:${blobUrl}`);
    e.dataTransfer?.setData("text/uri-list", blobUrl);
  });

  ui.outputTrayGrid.appendChild(item);
  ui.outputTray.classList.add("visible");
}

function downloadFile(bytes: Uint8Array, name: string) {
  addToOutputTray(bytes, name);
  if (autoDownload) {
    const blobUrl = outputTrayUrls[outputTrayUrls.length - 1];
    triggerDownload(blobUrl, name);
  }
  saveRecentFile(name, activeTool || "convert");
}

/** Whether archive mode temporarily suspended queue grouping */
let archiveSuspendedQueue = false;

/** Temporarily exit queue mode so archive sees all files */
function suspendQueueForArchive() {
  if (!archiveSuspendedQueue && allUploadedFiles.length > 0) {
    archiveSuspendedQueue = true;
    selectedFiles = [...allUploadedFiles];
    renderFilePreviews(selectedFiles);
    // Clear format selections since all-files view doesn't map to one input format
    const prevInput = ui.inputList.querySelector(".selected");
    if (prevInput) prevInput.className = "";
    const prevOutput = ui.outputList.querySelector(".selected");
    if (prevOutput) prevOutput.className = "";
    ui.convertButton.className = "disabled";
    updateProcessButton();
    ui.inputSearch.value = "";
    filterButtonList(ui.inputList, "");
  }
}

/** Restore queue grouping after archive mode is exited */
function restoreQueueFromArchive() {
  if (!archiveSuspendedQueue) return;
  archiveSuspendedQueue = false;
  if (conversionQueue.length > 1) {
    presentQueueGroup(currentQueueIndex);
  } else if (allUploadedFiles.length > 0) {
    selectedFiles = [...allUploadedFiles];
    renderFilePreviews(selectedFiles);
    autoSelectInputFormat(selectedFiles[0]);
  }
}

// Archive format toggle buttons
ui.archiveFmtBtns.forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    btn.classList.toggle("selected");
    const anySelected = Array.from(ui.archiveFmtBtns).some(b => b.classList.contains("selected"));
    ui.createArchiveBtn.className = anySelected ? "" : "disabled";

    if (anySelected) {
      suspendQueueForArchive();
    } else {
      restoreQueueFromArchive();
    }
  });
});

ui.createArchiveBtn.addEventListener("click", async () => {
  const selectedFormats = Array.from(ui.archiveFmtBtns)
    .filter(b => b.classList.contains("selected"))
    .map(b => b.getAttribute("data-format")!);

  if (!selectedFormats.length) return;
  const archiveFiles = allUploadedFiles.length ? allUploadedFiles : selectedFiles;
  if (!archiveFiles.length) return alert("No files uploaded.");

  const inputFileData: FileData[] = [];
  for (const file of archiveFiles) {
    const buffer = await file.arrayBuffer();
    inputFileData.push({ name: file.name, bytes: new Uint8Array(buffer) });
  }

  window.showPopup("<h2>Creating archives...</h2>");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    for (const fmt of selectedFormats) {
      window.showPopup(`<h2>Creating ${fmt.toUpperCase()} archive...</h2>`);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      switch (fmt) {
        case "zip": {
          const zip = new JSZip();
          for (let i = 0; i < inputFileData.length; i++) {
            zip.file(inputFileData[i].name, inputFileData[i].bytes);
            if (i % 10 === 9) {
              await new Promise(r => requestAnimationFrame(r));
            }
          }
          const out = await zip.generateAsync({ type: "uint8array" });
          downloadFile(out, "archive.zip");
          break;
        }
        case "tar": {
          downloadFile(await createTar(inputFileData), "archive.tar");
          break;
        }
        case "tgz": {
          downloadFile(pakoGzip(await createTar(inputFileData)), "archive.tar.gz");
          break;
        }
        case "gz": {
          for (const f of inputFileData) {
            downloadFile(pakoGzip(f.bytes), f.name + ".gz");
          }
          break;
        }
        case "7z": {
          window.showPopup("<h2>Loading 7-Zip tools...</h2>");
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const SevenZip = (await import("7z-wasm")).default;
          const { cdnUrlPreload: _preload, cdnUrlSync: _sync } = await import("./cdn.js");
          await _preload("sevenZip");
          const sz = await SevenZip({ locateFile: () => _sync("sevenZip") });
          for (let i = 0; i < inputFileData.length; i++) {
            sz.FS.writeFile(inputFileData[i].name, inputFileData[i].bytes);
            if (i % 10 === 9) {
              await new Promise(r => requestAnimationFrame(r));
            }
          }
          sz.callMain(["a", "-t7z", "archive.7z", ...inputFileData.map(f => f.name)]);
          downloadFile(sz.FS.readFile("archive.7z"), "archive.7z");
          break;
        }
      }
    }

    window.showPopup(
      `<h2>Done!</h2>` +
      `<p>Created ${selectedFormats.length} archive${selectedFormats.length > 1 ? "s" : ""}.</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
  } catch (e) {
    window.hidePopup();
    alert("Error creating archive:\n" + e);
    console.error(e);
  }
});

// ── Image Tools: miniPaint Bridge + Processing ──────────────────────────────

/** Sync image settings UI in the settings modal */
function syncImageSettingsUI() {
  if (ui.imgInpaintModelToggle) ui.imgInpaintModelToggle.textContent = inpaintModel === "lama" ? "Model: LaMa (HQ)" : "Model: MI-GAN";
  if (ui.imgInpaintFeatherToggle) ui.imgInpaintFeatherToggle.classList.toggle("active", inpaintFeather);
}

/** Also sync the modal settings UI from global state */
function syncModalSettingsUI() {
  if (ui.removeBgToggle) ui.removeBgToggle.classList.toggle("active", removeBg);
  if (ui.bgModeToggle) {
    ui.bgModeToggle.textContent = bgMode === "local" ? "Mode: Local" : "Mode: remove.bg API";
  }
  updateBgUI();
  if (ui.bgCorrectionToggle) ui.bgCorrectionToggle.classList.toggle("active", bgCorrection);
  if (ui.bgApiKeyInput) ui.bgApiKeyInput.value = bgApiKey;
  if (ui.rescaleToggle) ui.rescaleToggle.classList.toggle("active", rescaleEnabled);
  if (ui.rescaleOptions) ui.rescaleOptions.classList.toggle("hidden", !rescaleEnabled);
  if (ui.rescaleWidthInput) ui.rescaleWidthInput.value = rescaleWidth > 0 ? String(rescaleWidth) : "";
  if (ui.rescaleHeightInput) ui.rescaleHeightInput.value = rescaleHeight > 0 ? String(rescaleHeight) : "";
  if (ui.rescaleLockInput) ui.rescaleLockInput.checked = rescaleLockRatio;
}

/** Wire settings modal inpaint controls */
ui.imgInpaintModelToggle?.addEventListener("click", () => {
  inpaintModel = inpaintModel === "migan" ? "lama" : "migan";
  try { localStorage.setItem("convert-inpaint-model", inpaintModel); } catch {}
  syncImageSettingsUI();
  syncModalSettingsUI();
});
ui.imgInpaintFeatherToggle?.addEventListener("click", () => {
  inpaintFeather = !inpaintFeather;
  try { localStorage.setItem("convert-inpaint-feather", String(inpaintFeather)); } catch {}
  syncImageSettingsUI();
  syncModalSettingsUI();
});

// ── Compress tool ────────────────────────────────────────────────────────────

const COMPRESS_EXTS = new Set(["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv", "ogv", "m4v", "3gp", "ts", "mts", "hevc", "h265", "gif"]);

/** Load files into the compress tool workspace */
function compressLoadFiles(files: File[]) {
  const valid = files.filter(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return f.type.startsWith("video/") || f.type === "image/gif" || COMPRESS_EXTS.has(ext);
  });
  if (valid.length === 0) return;

  // Append to existing or start fresh
  const existing = new Set(selectedFiles.map(f => `${f.name}|${f.size}`));
  const merged = [...selectedFiles, ...valid.filter(f => !existing.has(`${f.name}|${f.size}`))];
  selectedFiles = merged;
  allUploadedFiles = merged;
  conversionQueue = [];
  currentQueueIndex = 0;
  isSameCategoryBatch = true;

  // Switch to workspace view
  ui.compressDropZone?.classList.add("hidden");
  ui.compressWorkspace?.classList.remove("hidden");
  compressRenderFiles();
  updateProcessButton();
}

/** Render the compress file list */
function compressRenderFiles() {
  if (!ui.compressFileList) return;
  ui.compressFileList.innerHTML = "";

  const header = document.createElement("div");
  header.className = "compress-file-header";
  const countLabel = document.createElement("span");
  countLabel.textContent = selectedFiles.length === 1
    ? "1 file selected"
    : `${selectedFiles.length} files selected`;
  const actions = document.createElement("div");
  actions.className = "compress-file-header-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "compress-add-btn";
  addBtn.textContent = "+ Add more";
  addBtn.onclick = (e) => { e.stopPropagation(); ui.compressFileInput?.click(); };
  const clearBtn = document.createElement("button");
  clearBtn.className = "compress-clear-btn";
  clearBtn.textContent = "Clear";
  clearBtn.onclick = (e) => { e.stopPropagation(); compressResetState(); };
  actions.appendChild(addBtn);
  actions.appendChild(clearBtn);
  header.appendChild(countLabel);
  header.appendChild(actions);
  ui.compressFileList.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "compress-file-grid";
  for (const file of selectedFiles) {
    const item = document.createElement("div");
    item.className = "compress-file-item";

    const ext = document.createElement("div");
    ext.className = "compress-file-ext";
    ext.textContent = file.name.split(".").pop()?.toUpperCase() ?? "?";

    const info = document.createElement("div");
    info.className = "compress-file-info";
    const name = document.createElement("div");
    name.className = "compress-file-name";
    name.textContent = file.name;
    name.title = file.name;
    const size = document.createElement("div");
    size.className = "compress-file-size";
    size.textContent = formatFileSize(file.size);
    info.appendChild(name);
    info.appendChild(size);

    const removeBtn = document.createElement("button");
    removeBtn.className = "compress-file-remove";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove";
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      const idx = selectedFiles.indexOf(file);
      if (idx !== -1) selectedFiles.splice(idx, 1);
      const allIdx = allUploadedFiles.indexOf(file);
      if (allIdx !== -1) allUploadedFiles.splice(allIdx, 1);
      if (selectedFiles.length === 0) {
        compressResetState();
      } else {
        compressRenderFiles();
        updateProcessButton();
      }
    };

    item.appendChild(removeBtn);
    item.appendChild(ext);
    item.appendChild(info);
    grid.appendChild(item);
  }
  ui.compressFileList.appendChild(grid);
}

/** Reset compress tool state — show drop zone, clear files */
function compressResetState() {
  selectedFiles = [];
  allUploadedFiles = [];
  conversionQueue = [];
  currentQueueIndex = 0;
  ui.compressDropZone?.classList.remove("hidden");
  ui.compressWorkspace?.classList.add("hidden");
  if (ui.compressFileList) ui.compressFileList.innerHTML = "";
  updateProcessButton();
}

// Compress drop zone: click → trigger file input
ui.compressDropZone?.addEventListener("click", () => ui.compressFileInput?.click());

// Compress drop zone: drag-and-drop
ui.compressDropZone?.addEventListener("dragover", (e) => e.preventDefault());
ui.compressDropZone?.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer?.files) compressLoadFiles(Array.from(e.dataTransfer.files));
});

// Compress file input change handler
ui.compressFileInput?.addEventListener("change", () => {
  const files = ui.compressFileInput.files;
  if (files && files.length > 0) {
    compressLoadFiles(Array.from(files));
    ui.compressFileInput.value = "";
  }
});

// Also handle window drops on compress page
window.addEventListener("drop", (e) => {
  if (activeTool !== "compress") return;
  e.preventDefault();
  if (e.dataTransfer?.files) compressLoadFiles(Array.from(e.dataTransfer.files));
});

const IMAGE_TOOL_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif", "avif", "ico", "heif", "heic"]);

// ── miniPaint Bridge ─────────────────────────────────────────────────────────

/** Wait for miniPaint iframe to fully load and expose its API */
function waitForMiniPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (miniPaintReady) { resolve(); return; }
    const frame = ui.imgFrame;
    if (!frame) { resolve(); return; }
    const check = () => {
      try {
        const win = frame.contentWindow as any;
        if (win && win.Layers && win.FileOpen) {
          miniPaintReady = true;
          resolve();
          return;
        }
      } catch {}
      setTimeout(check, 100);
    };
    frame.addEventListener("load", () => setTimeout(check, 200), { once: true });
    // If already loaded, check immediately
    check();
  });
}

/** Sync miniPaint theme with the host page */
function applyMiniPaintTheme() {
  try {
    const frame = ui.imgFrame;
    if (!frame || !miniPaintReady) return;
    const body = frame.contentDocument?.body;
    if (!body) return;
    const hostTheme = document.documentElement.getAttribute("data-theme");
    body.classList.toggle("theme-light", hostTheme === "light");
  } catch {}
}

/** Load an image file into miniPaint as a new layer */
async function loadImageIntoMiniPaint(file: File): Promise<void> {
  await waitForMiniPaint();
  const win = ui.imgFrame.contentWindow as any;
  if (!win?.Layers) return;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const layer = {
        name: file.name,
        type: "image",
        data: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        width_original: img.naturalWidth || img.width,
        height_original: img.naturalHeight || img.height,
      };
      win.Layers.insert(layer);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = URL.createObjectURL(file);
  });
}

/** Load processed bytes back into miniPaint as a new layer */
async function loadBytesIntoMiniPaint(bytes: Uint8Array, name: string): Promise<void> {
  if (!miniPaintReady) return;
  const win = ui.imgFrame.contentWindow as any;
  if (!win?.Layers) return;

  return new Promise((resolve) => {
    const blob = new Blob([bytes as BlobPart], { type: "image/png" });
    const img = new Image();
    img.onload = () => {
      const layer = {
        name: name,
        type: "image",
        data: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        width_original: img.naturalWidth || img.width,
        height_original: img.naturalHeight || img.height,
      };
      win.Layers.insert(layer);
      URL.revokeObjectURL(img.src);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = URL.createObjectURL(blob);
  });
}

/** Get composited image from all miniPaint layers as PNG bytes */
async function getImageFromMiniPaint(): Promise<Uint8Array | null> {
  if (!miniPaintReady) return null;
  const win = ui.imgFrame.contentWindow as any;
  if (!win?.Layers) return null;

  const dim = win.Layers.get_dimensions();
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = dim.width;
  tempCanvas.height = dim.height;
  const ctx = tempCanvas.getContext("2d")!;
  win.Layers.convert_layers_to_canvas(ctx);

  // Convert canvas to PNG bytes via toBlob (avoids base64 round-trip)
  const blob = await new Promise<Blob>((resolve, reject) => {
    tempCanvas.toBlob(b => b ? resolve(b) : reject(new Error("Canvas export failed")), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Extract the "Mask" layer as ImageData for inpainting, or null if none exists */
function getMaskFromMiniPaint(): ImageData | null {
  if (!miniPaintReady) return null;
  const win = ui.imgFrame.contentWindow as any;
  if (!win?.Layers) return null;

  // Find layer named "Mask" (case-insensitive) — try multiple API paths
  const layers: any[] = win.Layers.get_layers?.() ?? win.config?.layers ?? win.Layers?.layers ?? [];
  const maskLayer = layers.find((l: any) => l.name?.toLowerCase() === "mask" && l.type === "image");
  if (!maskLayer) return null;

  // Render just this layer to a canvas
  const dim = win.Layers.get_dimensions();
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = dim.width;
  tempCanvas.height = dim.height;
  const ctx = tempCanvas.getContext("2d")!;

  // Draw the mask layer's data
  if (maskLayer.data instanceof HTMLCanvasElement || maskLayer.data instanceof HTMLImageElement) {
    ctx.drawImage(maskLayer.data, maskLayer.x || 0, maskLayer.y || 0, maskLayer.width, maskLayer.height);
  } else if (maskLayer.link) {
    // Try canvas reference
    const layerCanvas = maskLayer.link;
    if (layerCanvas instanceof HTMLCanvasElement) {
      ctx.drawImage(layerCanvas, maskLayer.x || 0, maskLayer.y || 0, maskLayer.width, maskLayer.height);
    }
  }

  return ctx.getImageData(0, 0, dim.width, dim.height);
}

/** Show the miniPaint editor, hide drop zone */
function showMiniPaintEditor() {
  ui.imgDropZone?.classList.add("hidden");
  ui.imgFrame?.classList.remove("hidden");
}

/** Reset image tools state — show drop zone, reload iframe */
function imgResetState() {
  if (document.fullscreenElement) document.exitFullscreen();
  for (const url of imgOriginalUrls.values()) URL.revokeObjectURL(url);
  for (const url of imgProcessedUrls.values()) URL.revokeObjectURL(url);
  imgToolFiles = [];
  imgActiveIndex = 0;
  imgProcessedData.clear();
  imgOriginalUrls.clear();
  imgProcessedUrls.clear();
  imgShowAfter = false;
  miniPaintReady = false;
  // Show drop zone, hide editor
  ui.imgDropZone?.classList.remove("hidden");
  ui.imgFrame?.classList.add("hidden");
  // Reset iframe
  if (ui.imgFrame) ui.imgFrame.removeAttribute("src");
}

/** Load files into the image tools — opens miniPaint editor */
function imgLoadFiles(files: File[]) {
  const imageFiles = files.filter(f =>
    f.type.startsWith("image/") || IMAGE_TOOL_EXTS.has(f.name.split(".").pop()?.toLowerCase() ?? "")
  );
  if (imageFiles.length === 0) return;

  imgToolFiles = imageFiles;
  selectedFiles = imgToolFiles;
  allUploadedFiles = imgToolFiles;

  // Lazy-load miniPaint iframe
  if (ui.imgFrame && !ui.imgFrame.src?.includes("minipaint")) {
    ui.imgFrame.src = "/minipaint/index.html";
  }
  showMiniPaintEditor();
  applyMiniPaintTheme();

  // Load first image into editor once ready
  (async () => {
    await waitForMiniPaint();
    applyMiniPaintTheme();
    for (const file of imageFiles) {
      await loadImageIntoMiniPaint(file);
    }
  })();
}

// Drop zone click → trigger file input
ui.imgDropZone?.addEventListener("click", () => ui.imgFileInput?.click());
// Drop zone drag-and-drop
ui.imgDropZone?.addEventListener("dragover", (e) => e.preventDefault());
ui.imgDropZone?.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer?.files) imgLoadFiles(Array.from(e.dataTransfer.files));
});

// File input change handler
ui.imgFileInput?.addEventListener("change", () => {
  const files = ui.imgFileInput.files;
  if (files && files.length > 0) {
    imgLoadFiles(Array.from(files));
    ui.imgFileInput.value = "";
  }
});

// Bridge: iframe inpaint tool → parent runInpainting() → iframe result
window.addEventListener("message", async (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type !== "inpaint-request") return;
  const iframe = ui.imgFrame;
  if (!iframe?.contentWindow) return;

  try {
    const { image, mask, width, height, model } = e.data;
    const imageBytes = new Uint8Array(image as ArrayBuffer);
    const maskImageData = new ImageData(new Uint8ClampedArray(mask as ArrayBuffer), width, height);

    // Temporarily switch model if iframe requests a specific one
    const prevModel = inpaintModel;
    if (model === "lama" || model === "migan") inpaintModel = model;

    inpaintEnabled = true;
    if (inpaintFeather) applyGaussianBlur(maskImageData, width, height, 3);

    const resultBytes = await runInpainting(imageBytes, "png", maskImageData);
    inpaintModel = prevModel;

    const resultBuf = resultBytes.buffer.slice(
      resultBytes.byteOffset,
      resultBytes.byteOffset + resultBytes.byteLength
    );
    iframe.contentWindow.postMessage({
      type: "inpaint-result",
      image: resultBuf,
    }, "*", [resultBuf]);
  } catch (err: any) {
    iframe.contentWindow!.postMessage({
      type: "inpaint-error",
      error: err?.message || String(err),
    }, "*");
  }
});

// Bridge: iframe remove-bg tool → parent removeBgLocal/Api() → iframe result
// Calls the removal functions directly (not applyBgRemoval which shows its own popup).
window.addEventListener("message", async (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type !== "removebg-request") return;
  const iframe = ui.imgFrame;
  if (!iframe?.contentWindow) return;

  try {
    const imageBytes = new Uint8Array(e.data.image as ArrayBuffer);
    const f: FileData = { name: "image.png", bytes: imageBytes };

    const outBytes = bgMode === "api"
      ? await removeBgViaApi(f.bytes, "png")
      : await removeBgLocal(f, "png");

    const resultBuf = outBytes.buffer.slice(
      outBytes.byteOffset,
      outBytes.byteOffset + outBytes.byteLength
    );
    iframe.contentWindow.postMessage({
      type: "removebg-result",
      image: resultBuf,
    }, "*", [resultBuf]);
  } catch (err: any) {
    iframe.contentWindow!.postMessage({
      type: "removebg-error",
      error: err?.message || String(err),
    }, "*");
  }
});

// ── AI Image Generation via OpenRouter ──────────────────────────────────────

async function generateImageViaOpenRouter(
  prompt: string,
  model: string,
  size: string,
  imageOnly: boolean,
  canvasWidth: number,
  canvasHeight: number,
  inputImage?: ArrayBuffer,
): Promise<Uint8Array> {
  if (!openrouterApiKey) throw new Error("No OpenRouter API key. Add your key in Settings \u2192 Image Tools.");

  // Pick aspect ratio from canvas dimensions
  let aspect = "1:1";
  if (canvasWidth > 0 && canvasHeight > 0) {
    const r = canvasWidth / canvasHeight;
    if (r > 1.3) aspect = "3:2";
    else if (r < 0.77) aspect = "2:3";
  }

  // Determine image resolution tier from explicit size choice
  let resTier = "1K"; // default
  const isGemini = model.startsWith("google/");
  if (size === "auto" || size === "1024x1024") {
    // Use 0.5K on Gemini 3.1 Flash for cost savings (roughly half the tokens)
    resTier = model === "google/gemini-3.1-flash-image-preview" ? "0.5K" : "1K";
  } else if (size === "1024x1536" || size === "1536x1024") {
    resTier = "1K";
  } else if (size === "hd") {
    resTier = "2K";
  }

  // Build message content — multimodal if editing an existing image
  let userContent: any = prompt;
  if (inputImage) {
    const bytes = new Uint8Array(inputImage);
    let b64 = "";
    // Convert to base64 in chunks to avoid call stack overflow
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      b64 += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    b64 = btoa(b64);
    userContent = [
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      { type: "text", text: prompt },
    ];
  }

  const body: any = {
    model,
    messages: [{ role: "user", content: userContent }],
    modalities: imageOnly ? ["image"] : ["image", "text"],
  };

  if (isGemini) {
    // Gemini models use image_config for size/aspect control
    body.image_config = { image_size: resTier, aspect_ratio: aspect };
  } else if (size && size !== "auto") {
    body.image_size = size;
  }

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    referrerPolicy: "no-referrer",
    headers: {
      "Authorization": `Bearer ${openrouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenRouter API error ${resp.status}: ${text || resp.statusText}`);
  }

  const json = await resp.json();
  const choice = json.choices?.[0]?.message;
  if (!choice) throw new Error("No response from model.");

  // Find image URL — check both content array (OpenAI-style) and images array
  let dataUrl: string | null = null;

  // 1) content as array with image_url parts
  if (Array.isArray(choice.content)) {
    const imgPart = choice.content.find((p: any) => p.type === "image_url" && p.image_url?.url);
    if (imgPart) dataUrl = imgPart.image_url.url;
  }

  // 2) images array on the message
  if (!dataUrl && Array.isArray(choice.images)) {
    const imgPart = choice.images.find((p: any) => p.type === "image_url" && p.image_url?.url);
    if (imgPart) dataUrl = imgPart.image_url.url;
  }

  if (!dataUrl) throw new Error("Model did not return an image. Try a different model or prompt.");

  // Handle both data URLs and regular URLs
  let bytes: Uint8Array;
  if (dataUrl.startsWith("data:")) {
    const base64 = dataUrl.split(",")[1];
    if (!base64) throw new Error("Invalid image data URL.");
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const imgResp = await fetch(dataUrl, { referrerPolicy: "no-referrer" });
    if (!imgResp.ok) throw new Error("Failed to fetch generated image.");
    bytes = new Uint8Array(await imgResp.arrayBuffer());
  }

  return bytes;
}

// Bridge: iframe aigen tool → parent OpenRouter API → iframe result
window.addEventListener("message", async (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type !== "aigen-request") return;
  const iframe = ui.imgFrame;
  if (!iframe?.contentWindow) return;

  try {
    const { prompt, model, size, imageOnly, canvasWidth, canvasHeight, inputImage } = e.data;
    const resultBytes = await generateImageViaOpenRouter(prompt, model, size, !!imageOnly, canvasWidth || 0, canvasHeight || 0, inputImage || undefined);
    const resultBuf = resultBytes.buffer.slice(
      resultBytes.byteOffset,
      resultBytes.byteOffset + resultBytes.byteLength,
    );
    iframe.contentWindow.postMessage({
      type: "aigen-result",
      image: resultBuf,
      wasEdit: !!inputImage,
    }, "*", [resultBuf]);
  } catch (err: any) {
    iframe.contentWindow!.postMessage({
      type: "aigen-error",
      error: err?.message || String(err),
    }, "*");
  }
});

// Bridge: iframe fullscreen button → parent Fullscreen API toggle
window.addEventListener("message", (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type !== "fullscreen-toggle") return;
  const container = ui.imgEditorContainer;
  if (!container) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    (container.requestFullscreen?.() ?? (container as any).webkitRequestFullscreen?.());
  }
});

document.addEventListener("fullscreenchange", () => {
  const isFs = !!document.fullscreenElement;
  // Notify iframe of fullscreen state change
  const iframe = ui.imgFrame;
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: "fullscreen-changed", isFullscreen: isFs }, "*");
  }
});

// ── Video Editor: Upload, Preview, Timeline, Processing ─────────────────────

/** Format seconds as M:SS.mmm */
function vidFormatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00.000";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(3).padStart(6, "0")}`;
}

/** Format seconds as M:SS for display */
function vidFormatTimeShort(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Parse time string (M:SS.mmm or M:SS) to seconds */
function vidParseTime(str: string): number | null {
  str = str.trim();
  const match = str.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    // Try just seconds
    const n = parseFloat(str);
    return isFinite(n) && n >= 0 ? n : null;
  }
  return parseInt(match[1]) * 60 + parseFloat(match[2]);
}

/** Update the timeline visuals based on trim state */
function vidUpdateTimeline() {
  if (!ui.vidTimeline || vidDuration <= 0) return;
  const startPct = (vidTrimStart / vidDuration) * 100;
  const endPct = (vidTrimEnd / vidDuration) * 100;
  if (ui.vidTrimRegion) {
    ui.vidTrimRegion.style.left = startPct + "%";
    ui.vidTrimRegion.style.width = (endPct - startPct) + "%";
  }
}

/** Update the playhead position */
function vidUpdatePlayhead() {
  if (!ui.vidPreview || !ui.vidPlayhead || vidDuration <= 0) return;
  const pct = (ui.vidPreview.currentTime / vidDuration) * 100;
  ui.vidPlayhead.style.left = pct + "%";
}

/** Determine if any edits are pending */
function vidHasEdits(): boolean {
  return vidTrimStart > 0.01 ||
    (vidDuration > 0 && vidTrimEnd < vidDuration - 0.01) ||
    vidRemoveAudio ||
    vidRemoveSubtitles ||
    vidEqBands.some(g => g !== 0) ||
    vidCropEnabled ||
    vidMergeFiles.length > 0 ||
    (vidSubFile !== null && (vidAddSubMux || vidAddSubBurn));
}

const VIDEO_TOOL_EXTS = new Set(["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv", "ogv", "m4v", "3gp", "ts", "mts", "hevc", "h265"]);

/** Load multiple video files into the editor */
function vidLoadFiles(files: File[]) {
  const videoFiles = files.filter(f =>
    f.type.startsWith("video/") || VIDEO_TOOL_EXTS.has(f.name.split(".").pop()?.toLowerCase() ?? "")
  );
  if (videoFiles.length === 0) return;

  // Deduplicate by name|size
  const existing = new Set(vidFiles.map(f => `${f.name}|${f.size}`));
  const merged = [...vidFiles, ...videoFiles.filter(f => !existing.has(`${f.name}|${f.size}`))];
  vidFiles = merged;

  // Clear processed results for fresh processing
  vidProcessedResults.clear();

  vidRenderFilmstrip();
  vidShowVideo(vidFiles.length > 1 ? vidFiles.length - 1 : 0);

  // Show filmstrip when we have files
  if (vidFiles.length > 0) {
    ui.vidFilmstrip?.classList.remove("hidden");
  }
}

/** Show video at index in the player */
function vidShowVideo(index: number) {
  if (index < 0 || index >= vidFiles.length) return;
  vidActiveIndex = index;

  // Load the file (this resets vidProcessedData/vidProcessedUrl)
  vidLoadFile(vidFiles[index]);

  // Restore processed data if this video was already processed
  if (vidProcessedResults.has(index)) {
    vidProcessedData = vidProcessedResults.get(index)!;
    if (vidProcessedUrl) URL.revokeObjectURL(vidProcessedUrl);
    vidProcessedUrl = URL.createObjectURL(new Blob([vidProcessedData.bytes as BlobPart], { type: "video/mp4" }));
  }

  // Update filmstrip active state
  const thumbs = ui.vidFilmstripGrid?.querySelectorAll(".vid-filmstrip-thumb");
  thumbs?.forEach((t, i) => t.classList.toggle("active", i === index));

  vidUpdateActionButton();
}

/** Render filmstrip thumbnails */
function vidRenderFilmstrip() {
  if (!ui.vidFilmstripGrid) return;
  ui.vidFilmstripGrid.innerHTML = "";

  // Revoke old thumbnail URLs
  for (const url of vidThumbUrls.values()) URL.revokeObjectURL(url);
  vidThumbUrls.clear();

  for (let i = 0; i < vidFiles.length; i++) {
    const thumb = document.createElement("div");
    thumb.className = "vid-filmstrip-thumb" + (i === vidActiveIndex ? " active" : "");

    const vid = document.createElement("video");
    const url = URL.createObjectURL(vidFiles[i]);
    vidThumbUrls.set(i, url);
    vid.src = url;
    vid.muted = true;
    vid.preload = "metadata";
    // Seek to 1s for a poster-like frame
    vid.addEventListener("loadedmetadata", () => { vid.currentTime = Math.min(1, vid.duration * 0.1); });
    thumb.appendChild(vid);

    const idx = i;
    thumb.addEventListener("click", () => vidShowVideo(idx));
    ui.vidFilmstripGrid.appendChild(thumb);
  }
}

/** Update the action button state */
function vidUpdateActionButton() {
  if (!ui.vidDownloadBtn) return;
  if (!vidFile) {
    ui.vidDownloadBtn.textContent = "Process";
    ui.vidDownloadBtn.classList.add("disabled");
    return;
  }
  const multi = applyAll && vidFiles.length > 1;
  if (multi && vidProcessedResults.size === vidFiles.length) {
    ui.vidDownloadBtn.textContent = "Download All";
    ui.vidDownloadBtn.classList.remove("disabled");
  } else if (vidProcessedData) {
    ui.vidDownloadBtn.textContent = "Download";
    ui.vidDownloadBtn.classList.remove("disabled");
  } else if (vidHasEdits()) {
    ui.vidDownloadBtn.textContent = multi ? "Process All" : "Process";
    ui.vidDownloadBtn.classList.remove("disabled");
  } else {
    ui.vidDownloadBtn.textContent = multi ? "Process All" : "Process";
    ui.vidDownloadBtn.classList.add("disabled");
  }
}

/** Update trim info display */
function vidUpdateTrimInfo() {
  if (!ui.vidTrimInfo || vidDuration <= 0) return;
  if (vidTrimStart > 0.01 || vidTrimEnd < vidDuration - 0.01) {
    const dur = vidTrimEnd - vidTrimStart;
    ui.vidTrimInfo.textContent = `Trim: ${vidFormatTimeShort(dur)} of ${vidFormatTimeShort(vidDuration)}`;
  } else {
    ui.vidTrimInfo.textContent = "";
  }
}

/** Load a video file into the editor */
function vidLoadFile(file: File) {
  // Clean up previous state
  if (vidObjectUrl) URL.revokeObjectURL(vidObjectUrl);
  if (vidProcessedUrl) URL.revokeObjectURL(vidProcessedUrl);
  vidProcessedData = null;
  vidProcessedUrl = null;
  vidRemoveAudio = false;
  vidRemoveSubtitles = false;
  vidHasAudio = false;
  vidHasSubtitles = false;
  vidSubtitleCount = 0;

  vidFile = file;
  vidObjectUrl = URL.createObjectURL(file);

  // Show preview
  ui.vidCanvas?.classList.add("has-video");
  ui.vidDropPrompt?.classList.add("hidden");
  ui.vidPreview?.classList.remove("hidden");
  if (ui.vidPreview) ui.vidPreview.src = vidObjectUrl;

  // Reset toggle states in UI (sidebar + settings panel)
  ui.vidRemoveAudioToggle?.classList.remove("active");
  ui.vidRemoveSubsToggle?.classList.remove("active");
  ui.vidMuxToggle?.classList.remove("active");
  ui.vidBurnToggle?.classList.remove("active");
  ui.vidPrefRemoveAudio?.classList.remove("active");
  ui.vidPrefRemoveSubs?.classList.remove("active");
  ui.vidPrefMux?.classList.remove("active");
  ui.vidPrefBurn?.classList.remove("active");
  vidSubFile = null;
  vidAddSubMux = false;
  vidAddSubBurn = false;
  vidEqBands = [0, 0, 0, 0, 0];
  vidSubStreams = [];
  if (ui.vidSubFileName) ui.vidSubFileName.textContent = "";
  if (ui.vidTrimCollapsible) ui.vidTrimCollapsible.classList.remove("open");
  if (ui.vidSubsCollapsible) ui.vidSubsCollapsible.classList.remove("open");
  if (ui.vidAddSubsCollapsible) ui.vidAddSubsCollapsible.classList.remove("open");
  if (ui.vidEqCollapsible) ui.vidEqCollapsible.classList.remove("open");
  ui.vidEqSliders?.forEach((s, i) => { s.value = "0"; if (ui.vidEqValues[i]) ui.vidEqValues[i].textContent = "0 dB"; });

  // Reset crop state
  vidCropEnabled = false;
  vidCropLockRatio = false;
  vidCropX = 0; vidCropY = 0; vidCropW = 0; vidCropH = 0;
  vidOrigWidth = 0; vidOrigHeight = 0;
  vidCropPreset = "";
  ui.vidCropOverlay?.classList.add("hidden");
  ui.vidCropToggle?.classList.remove("active");
  ui.vidCropLockRatioToggle?.classList.remove("active");
  ui.vidCropPresets?.forEach(b => b.classList.remove("active"));
  if (ui.vidCropInfo) ui.vidCropInfo.textContent = "";
  if (ui.vidCropXInput) ui.vidCropXInput.value = "0";
  if (ui.vidCropYInput) ui.vidCropYInput.value = "0";
  if (ui.vidCropWInput) ui.vidCropWInput.value = "0";
  if (ui.vidCropHInput) ui.vidCropHInput.value = "0";
  if (ui.vidCropManualCollapsible) ui.vidCropManualCollapsible.classList.remove("open");

  // Reset merge state
  vidMergeFiles = [];
  vidMergeReEncode = false;
  ui.vidMergeReEncode?.classList.remove("active");
  if (ui.vidMergeCollapsible) ui.vidMergeCollapsible.classList.remove("open");
  vidUpdateMergeList();

  // Reset language dropdown
  if (ui.vidSubLangSelect) {
    ui.vidSubLangSelect.innerHTML = '<option value="all">All tracks</option>';
  }

  // Probe for audio/subtitles in background
  probeVideoInfo(file).then(info => {
    vidHasAudio = info.hasAudio;
    vidHasSubtitles = info.hasSubtitles;
    vidSubtitleCount = info.subtitleCount;
    vidSubStreams = info.subtitles;

    // Populate language dropdown
    if (ui.vidSubLangSelect && info.subtitles.length > 0) {
      ui.vidSubLangSelect.innerHTML = '<option value="all">All tracks</option>';
      for (const sub of info.subtitles) {
        const opt = document.createElement("option");
        opt.value = String(sub.index);
        const lang = sub.language ? sub.language.toUpperCase() : "?";
        opt.textContent = `#${sub.index} ${lang} (${sub.codec})`;
        ui.vidSubLangSelect.appendChild(opt);
      }
    }
  }).catch(() => {});
}

/** Reset video editor state */
function vidResetState() {
  if (vidObjectUrl) URL.revokeObjectURL(vidObjectUrl);
  if (vidProcessedUrl) URL.revokeObjectURL(vidProcessedUrl);

  // Clear multi-video state
  vidFiles = [];
  vidActiveIndex = 0;
  vidProcessedResults.clear();
  for (const url of vidThumbUrls.values()) URL.revokeObjectURL(url);
  vidThumbUrls.clear();
  if (ui.vidFilmstrip) ui.vidFilmstrip.classList.add("hidden");
  if (ui.vidFilmstripGrid) ui.vidFilmstripGrid.innerHTML = "";

  vidFile = null;
  vidDuration = 0;
  vidTrimStart = 0;
  vidTrimEnd = 0;
  vidRemoveAudio = false;
  vidRemoveSubtitles = false;
  vidHasAudio = false;
  vidHasSubtitles = false;
  vidSubtitleCount = 0;
  vidProcessedData = null;
  vidObjectUrl = null;
  vidProcessedUrl = null;
  vidIsProcessing = false;

  if (ui.vidCanvas) ui.vidCanvas.classList.remove("has-video");
  if (ui.vidDropPrompt) ui.vidDropPrompt.classList.remove("hidden");
  if (ui.vidPreview) { ui.vidPreview.classList.add("hidden"); ui.vidPreview.src = ""; ui.vidPreview.pause(); }
  if (ui.vidWorkspace) ui.vidWorkspace.classList.add("hidden");
  if (ui.vidRemoveAudioToggle) ui.vidRemoveAudioToggle.classList.remove("active");
  if (ui.vidRemoveSubsToggle) ui.vidRemoveSubsToggle.classList.remove("active");
  if (ui.vidPrefRemoveAudio) ui.vidPrefRemoveAudio.classList.remove("active");
  if (ui.vidPrefRemoveSubs) ui.vidPrefRemoveSubs.classList.remove("active");
  if (ui.vidTrimStartInput) ui.vidTrimStartInput.value = "";
  if (ui.vidTrimEndInput) ui.vidTrimEndInput.value = "";
  if (ui.vidGenerateProgress) ui.vidGenerateProgress.classList.add("hidden");
  vidSubFile = null;
  vidAddSubMux = false;
  vidAddSubBurn = false;
  vidEqBands = [0, 0, 0, 0, 0];
  vidSubStreams = [];
  if (ui.vidMuxToggle) ui.vidMuxToggle.classList.remove("active");
  if (ui.vidBurnToggle) ui.vidBurnToggle.classList.remove("active");
  if (ui.vidPrefMux) ui.vidPrefMux.classList.remove("active");
  if (ui.vidPrefBurn) ui.vidPrefBurn.classList.remove("active");
  if (ui.vidSubFileName) ui.vidSubFileName.textContent = "";
  if (ui.vidTrimCollapsible) ui.vidTrimCollapsible.classList.remove("open");
  if (ui.vidSubsCollapsible) ui.vidSubsCollapsible.classList.remove("open");
  if (ui.vidAddSubsCollapsible) ui.vidAddSubsCollapsible.classList.remove("open");
  if (ui.vidEqCollapsible) ui.vidEqCollapsible.classList.remove("open");
  ui.vidEqSliders?.forEach((s, i) => { s.value = "0"; if (ui.vidEqValues[i]) ui.vidEqValues[i].textContent = "0 dB"; });
  if (ui.vidSubLangSelect) ui.vidSubLangSelect.innerHTML = '<option value="all">All tracks</option>';

  // Reset crop
  vidCropEnabled = false;
  vidCropLockRatio = false;
  vidCropX = 0; vidCropY = 0; vidCropW = 0; vidCropH = 0;
  vidOrigWidth = 0; vidOrigHeight = 0;
  vidCropPreset = "";
  ui.vidCropOverlay?.classList.add("hidden");
  ui.vidCropToggle?.classList.remove("active");
  ui.vidCropLockRatioToggle?.classList.remove("active");
  ui.vidCropPresets?.forEach(b => b.classList.remove("active"));
  if (ui.vidCropInfo) ui.vidCropInfo.textContent = "";
  if (ui.vidCropManualCollapsible) ui.vidCropManualCollapsible.classList.remove("open");

  // Reset merge
  vidMergeFiles = [];
  vidMergeReEncode = false;
  ui.vidMergeReEncode?.classList.remove("active");
  if (ui.vidMergeCollapsible) ui.vidMergeCollapsible.classList.remove("open");
  vidUpdateMergeList();

  vidUpdateActionButton();
}

// Video loadedmetadata: set duration, show workspace, capture resolution
ui.vidPreview?.addEventListener("loadedmetadata", () => {
  vidDuration = ui.vidPreview.duration;
  vidTrimStart = 0;
  vidTrimEnd = vidDuration;

  // Capture native video resolution for crop
  vidOrigWidth = ui.vidPreview.videoWidth;
  vidOrigHeight = ui.vidPreview.videoHeight;
  vidCropW = vidOrigWidth;
  vidCropH = vidOrigHeight;
  vidCropX = 0;
  vidCropY = 0;
  vidCropEnabled = false;
  if (ui.vidCropWInput) ui.vidCropWInput.value = String(vidOrigWidth);
  if (ui.vidCropHInput) ui.vidCropHInput.value = String(vidOrigHeight);
  if (ui.vidCropXInput) ui.vidCropXInput.value = "0";
  if (ui.vidCropYInput) ui.vidCropYInput.value = "0";

  if (ui.vidTrimStartInput) ui.vidTrimStartInput.value = vidFormatTime(0);
  if (ui.vidTrimEndInput) ui.vidTrimEndInput.value = vidFormatTime(vidDuration);
  if (ui.vidTimeDisplay) ui.vidTimeDisplay.textContent = `${vidFormatTimeShort(0)} / ${vidFormatTimeShort(vidDuration)}`;

  ui.vidWorkspace?.classList.remove("hidden");
  vidUpdateTimeline();
  vidUpdateTrimInfo();
  vidUpdateActionButton();
});

// Video timeupdate: update playhead and time display (throttled to rAF)
{
  let timeupdateScheduled = false;
  ui.vidPreview?.addEventListener("timeupdate", () => {
    if (timeupdateScheduled) return;
    timeupdateScheduled = true;
    requestAnimationFrame(() => {
      timeupdateScheduled = false;
      vidUpdatePlayhead();
      if (ui.vidTimeDisplay) {
        ui.vidTimeDisplay.textContent = `${vidFormatTimeShort(ui.vidPreview.currentTime)} / ${vidFormatTimeShort(vidDuration)}`;
      }
    });
  });
}

// Play/pause button
ui.vidPlayBtn?.addEventListener("click", () => {
  if (!ui.vidPreview || !vidFile) return;
  if (ui.vidPreview.paused) {
    ui.vidPreview.play();
  } else {
    ui.vidPreview.pause();
  }
});

ui.vidPreview?.addEventListener("play", () => {
  const playIcon = ui.vidPlayBtn?.querySelector(".vid-icon-play");
  const pauseIcon = ui.vidPlayBtn?.querySelector(".vid-icon-pause");
  playIcon?.classList.add("hidden");
  pauseIcon?.classList.remove("hidden");
});

ui.vidPreview?.addEventListener("pause", () => {
  const playIcon = ui.vidPlayBtn?.querySelector(".vid-icon-play");
  const pauseIcon = ui.vidPlayBtn?.querySelector(".vid-icon-pause");
  playIcon?.classList.remove("hidden");
  pauseIcon?.classList.add("hidden");
});

// Timeline click → seek
ui.vidTimeline?.addEventListener("click", (e) => {
  if (!ui.vidPreview || vidDuration <= 0) return;
  const rect = ui.vidTimeline.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  ui.vidPreview.currentTime = pct * vidDuration;
  vidUpdatePlayhead();
});

// Handle drag for trim handles
function vidSetupHandleDrag(handle: HTMLElement, isLeft: boolean) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const timeline = ui.vidTimeline;
    if (!timeline || vidDuration <= 0) return;

    const onMove = (me: PointerEvent) => {
      const rect = timeline.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      const time = pct * vidDuration;

      if (isLeft) {
        vidTrimStart = Math.min(time, vidTrimEnd - 0.1);
        if (ui.vidTrimStartInput) ui.vidTrimStartInput.value = vidFormatTime(vidTrimStart);
      } else {
        vidTrimEnd = Math.max(time, vidTrimStart + 0.1);
        if (ui.vidTrimEndInput) ui.vidTrimEndInput.value = vidFormatTime(vidTrimEnd);
      }

      vidInvalidateProcessed();
      vidUpdateTimeline();
      vidUpdateTrimInfo();
    };

    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}
vidSetupHandleDrag(ui.vidHandleLeft, true);
vidSetupHandleDrag(ui.vidHandleRight, false);

// Trim input fields
ui.vidTrimStartInput?.addEventListener("change", () => {
  const t = vidParseTime(ui.vidTrimStartInput.value);
  if (t !== null && t >= 0 && t < vidTrimEnd) {
    vidTrimStart = t;
    vidInvalidateProcessed();
    vidUpdateTimeline();
    vidUpdateTrimInfo();
  }
  ui.vidTrimStartInput.value = vidFormatTime(vidTrimStart);
});

ui.vidTrimEndInput?.addEventListener("change", () => {
  const t = vidParseTime(ui.vidTrimEndInput.value);
  if (t !== null && t > vidTrimStart && t <= vidDuration) {
    vidTrimEnd = t;
    vidInvalidateProcessed();
    vidUpdateTimeline();
    vidUpdateTrimInfo();
  }
  ui.vidTrimEndInput.value = vidFormatTime(vidTrimEnd);
});

// Reset trim
ui.vidTrimReset?.addEventListener("click", () => {
  vidTrimStart = 0;
  vidTrimEnd = vidDuration;
  if (ui.vidTrimStartInput) ui.vidTrimStartInput.value = vidFormatTime(0);
  if (ui.vidTrimEndInput) ui.vidTrimEndInput.value = vidFormatTime(vidDuration);
  vidInvalidateProcessed();
  vidUpdateTimeline();
  vidUpdateTrimInfo();
});

// Remove audio toggle
ui.vidRemoveAudioToggle?.addEventListener("click", () => {
  vidRemoveAudio = !vidRemoveAudio;
  ui.vidRemoveAudioToggle.classList.toggle("active", vidRemoveAudio);
  vidInvalidateProcessed();
});

// Remove subtitles toggle
ui.vidRemoveSubsToggle?.addEventListener("click", () => {
  vidRemoveSubtitles = !vidRemoveSubtitles;
  ui.vidRemoveSubsToggle.classList.toggle("active", vidRemoveSubtitles);
  vidInvalidateProcessed();
});

// Extract subtitles button
ui.vidExtractSubs?.addEventListener("click", async () => {
  if (!vidFile) return;
  ui.vidExtractSubs.textContent = "Extracting...";
  ui.vidExtractSubs.classList.add("disabled");
  try {
    const langVal = ui.vidSubLangSelect?.value;
    const filterIndex = langVal && langVal !== "all" ? parseInt(langVal) : undefined;
    const subs = await extractSubtitles(vidFile, filterIndex);
    if (subs.length === 0) {
      window.showPopup(
        `<h2>No subtitles found</h2>` +
        `<p>This video doesn't contain embedded subtitle tracks.</p>` +
        `<button onclick="window.hidePopup()">OK</button>`
      );
    } else {
      for (const sub of subs) {
        const blob = new Blob([sub.bytes as BlobPart], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = sub.name;
        link.click();
        URL.revokeObjectURL(url);
      }
      window.showPopup(
        `<h2>Extracted ${subs.length} subtitle track${subs.length > 1 ? "s" : ""}!</h2>` +
        `<button onclick="window.hidePopup()">OK</button>`
      );
    }
  } catch (e) {
    console.error("Subtitle extraction error:", e);
    window.showPopup(
      `<h2>Extraction failed</h2>` +
      `<p>${e instanceof Error ? e.message : String(e)}</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
  } finally {
    ui.vidExtractSubs.textContent = "Extract";
    ui.vidExtractSubs.classList.remove("disabled");
  }
});

// Generate subtitles button (Whisper AI)
ui.vidGenerateSubs?.addEventListener("click", async () => {
  if (!vidFile || vidIsProcessing) return;
  vidIsProcessing = true;
  ui.vidGenerateSubs.classList.add("disabled");
  ui.vidGenerateProgress?.classList.remove("hidden");

  window.showPopup(
    `<h2>Generating subtitles</h2>` +
    `<p>This may freeze the page for a while, especially with longer videos. Please leave this tab open and do not close it.</p>` +
    `<button onclick="window.hidePopup()">OK</button>`
  );

  try {
    const genLang = ui.vidGenLangSelect?.value || undefined;
    const genModel = (ui.vidGenModelSelect?.value as "base" | "small") || "small";
    const result = await generateSubtitles(vidFile, (stage, pct) => {
      if (ui.vidProgressFill) ui.vidProgressFill.style.width = pct + "%";
      if (ui.vidProgressText) ui.vidProgressText.textContent = stage;
    }, { language: genLang, model: genModel });

    // Download the SRT file
    const blob = new Blob([result.bytes as BlobPart], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.name;
    link.click();
    URL.revokeObjectURL(url);

    window.showPopup(
      `<h2>Subtitles generated!</h2>` +
      `<p>Downloaded ${result.name}</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
  } catch (e) {
    console.error("Subtitle generation error:", e);
    window.showPopup(
      `<h2>Generation failed</h2>` +
      `<p>${e instanceof Error ? e.message : String(e)}</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
  } finally {
    vidIsProcessing = false;
    ui.vidGenerateSubs.classList.remove("disabled");
    ui.vidGenerateProgress?.classList.add("hidden");
  }
});

// Volume slider
ui.vidVolumeSlider?.addEventListener("input", () => {
  if (ui.vidPreview) ui.vidPreview.volume = parseFloat(ui.vidVolumeSlider.value);
});

// Collapsible add-subtitles toggle
ui.vidAddSubsToggle?.addEventListener("click", () => {
  ui.vidAddSubsCollapsible?.classList.toggle("open");
});

// Collapsible EQ toggle
ui.vidEqToggle?.addEventListener("click", () => {
  ui.vidEqCollapsible?.classList.toggle("open");
});

// EQ slider handlers
ui.vidEqSliders?.forEach((slider, i) => {
  slider.addEventListener("input", () => {
    const val = parseInt(slider.value);
    vidEqBands[i] = val;
    if (ui.vidEqValues[i]) {
      ui.vidEqValues[i].textContent = (val > 0 ? "+" : "") + val + " dB";
    }
    vidInvalidateProcessed();
  });
});

// EQ reset button
ui.vidEqReset?.addEventListener("click", () => {
  vidEqBands = [0, 0, 0, 0, 0];
  ui.vidEqSliders?.forEach((s, i) => {
    s.value = "0";
    if (ui.vidEqValues[i]) ui.vidEqValues[i].textContent = "0 dB";
  });
  vidInvalidateProcessed();
});

// ── Crop helpers & handlers ──────────────────────────────────────────────────

/** Enforce even dimensions for h264 compatibility */
function vidEven(n: number): number { return Math.round(n / 2) * 2; }

/** Invalidate processed data on crop change */
function vidCropChanged() {
  vidInvalidateProcessed();
  vidUpdateCropOverlay();
  vidUpdateCropInfo();
}

/** Update crop info text */
function vidUpdateCropInfo() {
  if (!ui.vidCropInfo) return;
  if (vidCropEnabled) {
    ui.vidCropInfo.textContent = `${vidCropW}×${vidCropH} at (${vidCropX},${vidCropY})`;
  } else {
    ui.vidCropInfo.textContent = "";
  }
}

/** Update manual crop input values */
function vidUpdateCropInputs() {
  if (ui.vidCropXInput) ui.vidCropXInput.value = String(vidCropX);
  if (ui.vidCropYInput) ui.vidCropYInput.value = String(vidCropY);
  if (ui.vidCropWInput) ui.vidCropWInput.value = String(vidCropW);
  if (ui.vidCropHInput) ui.vidCropHInput.value = String(vidCropH);
}

/**
 * Get the video's displayed rect within the canvas (accounting for object-fit: contain)
 */
function vidGetVideoRect(): { vx: number; vy: number; vw: number; vh: number } | null {
  if (!ui.vidCanvas || !ui.vidPreview || vidOrigWidth === 0 || vidOrigHeight === 0) return null;
  const canvasRect = ui.vidCanvas.getBoundingClientRect();
  const cw = canvasRect.width;
  const ch = canvasRect.height;
  const videoAspect = vidOrigWidth / vidOrigHeight;
  const canvasAspect = cw / ch;
  let vw: number, vh: number, vx: number, vy: number;
  if (videoAspect > canvasAspect) {
    // Pillarboxed (letterboxed top/bottom)
    vw = cw;
    vh = cw / videoAspect;
    vx = 0;
    vy = (ch - vh) / 2;
  } else {
    // Letterboxed (pillarboxed left/right)
    vh = ch;
    vw = ch * videoAspect;
    vx = (cw - vw) / 2;
    vy = 0;
  }
  return { vx, vy, vw, vh };
}

/** Update the crop overlay position/size from crop state */
function vidUpdateCropOverlay() {
  if (!ui.vidCropOverlay || !ui.vidCropBox) return;
  if (!vidCropEnabled || vidOrigWidth === 0) {
    ui.vidCropOverlay.classList.add("hidden");
    return;
  }
  ui.vidCropOverlay.classList.remove("hidden");
  const rect = vidGetVideoRect();
  if (!rect) return;
  const { vx, vy, vw, vh } = rect;
  const scaleX = vw / vidOrigWidth;
  const scaleY = vh / vidOrigHeight;
  ui.vidCropBox.style.left = (vx + vidCropX * scaleX) + "px";
  ui.vidCropBox.style.top = (vy + vidCropY * scaleY) + "px";
  ui.vidCropBox.style.width = (vidCropW * scaleX) + "px";
  ui.vidCropBox.style.height = (vidCropH * scaleY) + "px";
}

/** Apply a crop preset ratio */
function vidApplyCropPreset(ratio: string) {
  if (vidOrigWidth === 0 || vidOrigHeight === 0) return;
  vidCropPreset = ratio;
  ui.vidCropPresets?.forEach(b => b.classList.toggle("active", b.dataset.ratio === ratio));

  // Auto-enable crop and lock ratio
  vidCropEnabled = true;
  ui.vidCropToggle?.classList.add("active");
  vidCropLockRatio = true;
  ui.vidCropLockRatioToggle?.classList.add("active");

  const [rw, rh] = ratio.split(":").map(Number);
  const targetAspect = rw / rh;
  const srcAspect = vidOrigWidth / vidOrigHeight;
  let w: number, h: number;
  if (targetAspect > srcAspect) {
    w = vidOrigWidth;
    h = Math.round(vidOrigWidth / targetAspect);
  } else {
    h = vidOrigHeight;
    w = Math.round(vidOrigHeight * targetAspect);
  }
  w = vidEven(w); h = vidEven(h);
  w = Math.min(w, vidOrigWidth); h = Math.min(h, vidOrigHeight);
  vidCropW = w; vidCropH = h;
  vidCropX = vidEven(Math.floor((vidOrigWidth - w) / 2));
  vidCropY = vidEven(Math.floor((vidOrigHeight - h) / 2));

  vidUpdateCropInputs();
  vidCropChanged();
}

// Crop enable/disable toggle
ui.vidCropToggle?.addEventListener("click", () => {
  vidCropEnabled = !vidCropEnabled;
  ui.vidCropToggle.classList.toggle("active", vidCropEnabled);
  if (vidCropEnabled && vidOrigWidth > 0) {
    // If crop matches full frame, default to centered 80% box
    if (vidCropX === 0 && vidCropY === 0 && vidCropW === vidOrigWidth && vidCropH === vidOrigHeight) {
      vidCropW = vidEven(Math.round(vidOrigWidth * 0.8));
      vidCropH = vidEven(Math.round(vidOrigHeight * 0.8));
      vidCropX = vidEven(Math.floor((vidOrigWidth - vidCropW) / 2));
      vidCropY = vidEven(Math.floor((vidOrigHeight - vidCropH) / 2));
      vidUpdateCropInputs();
    }
  }
  vidCropChanged();
});

// Lock aspect ratio toggle
ui.vidCropLockRatioToggle?.addEventListener("click", () => {
  vidCropLockRatio = !vidCropLockRatio;
  ui.vidCropLockRatioToggle.classList.toggle("active", vidCropLockRatio);
});

// Crop preset buttons
ui.vidCropPresets?.forEach(btn => {
  btn.addEventListener("click", () => {
    const ratio = btn.dataset.ratio ?? "";
    if (ratio) vidApplyCropPreset(ratio);
  });
});

// Manual crop toggle
ui.vidCropManualToggle?.addEventListener("click", () => {
  ui.vidCropManualCollapsible?.classList.toggle("open");
});

// Manual crop input handlers
function vidHandleCropInput() {
  if (vidOrigWidth === 0) return;
  let x = parseInt(ui.vidCropXInput?.value ?? "0") || 0;
  let y = parseInt(ui.vidCropYInput?.value ?? "0") || 0;
  let w = parseInt(ui.vidCropWInput?.value ?? "0") || 0;
  let h = parseInt(ui.vidCropHInput?.value ?? "0") || 0;
  // Enforce even
  x = vidEven(x); y = vidEven(y); w = vidEven(w); h = vidEven(h);
  // Clamp bounds
  w = Math.max(2, Math.min(w, vidOrigWidth));
  h = Math.max(2, Math.min(h, vidOrigHeight));
  x = Math.max(0, Math.min(x, vidOrigWidth - w));
  y = Math.max(0, Math.min(y, vidOrigHeight - h));
  vidCropX = x; vidCropY = y; vidCropW = w; vidCropH = h;
  vidCropEnabled = true;
  ui.vidCropToggle?.classList.add("active");
  vidCropPreset = "";
  ui.vidCropPresets?.forEach(b => b.classList.remove("active"));
  vidUpdateCropInputs();
  vidCropChanged();
}
ui.vidCropXInput?.addEventListener("change", vidHandleCropInput);
ui.vidCropYInput?.addEventListener("change", vidHandleCropInput);
ui.vidCropWInput?.addEventListener("change", vidHandleCropInput);
ui.vidCropHInput?.addEventListener("change", vidHandleCropInput);

// Crop reset
ui.vidCropReset?.addEventListener("click", () => {
  vidCropEnabled = false;
  ui.vidCropToggle?.classList.remove("active");
  vidCropLockRatio = false;
  ui.vidCropLockRatioToggle?.classList.remove("active");
  vidCropPreset = "";
  ui.vidCropPresets?.forEach(b => b.classList.remove("active"));
  vidCropX = 0; vidCropY = 0;
  vidCropW = vidOrigWidth; vidCropH = vidOrigHeight;
  vidUpdateCropInputs();
  vidCropChanged();
});

// Crop overlay drag interaction (move box + resize handles)
(() => {
  let dragType: "move" | string | null = null;
  let startMX = 0, startMY = 0;
  let startCropX = 0, startCropY = 0, startCropW = 0, startCropH = 0;
  let startAspect = 1;

  function onPointerDown(e: PointerEvent) {
    if (!vidCropEnabled || vidOrigWidth === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.classList.contains("vid-crop-handle")) {
      dragType = target.dataset.pos ?? null;
    } else if (target.id === "vid-crop-box" || target.closest("#vid-crop-box")) {
      dragType = "move";
    } else {
      return;
    }
    startMX = e.clientX; startMY = e.clientY;
    startCropX = vidCropX; startCropY = vidCropY;
    startCropW = vidCropW; startCropH = vidCropH;
    startAspect = startCropW / startCropH;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }

  let cropMoveRafId = 0;
  function onPointerMove(e: PointerEvent) {
    if (!dragType) return;
    // Coalesce rapid pointermove events into a single rAF
    if (cropMoveRafId) cancelAnimationFrame(cropMoveRafId);
    const clientX = e.clientX, clientY = e.clientY;
    cropMoveRafId = requestAnimationFrame(() => {
      cropMoveRafId = 0;
      if (!dragType) return;
    const rect = vidGetVideoRect();
    if (!rect) return;
    const scaleX = vidOrigWidth / rect.vw;
    const scaleY = vidOrigHeight / rect.vh;
    const dx = (clientX - startMX) * scaleX;
    const dy = (clientY - startMY) * scaleY;

    if (dragType === "move") {
      let nx = vidEven(Math.round(startCropX + dx));
      let ny = vidEven(Math.round(startCropY + dy));
      nx = Math.max(0, Math.min(nx, vidOrigWidth - vidCropW));
      ny = Math.max(0, Math.min(ny, vidOrigHeight - vidCropH));
      vidCropX = nx; vidCropY = ny;
    } else {
      let nx = startCropX, ny = startCropY, nw = startCropW, nh = startCropH;
      const pos = dragType;
      if (pos.includes("w")) { nx += dx; nw -= dx; }
      if (pos.includes("e")) { nw += dx; }
      if (pos.includes("n")) { ny += dy; nh -= dy; }
      if (pos.includes("s")) { nh += dy; }

      // Lock aspect ratio enforcement
      if (vidCropLockRatio && startAspect > 0) {
        nw = Math.round(nw); nh = Math.round(nh);
        const isCorner = (pos.length === 2); // nw, ne, sw, se
        if (isCorner) {
          // Use the larger delta to drive both dimensions
          if (Math.abs(nw - startCropW) >= Math.abs(nh - startCropH)) {
            nh = Math.round(nw / startAspect);
          } else {
            nw = Math.round(nh * startAspect);
          }
        } else if (pos === "n" || pos === "s") {
          nw = Math.round(nh * startAspect);
        } else { // e or w
          nh = Math.round(nw / startAspect);
        }
        // Recalculate origin for edges that anchor opposite side
        if (pos.includes("w")) nx = startCropX + startCropW - nw;
        if (pos.includes("n")) ny = startCropY + startCropH - nh;
        // Center the adjusted dimension for single-edge handles
        if (pos === "n" || pos === "s") {
          nx = startCropX + Math.round((startCropW - nw) / 2);
        }
        if (pos === "e" || pos === "w") {
          ny = startCropY + Math.round((startCropH - nh) / 2);
        }
      }

      // Enforce minimums
      nw = Math.max(vidEven(Math.round(nw)), 2);
      nh = Math.max(vidEven(Math.round(nh)), 2);
      nx = vidEven(Math.round(nx));
      ny = vidEven(Math.round(ny));
      // Clamp to video bounds
      if (nx < 0) { nw += nx; nx = 0; }
      if (ny < 0) { nh += ny; ny = 0; }
      if (nx + nw > vidOrigWidth) nw = vidOrigWidth - nx;
      if (ny + nh > vidOrigHeight) nh = vidOrigHeight - ny;
      nw = vidEven(nw); nh = vidEven(nh);
      vidCropX = nx; vidCropY = ny; vidCropW = nw; vidCropH = nh;
    }
    vidUpdateCropInputs();
    vidUpdateCropOverlay();
    vidUpdateCropInfo();
    }); // end rAF
  }

  function onPointerUp() {
    dragType = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    vidInvalidateProcessed();
  }

  ui.vidCropBox?.addEventListener("pointerdown", onPointerDown);
  document.querySelectorAll(".vid-crop-handle").forEach(h => {
    h.addEventListener("pointerdown", onPointerDown as EventListener);
  });
})();

// Update crop overlay on window resize (throttled to rAF)
{
  let resizeRafId = 0;
  window.addEventListener("resize", () => {
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = 0;
      vidUpdateCropOverlay();
    });
  });
}

// ── Merge handlers ──────────────────────────────────────────────────────────

/** Render the merge file list */
function vidUpdateMergeList() {
  if (!ui.vidMergeList) return;
  ui.vidMergeList.innerHTML = "";
  if (!vidFile && vidMergeFiles.length === 0) return;

  // Primary file (the loaded video)
  if (vidFile) {
    const item = document.createElement("div");
    item.className = "vid-merge-item primary";
    item.innerHTML = `<span class="vid-merge-item-index">#1</span>` +
      `<span class="vid-merge-item-name">${vidFile.name}</span>` +
      `<span class="vid-merge-item-badge">Primary</span>`;
    ui.vidMergeList.appendChild(item);
  }

  // Additional merge files
  vidMergeFiles.forEach((f, i) => {
    const idx = (vidFile ? 2 : 1) + i;
    const item = document.createElement("div");
    item.className = "vid-merge-item";

    const indexSpan = document.createElement("span");
    indexSpan.className = "vid-merge-item-index";
    indexSpan.textContent = `#${idx}`;

    const nameSpan = document.createElement("span");
    nameSpan.className = "vid-merge-item-name";
    nameSpan.textContent = f.name;

    const actions = document.createElement("div");
    actions.className = "vid-merge-item-actions";

    if (i > 0) {
      const upBtn = document.createElement("button");
      upBtn.className = "vid-merge-item-btn";
      upBtn.title = "Move up";
      upBtn.textContent = "\u25B2";
      upBtn.addEventListener("click", () => {
        [vidMergeFiles[i - 1], vidMergeFiles[i]] = [vidMergeFiles[i], vidMergeFiles[i - 1]];
        vidMergeChanged();
      });
      actions.appendChild(upBtn);
    }
    if (i < vidMergeFiles.length - 1) {
      const downBtn = document.createElement("button");
      downBtn.className = "vid-merge-item-btn";
      downBtn.title = "Move down";
      downBtn.textContent = "\u25BC";
      downBtn.addEventListener("click", () => {
        [vidMergeFiles[i], vidMergeFiles[i + 1]] = [vidMergeFiles[i + 1], vidMergeFiles[i]];
        vidMergeChanged();
      });
      actions.appendChild(downBtn);
    }
    const rmBtn = document.createElement("button");
    rmBtn.className = "vid-merge-item-btn";
    rmBtn.title = "Remove";
    rmBtn.textContent = "\u00D7";
    rmBtn.addEventListener("click", () => {
      vidMergeFiles.splice(i, 1);
      vidMergeChanged();
    });
    actions.appendChild(rmBtn);

    item.append(indexSpan, nameSpan, actions);
    ui.vidMergeList.appendChild(item);
  });
}

function vidMergeChanged() {
  vidInvalidateProcessed();
  vidUpdateMergeList();
}

// Trim collapsible toggle
ui.vidTrimColToggle?.addEventListener("click", () => {
  ui.vidTrimCollapsible?.classList.toggle("open");
});

// Subtitles collapsible toggle
ui.vidSubsColToggle?.addEventListener("click", () => {
  ui.vidSubsCollapsible?.classList.toggle("open");
});

// Merge collapsible toggle
ui.vidMergeToggle?.addEventListener("click", () => {
  ui.vidMergeCollapsible?.classList.toggle("open");
});

// Merge add button → open file input
ui.vidMergeAdd?.addEventListener("click", () => {
  ui.vidMergeFileInput?.click();
});

// Merge file input change
ui.vidMergeFileInput?.addEventListener("change", () => {
  const files = ui.vidMergeFileInput.files;
  if (files && files.length > 0) {
    for (const f of Array.from(files)) {
      if (f.type.startsWith("video/")) vidMergeFiles.push(f);
    }
    vidMergeChanged();
    ui.vidMergeFileInput.value = "";
  }
});

// Merge re-encode toggle
ui.vidMergeReEncode?.addEventListener("click", () => {
  vidMergeReEncode = !vidMergeReEncode;
  ui.vidMergeReEncode.classList.toggle("active", vidMergeReEncode);
  vidInvalidateProcessed();
});

// Fullscreen toggle
ui.vidFullscreenBtn?.addEventListener("click", () => {
  const col = ui.vidCanvasCol;
  if (!col) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    (col.requestFullscreen?.() ?? (col as any).webkitRequestFullscreen?.());
  }
});

document.addEventListener("fullscreenchange", () => {
  const isFs = !!document.fullscreenElement;
  ui.vidFullscreenBtn?.querySelector(".vid-icon-expand")?.classList.toggle("hidden", isFs);
  ui.vidFullscreenBtn?.querySelector(".vid-icon-collapse")?.classList.toggle("hidden", !isFs);
});

// Choose subtitle file button
ui.vidSubFileBtn?.addEventListener("click", () => {
  ui.vidSubFileInput?.click();
});

// Subtitle file input change
ui.vidSubFileInput?.addEventListener("change", () => {
  const files = ui.vidSubFileInput.files;
  if (files && files.length > 0) {
    vidSubFile = files[0];
    if (ui.vidSubFileName) ui.vidSubFileName.textContent = vidSubFile.name;
    vidInvalidateProcessed();
    ui.vidSubFileInput.value = "";
  }
});

// Mux toggle
ui.vidMuxToggle?.addEventListener("click", () => {
  vidAddSubMux = !vidAddSubMux;
  ui.vidMuxToggle.classList.toggle("active", vidAddSubMux);
  // If mux is on, turn off burn (they conflict)
  if (vidAddSubMux && vidAddSubBurn) {
    vidAddSubBurn = false;
    ui.vidBurnToggle?.classList.remove("active");
  }
  vidInvalidateProcessed();
});

// Burn toggle
ui.vidBurnToggle?.addEventListener("click", () => {
  vidAddSubBurn = !vidAddSubBurn;
  ui.vidBurnToggle.classList.toggle("active", vidAddSubBurn);
  // If burn is on, turn off mux (they conflict)
  if (vidAddSubBurn && vidAddSubMux) {
    vidAddSubMux = false;
    ui.vidMuxToggle?.classList.remove("active");
  }
  vidInvalidateProcessed();
});

// ── Video settings panel prefs (bidirectional sync with sidebar) ─────────────

// Persist generation model/language defaults
try {
  const savedModel = localStorage.getItem("vidPrefGenModel");
  const savedLang = localStorage.getItem("vidPrefGenLang");
  if (savedModel && ui.vidPrefGenModel) ui.vidPrefGenModel.value = savedModel;
  if (savedLang !== null && ui.vidPrefGenLang) ui.vidPrefGenLang.value = savedLang;
  // Apply saved defaults to sidebar selects too
  if (savedModel && ui.vidGenModelSelect) ui.vidGenModelSelect.value = savedModel;
  if (savedLang !== null && ui.vidGenLangSelect) ui.vidGenLangSelect.value = savedLang;
} catch {}

ui.vidPrefGenModel?.addEventListener("change", () => {
  const v = ui.vidPrefGenModel.value;
  if (ui.vidGenModelSelect) ui.vidGenModelSelect.value = v;
  try { localStorage.setItem("vidPrefGenModel", v); } catch {}
});
ui.vidPrefGenLang?.addEventListener("change", () => {
  const v = ui.vidPrefGenLang.value;
  if (ui.vidGenLangSelect) ui.vidGenLangSelect.value = v;
  try { localStorage.setItem("vidPrefGenLang", v); } catch {}
});
// Reverse sync: sidebar selects → settings panel
ui.vidGenModelSelect?.addEventListener("change", () => {
  if (ui.vidPrefGenModel) ui.vidPrefGenModel.value = ui.vidGenModelSelect.value;
  try { localStorage.setItem("vidPrefGenModel", ui.vidGenModelSelect.value); } catch {}
});
ui.vidGenLangSelect?.addEventListener("change", () => {
  if (ui.vidPrefGenLang) ui.vidPrefGenLang.value = ui.vidGenLangSelect.value;
  try { localStorage.setItem("vidPrefGenLang", ui.vidGenLangSelect.value); } catch {}
});

// Sync pref toggles with sidebar toggles (remove audio)
ui.vidPrefRemoveAudio?.addEventListener("click", () => {
  vidRemoveAudio = !vidRemoveAudio;
  ui.vidPrefRemoveAudio.classList.toggle("active", vidRemoveAudio);
  ui.vidRemoveAudioToggle?.classList.toggle("active", vidRemoveAudio);
  vidInvalidateProcessed();
});
// Sync pref toggles with sidebar toggles (remove subs)
ui.vidPrefRemoveSubs?.addEventListener("click", () => {
  vidRemoveSubtitles = !vidRemoveSubtitles;
  ui.vidPrefRemoveSubs.classList.toggle("active", vidRemoveSubtitles);
  ui.vidRemoveSubsToggle?.classList.toggle("active", vidRemoveSubtitles);
  vidInvalidateProcessed();
});
// Sync pref toggles with sidebar toggles (mux)
ui.vidPrefMux?.addEventListener("click", () => {
  vidAddSubMux = !vidAddSubMux;
  ui.vidPrefMux.classList.toggle("active", vidAddSubMux);
  ui.vidMuxToggle?.classList.toggle("active", vidAddSubMux);
  if (vidAddSubMux && vidAddSubBurn) {
    vidAddSubBurn = false;
    ui.vidPrefBurn?.classList.remove("active");
    ui.vidBurnToggle?.classList.remove("active");
  }
  vidInvalidateProcessed();
});
// Sync pref toggles with sidebar toggles (burn)
ui.vidPrefBurn?.addEventListener("click", () => {
  vidAddSubBurn = !vidAddSubBurn;
  ui.vidPrefBurn.classList.toggle("active", vidAddSubBurn);
  ui.vidBurnToggle?.classList.toggle("active", vidAddSubBurn);
  if (vidAddSubBurn && vidAddSubMux) {
    vidAddSubMux = false;
    ui.vidPrefMux?.classList.remove("active");
    ui.vidMuxToggle?.classList.remove("active");
  }
  vidInvalidateProcessed();
});

// Reverse sync: sidebar → settings panel for toggles
ui.vidRemoveAudioToggle?.addEventListener("click", () => {
  ui.vidPrefRemoveAudio?.classList.toggle("active", vidRemoveAudio);
});
ui.vidRemoveSubsToggle?.addEventListener("click", () => {
  ui.vidPrefRemoveSubs?.classList.toggle("active", vidRemoveSubtitles);
});
ui.vidMuxToggle?.addEventListener("click", () => {
  ui.vidPrefMux?.classList.toggle("active", vidAddSubMux);
  ui.vidPrefBurn?.classList.toggle("active", vidAddSubBurn);
});
ui.vidBurnToggle?.addEventListener("click", () => {
  ui.vidPrefBurn?.classList.toggle("active", vidAddSubBurn);
  ui.vidPrefMux?.classList.toggle("active", vidAddSubMux);
});

// Canvas click → file input (empty state only)
ui.vidCanvas?.addEventListener("click", () => {
  if (ui.vidCanvas.classList.contains("has-video")) return;
  ui.vidFileInput?.click();
});

// Canvas drag-and-drop
ui.vidCanvas?.addEventListener("dragover", (e) => e.preventDefault());
ui.vidCanvas?.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer?.files) {
    const files = Array.from(e.dataTransfer.files);
    vidLoadFiles(files);
  }
});

// File input change
ui.vidFileInput?.addEventListener("change", () => {
  const files = ui.vidFileInput.files;
  if (files && files.length > 0) {
    vidLoadFiles(Array.from(files));
    ui.vidFileInput.value = "";
  }
});

// Add more button
ui.vidAddMore?.addEventListener("click", () => {
  ui.vidFileInput?.click();
});

// Apply-all toggle
if (ui.applyAllToggle) {
  ui.applyAllToggle.classList.toggle("active", applyAll);
  ui.applyAllToggle.addEventListener("click", () => {
    applyAll = !applyAll;
    ui.applyAllToggle.classList.toggle("active", applyAll);
    try { localStorage.setItem("convert-apply-all", String(applyAll)); } catch {}
    vidUpdateActionButton();
  });
}

/** Process a single video file with current settings, returning the result */
async function vidProcessSingleFile(file: File, label: string): Promise<FileData> {
  const hasEq = vidEqBands.some(g => g !== 0);
  const hasCrop = vidCropEnabled;
  const hasStandardEdits = vidTrimStart > 0.01 ||
    (vidDuration > 0 && vidTrimEnd < vidDuration - 0.01) ||
    vidRemoveAudio || vidRemoveSubtitles || hasEq || hasCrop;
  const hasSubAdd = vidSubFile && (vidAddSubMux || vidAddSubBurn);
  const hasMerge = vidMergeFiles.length > 0;

  let result: FileData;

  if (hasStandardEdits) {
    result = await processVideo(file, {
      trimStart: vidTrimStart,
      trimEnd: vidTrimEnd,
      removeAudio: vidRemoveAudio,
      removeSubtitles: vidRemoveSubtitles,
      eqBands: hasEq ? vidEqFreqs.map((freq, i) => ({ freq, gain: vidEqBands[i] })) : undefined,
      crop: hasCrop ? { x: vidCropX, y: vidCropY, w: vidCropW, h: vidCropH } : undefined,
    }, (pct) => {
      const popup = document.getElementById("popup");
      if (popup) {
        const p = popup.querySelector("p");
        if (p) p.textContent = `${label} ${pct}%`;
      }
    });
  } else {
    const buf = await file.arrayBuffer();
    result = { name: file.name, bytes: new Uint8Array(buf) };
  }

  // Add subtitles if configured
  if (hasSubAdd && vidSubFile) {
    const mode = vidAddSubBurn ? "burn" : "mux";
    const popup = document.getElementById("popup");
    if (popup) {
      const p = popup.querySelector("p");
      if (p) p.textContent = `${label} ${mode === "burn" ? "Burning" : "Muxing"} subtitles...`;
    }
    const tmpFile = new File([result.bytes as BlobPart], result.name, { type: "video/mp4" });
    result = await addSubtitlesToVideo(tmpFile, vidSubFile, { mode }, (pct) => {
      const popup2 = document.getElementById("popup");
      if (popup2) {
        const p = popup2.querySelector("p");
        if (p) p.textContent = `${label} ${mode === "burn" ? "Burning" : "Muxing"} subtitles... ${pct}%`;
      }
    });
  }

  // Merge with additional files if configured
  if (hasMerge) {
    const popup = document.getElementById("popup");
    if (popup) {
      const p = popup.querySelector("p");
      if (p) p.textContent = `${label} Merging...`;
    }
    const primaryFile = new File([result.bytes as BlobPart], result.name, { type: "video/mp4" });
    const allFiles = [primaryFile, ...vidMergeFiles];
    result = await mergeVideos(allFiles, vidMergeReEncode, (pct) => {
      const popup2 = document.getElementById("popup");
      if (popup2) {
        const p = popup2.querySelector("p");
        if (p) p.textContent = `${label} Merging... ${pct}%`;
      }
    });
  }

  return result;
}

// Action button: Process or Download
ui.vidDownloadBtn?.addEventListener("click", async () => {
  if (ui.vidDownloadBtn.classList.contains("disabled") || !vidFile) return;

  const batchMode = applyAll && vidFiles.length > 1;

  // Download mode — all results ready
  if (batchMode && vidProcessedResults.size === vidFiles.length) {
    const results = Array.from(vidProcessedResults.values());
    if (archiveMultiOutput) {
      const zip = new JSZip();
      for (let i = 0; i < results.length; i++) {
        zip.file(results[i].name, results[i].bytes);
        if (i % 10 === 9) {
          await new Promise(r => requestAnimationFrame(r));
        }
      }
      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      downloadFile(zipBytes, "edited_videos.zip");
    } else {
      for (const f of results) downloadFile(f.bytes, f.name);
    }
    return;
  }

  if (vidProcessedData && !batchMode) {
    // Single download mode
    const blob = new Blob([vidProcessedData.bytes as BlobPart], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = vidProcessedData.name;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  // Process mode
  if (vidIsProcessing) return;
  vidIsProcessing = true;
  ui.vidDownloadBtn.textContent = "Processing...";
  ui.vidDownloadBtn.classList.add("disabled");

  try {
    if (batchMode) {
      // Batch process all videos
      window.showPopup(`<h2>Processing ${vidFiles.length} videos...</h2><p>Starting...</p>`);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const results: FileData[] = [];
      for (let i = 0; i < vidFiles.length; i++) {
        const label = `[${i + 1}/${vidFiles.length}]`;
        const popup = document.getElementById("popup");
        if (popup) {
          const p = popup.querySelector("p");
          if (p) p.textContent = `${label} Processing ${vidFiles[i].name}...`;
        }
        const result = await vidProcessSingleFile(vidFiles[i], label);
        results.push(result);
        vidProcessedResults.set(i, result);
      }

      // Set current video's processed data
      if (vidProcessedResults.has(vidActiveIndex)) {
        vidProcessedData = vidProcessedResults.get(vidActiveIndex)!;
        if (vidProcessedUrl) URL.revokeObjectURL(vidProcessedUrl);
        vidProcessedUrl = URL.createObjectURL(new Blob([vidProcessedData.bytes as BlobPart], { type: "video/mp4" }));
      }

      // Download
      if (archiveMultiOutput) {
        const zip = new JSZip();
        for (let i = 0; i < results.length; i++) {
          zip.file(results[i].name, results[i].bytes);
          if (i % 10 === 9) {
            await new Promise(r => requestAnimationFrame(r));
          }
        }
        const zipBytes = await zip.generateAsync({ type: "uint8array" });
        downloadFile(zipBytes, "edited_videos.zip");
      } else {
        for (const f of results) downloadFile(f.bytes, f.name);
      }

      const totalSize = results.reduce((s, f) => s + f.bytes.length, 0);
      window.showPopup(
        `<h2>${results.length} videos processed!</h2>` +
        `<p>Total size: ${formatFileSize(totalSize)}</p>` +
        (archiveMultiOutput ? `<p>Delivered as ZIP archive.</p>` : ``) +
        `<button onclick="window.hidePopup()">OK</button>`
      );
    } else {
      // Single video process
      window.showPopup("<h2>Processing video...</h2><p>This may take a moment.</p>");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const result = await vidProcessSingleFile(vidFile, "Processing...");

      vidProcessedData = result;
      vidProcessedResults.set(vidActiveIndex, result);
      if (vidProcessedUrl) URL.revokeObjectURL(vidProcessedUrl);
      vidProcessedUrl = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: "video/mp4" }));

      const sizeStr = formatFileSize(result.bytes.length);
      window.showPopup(
        `<h2>Video processed!</h2>` +
        `<p>Output: ${result.name} (${sizeStr})</p>` +
        `<button onclick="window.hidePopup()">OK</button>`
      );
    }
  } catch (e) {
    console.error("Video processing error:", e);
    window.showPopup(
      `<h2>Processing failed</h2>` +
      `<p>${e instanceof Error ? e.message : String(e)}</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
  } finally {
    vidIsProcessing = false;
    vidUpdateActionButton();
  }
});

ui.convertButton.onclick = async function () {

  const inputFiles = selectedFiles;

  if (inputFiles.length === 0) {
    return alert("Select an input file.");
  }

  // ── Process mode: resize / remove background without conversion ──
  if (ui.convertButton.hasAttribute("data-process-mode")) {
    try {
      window.showPopup("<h2>Processing...</h2>");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      let fileData: FileData[] = [];
      for (const file of inputFiles) {
        const buf = await file.arrayBuffer();
        fileData.push({ name: file.name, bytes: new Uint8Array(buf) });
      }

      fileData = await applyToolProcessing(fileData);

      // Image tools: processing now handled via miniPaint action bar
      {
        for (const f of fileData) {
          downloadFile(f.bytes, f.name);
        }

        const totalSize = fileData.reduce((s, f) => s + f.bytes.length, 0);
        const compressionHtml = getVideoCompressionHtml(inputFiles, fileData);
        window.showPopup(
          `<h2>Processed ${fileData.length} file${fileData.length !== 1 ? "s" : ""}!</h2>` +
          `<p>Total size: ${formatFileSize(totalSize)}</p>` +
          compressionHtml +
          `<button onclick="window.hidePopup()">OK</button>`
        );
      }
    } catch (e) {
      window.hidePopup();
      alert("Error during processing:\n" + e);
      console.error(e);
    }
    return;
  }

  const outputButton = document.querySelector("#to-list .selected");
  if (!outputButton) return alert("Specify output file format.");
  const outputOption = allOptions[Number(outputButton.getAttribute("format-index"))];
  const outputFormat = outputOption.format;
  const _convertStartTime = Date.now();

  try {

    if (isSameCategoryBatch && allUploadedFiles.length > 1) {
      // ── Same-category batch: group by exact MIME, convert all, zip if multiple outputs ──
      const groups = new Map<string, { files: File[], inputOption: { format: FileFormat; handler: FormatHandler } }>();
      for (const file of inputFiles) {
        const opt = findInputOption(file);
        if (!opt) {
          alert(`Could not determine format for "${file.name}".`);
          return;
        }
        const key = `${opt.format.mime}|${opt.format.format}`;
        if (!groups.has(key)) groups.set(key, { files: [], inputOption: opt });
        groups.get(key)!.files.push(file);
      }

      window.showPopup("<h2>Finding conversion route...</h2>");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const allOutputFiles: FileData[] = [];
      const batchFailures: string[] = [];

      // Flatten all files across groups for individual processing with progress
      const allFileEntries: { file: File; inputOption: { format: FileFormat; handler: FormatHandler } }[] = [];
      for (const group of groups.values()) {
        for (const f of group.files) {
          allFileEntries.push({ file: f, inputOption: group.inputOption });
        }
      }
      const totalFileCount = allFileEntries.length;

      for (let i = 0; i < allFileEntries.length; i++) {
        const { file, inputOption } = allFileEntries[i];

        // Update progress indicator
        window.showPopup(
          `<h2>Converting file ${i + 1} of ${totalFileCount}...</h2>` +
          `<p>${file.name}</p>`
        );
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // If input and output are the same format, pass through
        if (inputOption.format.mime === outputFormat.mime && inputOption.format.format === outputFormat.format) {
          const buf = await file.arrayBuffer();
          allOutputFiles.push({ name: file.name, bytes: new Uint8Array(buf) });
          continue;
        }

        const buf = await file.arrayBuffer();
        const singleFile: FileData = { name: file.name, bytes: new Uint8Array(buf) };

        try {
          const output = await window.tryConvertByTraversing([singleFile], inputOption, outputOption);
          if (output) {
            allOutputFiles.push(...output.files);
          } else {
            batchFailures.push(singleFile.name);
          }
        } catch (e) {
          console.error(`Failed to convert ${singleFile.name}:`, e);
          batchFailures.push(singleFile.name);
        }
      }

      if (allOutputFiles.length === 0) {
        if (batchFailures.length > 0) {
          window.showPopup(
            `<h2>Conversion failed</h2>` +
            `<p>All ${batchFailures.length} file${batchFailures.length !== 1 ? "s" : ""} failed to convert.</p>` +
            `<p style="opacity:0.7;font-size:0.9em">${batchFailures.join(", ")}</p>` +
            `<button onclick="window.hidePopup()">OK</button>`
          );
        } else {
          window.hidePopup();
        }
        return;
      }

      const processedOutputFiles = await applyToolProcessing(allOutputFiles);

      if (processedOutputFiles.length === 1) {
        downloadFile(processedOutputFiles[0].bytes, processedOutputFiles[0].name);
      } else if (archiveMultiOutput) {
        const zip = new JSZip();
        for (let i = 0; i < processedOutputFiles.length; i++) {
          zip.file(processedOutputFiles[i].name, processedOutputFiles[i].bytes);
          if (i % 10 === 9) {
            await new Promise(r => requestAnimationFrame(r));
          }
        }
        const zipBytes = await zip.generateAsync({ type: "uint8array" });
        downloadFile(zipBytes, "converted.zip");
      } else {
        for (const f of processedOutputFiles) downloadFile(f.bytes, f.name);
      }

      const totalSize = processedOutputFiles.reduce((s, f) => s + f.bytes.length, 0);
      const compressionHtml = getVideoCompressionHtml(inputFiles, processedOutputFiles);
      lastConvertedFiles = processedOutputFiles;
      const redirectHtml1 = getRedirectSuggestionHtml(processedOutputFiles);
      const failureHtml1 = batchFailures.length > 0
        ? `<p style="color:#e74c3c"><b>${batchFailures.length} file${batchFailures.length !== 1 ? "s" : ""} failed:</b> ${batchFailures.join(", ")}</p>`
        : ``;
      window.showPopup(
        `<h2>Converted ${processedOutputFiles.length} file${processedOutputFiles.length !== 1 ? "s" : ""} to ${outputFormat.format}!</h2>` +
        `<p>Total size: ${formatFileSize(totalSize)} — took ${formatElapsed(Date.now() - _convertStartTime)}</p>` +
        compressionHtml +
        failureHtml1 +
        (processedOutputFiles.length > 1 && archiveMultiOutput ? `<p>Results delivered as a ZIP archive.</p>` : ``) +
        `<div class="popup-actions">` +
        getClipboardCopyHtml(processedOutputFiles, outputFormat.mime) +
        `<button onclick="window.hidePopup()">OK</button>` +
        `</div>` +
        redirectHtml1
      );
      attachRedirectHandlers();

    } else if (conversionQueue.length > 1) {
      // ── Mixed-category queue: convert current group, advance queue ──
      const inputButton = document.querySelector("#from-list .selected");
      if (!inputButton) return alert("Specify input file format.");
      const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];
      const inputFormat = inputOption.format;

      const inputFileData: FileData[] = [];
      for (const inputFile of inputFiles) {
        const inputBuffer = await inputFile.arrayBuffer();
        const inputBytes = new Uint8Array(inputBuffer);
        if (inputFormat.mime === outputFormat.mime && inputFormat.format === outputFormat.format) {
          downloadFile(inputBytes, inputFile.name);
          continue;
        }
        inputFileData.push({ name: inputFile.name, bytes: inputBytes });
      }

      const queueSuccessFiles: FileData[] = [];
      const queueFailures: string[] = [];

      if (inputFileData.length > 0) {
        window.showPopup("<h2>Finding conversion route...</h2>");
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // Process each file individually so one failure doesn't kill the batch
        for (let i = 0; i < inputFileData.length; i++) {
          const singleFile = inputFileData[i];

          // Update progress indicator
          window.showPopup(
            `<h2>Converting file ${i + 1} of ${inputFileData.length}...</h2>` +
            `<p>${singleFile.name}</p>`
          );
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

          try {
            const output = await window.tryConvertByTraversing([singleFile], inputOption, outputOption);
            if (output) {
              queueSuccessFiles.push(...output.files);
            } else {
              queueFailures.push(singleFile.name);
            }
          } catch (e) {
            console.error(`Failed to convert ${singleFile.name}:`, e);
            queueFailures.push(singleFile.name);
          }
        }

        if (queueSuccessFiles.length > 0) {
          const processedQueueFiles = await applyToolProcessing(queueSuccessFiles);
          for (const file of processedQueueFiles) {
            downloadFile(file.bytes, file.name);
          }
        } else if (queueFailures.length > 0) {
          // All files in this queue group failed
          window.showPopup(
            `<h2>Conversion failed</h2>` +
            `<p>All ${queueFailures.length} file${queueFailures.length !== 1 ? "s" : ""} in this group failed to convert.</p>` +
            `<p style="opacity:0.7;font-size:0.9em">${queueFailures.join(", ")}</p>` +
            `<button onclick="window.hidePopup()">OK</button>`
          );
          return;
        }
      }

      // Advance to next queue group
      currentQueueIndex++;
      if (currentQueueIndex < conversionQueue.length) {
        const queueFailureHtml = queueFailures.length > 0
          ? `<p style="color:#e74c3c"><b>${queueFailures.length} file${queueFailures.length !== 1 ? "s" : ""} failed:</b> ${queueFailures.join(", ")}</p>`
          : ``;
        window.showPopup(
          `<h2>Group ${currentQueueIndex} of ${conversionQueue.length} done!</h2>` +
          `<p>Advancing to next group...</p>` +
          queueFailureHtml +
          `<button onclick="window.hidePopup()">OK</button>`
        );
        // Present next group after a short delay
        setTimeout(() => {
          window.hidePopup();
          presentQueueGroup(currentQueueIndex);
        }, 1000);
      } else {
        // All groups done
        conversionQueue = [];
        currentQueueIndex = 0;
        const queueFailureHtml = queueFailures.length > 0
          ? `<p style="color:#e74c3c"><b>${queueFailures.length} file${queueFailures.length !== 1 ? "s" : ""} failed:</b> ${queueFailures.join(", ")}</p>`
          : ``;
        window.showPopup(
          `<h2>All conversions complete!</h2>` +
          `<p>All ${allUploadedFiles.length} files have been converted — took ${formatElapsed(Date.now() - _convertStartTime)}</p>` +
          queueFailureHtml +
          `<button onclick="window.hidePopup()">OK</button>`
        );
      }

    } else {
      // ── Single file or single-type group: original behavior ──
      const inputButton = document.querySelector("#from-list .selected");
      if (!inputButton) return alert("Specify input file format.");
      const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];
      const inputFormat = inputOption.format;

      const inputFileData: FileData[] = [];
      for (const inputFile of inputFiles) {
        const inputBuffer = await inputFile.arrayBuffer();
        const inputBytes = new Uint8Array(inputBuffer);
        if (inputFormat.mime === outputFormat.mime && inputFormat.format === outputFormat.format) {
          downloadFile(inputBytes, inputFile.name);
          continue;
        }
        inputFileData.push({ name: inputFile.name, bytes: inputBytes });
      }

      // Process each file individually so one failure doesn't kill the batch
      const singleResults: FileData[] = [];
      const singleFailures: string[] = [];

      if (inputFileData.length === 0) {
        // All files were same-format pass-through, already downloaded above
        return;
      }

      window.showPopup("<h2>Finding conversion route...</h2>");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      for (let i = 0; i < inputFileData.length; i++) {
        const singleFile = inputFileData[i];

        // Update progress indicator for multi-file cases
        if (inputFileData.length > 1) {
          window.showPopup(
            `<h2>Converting file ${i + 1} of ${inputFileData.length}...</h2>` +
            `<p>${singleFile.name}</p>`
          );
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }

        try {
          const output = await window.tryConvertByTraversing([singleFile], inputOption, outputOption);
          if (output) {
            singleResults.push(...output.files);
          } else {
            singleFailures.push(singleFile.name);
          }
        } catch (e) {
          console.error(`Failed to convert ${singleFile.name}:`, e);
          singleFailures.push(singleFile.name);
        }
      }

      if (singleResults.length === 0) {
        if (singleFailures.length > 0) {
          if (singleFailures.length === 1) {
            showConversionFailedPopup(inputOption.format.format, outputOption.format.format);
          } else {
            window.showPopup(
              `<h2>Conversion failed</h2>` +
              `<p>All ${singleFailures.length} files failed to convert.</p>` +
              `<p style="opacity:0.7;font-size:0.9em">${singleFailures.join(", ")}</p>` +
              `<button onclick="window.hidePopup()">OK</button>`
            );
          }
        } else {
          showConversionFailedPopup(inputOption.format.format, outputOption.format.format);
        }
        return;
      }

      const processedSingleFiles = await applyToolProcessing(singleResults);
      for (const file of processedSingleFiles) {
        downloadFile(file.bytes, file.name);
      }

      const singleTotalSize = processedSingleFiles.reduce((s, f) => s + f.bytes.length, 0);
      const compressionHtml = getVideoCompressionHtml(inputFiles, processedSingleFiles);
      lastConvertedFiles = processedSingleFiles;
      const redirectHtml3 = getRedirectSuggestionHtml(processedSingleFiles);
      const singleFailureHtml = singleFailures.length > 0
        ? `<p style="color:#e74c3c"><b>${singleFailures.length} file${singleFailures.length !== 1 ? "s" : ""} failed:</b> ${singleFailures.join(", ")}</p>`
        : ``;
      window.showPopup(
        `<h2>Converted ${processedSingleFiles.length} file${processedSingleFiles.length !== 1 ? "s" : ""} to ${outputOption.format.format}!</h2>` +
        `<p>Size: ${formatFileSize(singleTotalSize)} — took ${formatElapsed(Date.now() - _convertStartTime)}</p>` +
        compressionHtml +
        singleFailureHtml +
        `<div class="popup-actions">` +
        getClipboardCopyHtml(processedSingleFiles, outputOption.format.mime) +
        `<button onclick="window.hidePopup()">OK</button>` +
        `</div>` +
        redirectHtml3
      );
      attachRedirectHandlers();
    }

  } catch (e) {

    console.error(e);
    window.showPopup(
      `<h2>Conversion failed</h2>` +
      `<p>An unexpected error occurred during conversion.</p>` +
      `<p style="opacity:0.7;font-size:0.9em">${e instanceof Error ? e.message : String(e)}</p>` +
      `<p style="opacity:0.7;font-size:0.9em">Check the activity log in the top-right corner for details.</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );

  }

};
