// ── Editor module public API ───────────────────────────────────────────────────

export type {
  Project,
  Track,
  TrackKind,
  Clip,
  Effect,
  EffectKind,
  EffectParams,
  ColorCorrectParams,
  LutParams,
  BlurParams,
  SharpenParams,
  VignetteParams,
  TransformParams,
} from './types.ts';

export {
  createProject,
  createTrack,
  createClip,
  createColorCorrectEffect,
  createBlurEffect,
  createSharpenEffect,
  createVignetteEffect,
  createTransformEffect,
  clipActiveAt,
  clipSourceTime,
  clipTimelineDuration,
  recomputeDuration,
  cloneProject,
} from './types.ts';

export { EffectChain } from './EffectChain.ts';

export type { FrameCallback } from './ClipDecoder.ts';
export { ClipDecoder, ClipDecoderPool } from './ClipDecoder.ts';

export type { TrackAudioConfig, EQBand } from './AudioMixer.ts';
export { AudioMixer } from './AudioMixer.ts';

export type { EngineState, PlaybackEngineOptions } from './PlaybackEngine.ts';
export { PlaybackEngine, computeTimelineDuration } from './PlaybackEngine.ts';

export type { TimelineState, TimelineCallbacks } from './TimelineController.ts';
export { TimelineController, TRACK_HEADER_WIDTH, RULER_HEIGHT, TRACK_HEIGHT } from './TimelineController.ts';

export { TimelineRenderer } from './TimelineRenderer.ts';

export type { ParsedLut } from './LutParser.ts';
export { parseCubeLut, loadCubeLutFile } from './LutParser.ts';

export type { PanelChangeCallback } from './ColorGradingPanel.ts';
export { ColorGradingPanel } from './ColorGradingPanel.ts';

export type { ExportOptions, ExportResult } from './Exporter.ts';
export { Exporter } from './Exporter.ts';

export { WaveformCache }   from './WaveformCache.ts';
export { ThumbnailCache } from './ThumbnailCache.ts';

export type { AudioPanelChangeCallback } from './AudioTrackPanel.ts';
export { AudioTrackPanel } from './AudioTrackPanel.ts';
