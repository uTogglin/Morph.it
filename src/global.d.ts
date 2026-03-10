import type { FileFormat, FileData, ConvertPathNode, FormatHandler } from "./FormatHandler.js";
import type { TraversionGraph } from "./TraversionGraph.js";

declare global {
  interface Window {
    supportedFormatCache: Map<string, FileFormat[]>;
    traversionGraph: TraversionGraph;
    printSupportedFormatCache: () => string;
    showPopup: (html: string) => void;
    hidePopup: () => void;
    tryConvertByTraversing: (files: FileData[], from: ConvertPathNode, to: ConvertPathNode) => Promise<{
      files: FileData[];
      path: ConvertPathNode[];
    } | null>;
    _cancelActiveConversion: () => void;
    _skipCurrentFile: () => void;
    _activeConversionHandler: FormatHandler | null;
  }
}

export { };

// ── requestVideoFrameCallback (Chrome 83+, Safari 15.4+) ─────────────────────
// Not yet in the official TS DOM lib. Declared here so ClipDecoder.ts compiles.

interface VideoFrameCallbackMetadata {
  /** The presentation time of the frame, in seconds. */
  mediaTime: number;
  /** Wall-clock time the frame was presented (DOMHighResTimeStamp). */
  presentationTime: DOMHighResTimeStamp;
  /** Expected presentation duration of this frame, in seconds. */
  expectedDisplayTime: DOMHighResTimeStamp;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Media presentation time in seconds. Same as mediaTime in most cases. */
  presentedFrames: number;
  processingDuration?: number;
  captureTime?: DOMHighResTimeStamp;
  receiveTime?: DOMHighResTimeStamp;
  rtpTimestamp?: number;
}

type VideoFrameRequestCallback = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void;

interface HTMLVideoElement {
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}
