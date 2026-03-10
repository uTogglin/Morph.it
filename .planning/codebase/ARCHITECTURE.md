# Architecture
**Analysis Date:** 2026-03-10

## Pattern Overview

Morph.it is a universal browser-based file converter with three deployment modes:
- **Web Application** - Client-side SPA served via Vite
- **Desktop Application** - Electron-based for Windows, macOS, Linux
- **Docker Services** - Server-side containerized deployment

The architecture follows a **plugin-based handler pattern** with a **graph-based pathfinding system** for intelligent conversion routing. Each file format is a node in a graph, handlers are edges, and the system uses A* pathfinding to find optimal conversion paths between any two formats -- even when no single handler supports the direct conversion.

## Layers

### 1. Entry Points & Presentation Layer
- `src/main.ts` - Main SPA application (~191KB), handles UI, file selection, conversion orchestration, settings, and download delivery
- `src/editor-page.ts` - Editor page initialization and wiring (~31KB)
- `src/electron.cjs` - Electron desktop runtime, custom `app://` protocol handler, window management
- `index.html` - Single HTML file entry point for both web and desktop
- `style.css` - Global stylesheet

### 2. Format Detection & Definition Layer
- `src/FormatHandler.ts` - Core interfaces: `FormatHandler`, `FileFormat`, `FileData`, `FormatDefinition`, `ConvertPathNode`
- `src/CommonFormats.ts` - ~200+ predefined format definitions organized by category, using the `FormatDefinition` builder pattern
- `src/normalizeMimeType.ts` - MIME type normalization utilities
- `src/utils/detect-format.ts` - File format detection via prescan (magic bytes), extension matching, and cached MIME lookups

### 3. Conversion Pathfinding Layer
- `src/TraversionGraph.ts` - A* pathfinding engine that builds a graph from all registered handlers and their supported formats
  - Nodes represent file formats; edges represent handler capabilities
  - Cost heuristics: base depth cost, category-change penalties, lossy conversion multipliers, handler/format priority
  - Adaptive costs penalize nonsensical multi-category paths (e.g. text -> image -> audio)
  - Maintains dead routes to avoid re-attempting failed conversions
  - Yields to the browser event loop every 4000 iterations; hard cap at 100,000 iterations
- `src/PriorityQueue.ts` - Min-heap priority queue used by the pathfinding algorithm

### 4. Handler/Converter Plugins Layer
- `src/handlers/` - 67+ specialized converter handlers
- Each handler implements the `FormatHandler` interface:
  - `ready` / `init()` - Lazy initialization (load WASM, fetch resources, etc.)
  - `doConvert(inputFiles, inputFormat, outputFormat, args?)` - Core conversion logic
  - `supportedFormats` - Declares which format pairs are supported
  - `supportAnyInput` - Optional flag for fallback handlers that accept any input type
  - `cancel()` - Optional abort support
- Major handlers: `FFmpeg.ts` (audio/video), `ImageMagick.ts` (images), `pandoc.ts` (documents), `archive.ts` / `jszip.ts` (archives), `threejs.ts` (3D models)
- Registry: `src/handlers/index.ts` instantiates all handlers in try-catch blocks and exports the array

### 5. Specialized Processing Tools Layer
- `src/speech-tool.ts` - Text-to-speech with Kokoro TTS engine
- `src/ocr-tool.ts` - Optical character recognition with Tesseract.js
- `src/summarize-tool.ts` - Document summarization with Hugging Face Transformers
- `src/pdf-editor-tool.ts` - PDF editing with pdf-lib and fabric.js (~127KB)
- `src/subtitle-generator.ts` - Video subtitle generation with Whisper
- `src/webcodecs-compress.ts` - WebCodecs API-based video/audio compression

### 6. Video Editor Subsystem
Located in `src/editor/`, this is a self-contained domain with its own public API via `src/editor/index.ts`:
- `types.ts` - Data models: Project, Track, Clip, Effect, EffectParams
- `PlaybackEngine.ts` - Video playback engine with frame-accurate audio sync
- `TimelineController.ts` - Timeline UI state management (scroll, zoom, selection)
- `TimelineRenderer.ts` - Canvas-based timeline rendering
- `ClipDecoder.ts` / `ClipDecoderPool` - WebCodecs frame decoding with worker pooling
- `EffectChain.ts` - Composable effect pipeline (color correction, blur, sharpen, vignette, transform, LUT)
- `AudioMixer.ts` - Multi-track audio mixing with per-track EQ bands
- `ColorGradingPanel.ts` - Color grading UI controls
- `AudioTrackPanel.ts` - Audio track controls panel
- `Exporter.ts` - Export to WebM/MP4 with configurable options
- `ThumbnailCache.ts` / `WaveformCache.ts` - Media preview caching
- `LutParser.ts` - .cube LUT file parser

### 7. Utilities & Infrastructure Layer
- `src/compress.ts` - File compression orchestration (~29KB)
- `src/cached-fetch.ts` - IndexedDB-based cache for large models/resources with persistent storage management
- `src/cdn.ts` - CDN URL resolution and fetching
- `src/utils/build-wav.ts` - WAV file construction from raw audio data
- `src/utils/canvas-to-bytes.ts` - Canvas element to byte array conversion
- `src/utils/detect-format.ts` - Format detection via magic bytes, extension, MIME
- `src/utils/file-utils.ts` - File manipulation helpers
- `src/utils/tts-player.ts` - TTS audio playback utilities
- `src/utils/worker-gpu-utils.ts` - WebGPU detection for worker threads

### 8. Web Workers
- `src/kokoro-worker.ts` - Kokoro TTS synthesis (offloaded from main thread)
- `src/ocr-worker.ts` - Tesseract OCR processing
- `src/whisper-worker.ts` - Whisper audio transcription
- `src/summarize-worker.ts` - Document summarization
- `src/handlers/flo.worker.ts` - Flo audio effect processing

## Data Flow

### File Conversion Flow
```
User selects files
       |
       v
Format Detection (detect-format.ts)
  - Magic byte prescan
  - Extension matching
  - MIME type normalization
       |
       v
Path Resolution (TraversionGraph.searchPath)
  - A* search across format graph
  - Returns ordered list of ConvertPathNode[]
  - Each node = { handler, intermediateFormat }
       |
       v
Sequential Conversion Loop (main.ts)
  - For each step in path:
    - handler.init() if not ready
    - handler.doConvert(files, fromFormat, toFormat)
    - Output becomes next step's input
       |
       v
Result Delivery
  - Single file: direct download
  - Multiple files: ZIP archive via JSZip
  - Optional compression (gzip, etc.)
```

### Video Editing Flow
```
Import media files
       |
       v
createProject() / createClip()
       |
       v
Timeline manipulation via TimelineController
       |
       v
Playback via PlaybackEngine
  - ClipDecoder supplies frames
  - EffectChain applies visual effects
  - AudioMixer handles multi-track audio
       |
       v
Export via Exporter
  - Renders frames sequentially
  - Mixes audio tracks
  - Outputs WebM/MP4
```

### Model/Resource Loading
```
Tool first use triggers lazy init
       |
       v
cachedFetch() checks IndexedDB cache
       |
  [cache hit] --> return cached data
       |
  [cache miss] --> fetch from CDN
       |
       v
requestPersistentStorage() if needed
       |
       v
Store in IndexedDB for future use
```

## Key Abstractions

### FormatHandler Interface
The core plugin contract. Every converter implements this interface to participate in the conversion graph.
```typescript
interface FormatHandler {
  name: string;
  supportedFormats?: FileFormat[];
  supportAnyInput?: boolean;
  ready: boolean;
  init(): Promise<void>;
  cancel?(): void;
  doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    args?: string[]
  ): Promise<FileData[]>;
}
```

### FormatDefinition Builder
Fluent API for declaring format metadata and capabilities:
```typescript
CommonFormats.PNG
  .builder("png")
  .allowFrom()
  .allowTo()
  .markLossless()
```
The `FormatDefinition` class holds static metadata (name, extension, MIME, category). The `.supported()` or `.builder()` methods produce a `FileFormat` that also carries conversion direction flags (`from`, `to`) and a handler-internal reference string.

### TraversionGraph
Builds a weighted directed graph from all handler `supportedFormats`. Pathfinding uses:
- `DEPTH_COST = 1` - Base cost per conversion step
- `DEFAULT_CATEGORY_CHANGE_COST = 0.6` - Penalty for crossing format categories
- `LOSSY_COST_MULTIPLIER = 1.4` - Penalty for lossy conversions
- Specific category-pair costs (e.g., image-to-video = 0.2, audio-to-image = 1.0)
- Adaptive costs that penalize nonsensical multi-hop category sequences

### FileData
Simple data transfer object carrying file bytes through the conversion pipeline:
```typescript
interface FileData {
  name: string;
  readonly bytes: Uint8Array;
}
```

### Editor Project Model
Hierarchical: Project -> Tracks -> Clips -> Effects. Each level has a creation function (`createProject`, `createTrack`, `createClip`) and effects are typed by `EffectKind` with corresponding typed params.

## Entry Points

| Context | File | Purpose |
|---------|------|---------|
| Web SPA | `index.html` -> `src/main.ts` | Vite bundles main.ts as the application entry |
| Desktop | `src/electron.cjs` | Electron main process, creates BrowserWindow |
| Handlers | `src/handlers/index.ts` | Handler registry, imports and instantiates all converters |
| Editor | `src/editor/index.ts` | Public API barrel file for the video editor subsystem |
| Build | `vite.config.js` | Vite bundler configuration |
| Cache | `buildCache.js` | Build-time format conversion cache generator |
| Dead Routes | `discoverDeadRoutes.js` | Puppeteer script to discover failing conversion paths |

## Error Handling

### Handler Registration
Each handler instantiation in `src/handlers/index.ts` is wrapped in an individual try-catch. A failing handler logs a warning but does not prevent other handlers from loading. The application degrades gracefully -- it simply loses conversions that handler would have provided.

### Conversion Pipeline
- The `TraversionGraph` maintains a `temporaryDeadEnds` list of path segments that failed during the current session
- Failed conversions are retried via alternative paths if the graph contains them
- `dead-routes.json` persists known-bad routes discovered by `discoverDeadRoutes.js`
- Handlers can implement `cancel()` to support user-initiated abort; the graph sets `_searchAborted` to cancel in-progress searches

### In-App Logging
`src/main.ts` intercepts `console.error` and `console.warn`, buffering entries (capped at 1000) into an in-app log panel. Errors increment a badge counter visible in the UI.

### Storage & Caching
Cache operations in `src/cached-fetch.ts` are wrapped in try-catch with fallback to non-persistent operation. Users are prompted for persistent storage when needed for large model files.

## Cross-Cutting Concerns

### Performance
- **Lazy Initialization** - Handlers and ML models load only on first use
- **Web Workers** - CPU-intensive tasks (TTS, OCR, transcription, summarization) run off the main thread
- **Worker Pools** - `ClipDecoderPool` manages multiple decode workers for video editing
- **Async Yielding** - `TraversionGraph` yields to the event loop every 4000 iterations to prevent UI freezes
- **Caching** - IndexedDB for models, in-memory caches for thumbnails, waveforms, and format detection results
- **Build-time Cache** - `buildCache.js` pre-computes conversion route metadata

### WASM Integration
The `vite.config.js` uses `vite-plugin-static-copy` to bundle WASM binaries into the dist output:
- FFmpeg core (`@ffmpeg/core`)
- ImageMagick (`magick.wasm`)
- Pandoc (`pandoc.wasm`)
- libopenmpt (tracker music)
- FluidSynth (MIDI synthesis)
- eSpeak-NG (speech synthesis)
- 7-Zip (`7zz.wasm`)
- Flo/Reflo (audio effects)

### Deployment Variants
- `IS_DESKTOP` environment variable toggles desktop-specific build behavior
- Electron uses a custom `app://` protocol with injected CORS headers (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`) to enable `SharedArrayBuffer` for WASM
- Docker deployment uses `docker/docker-compose.yml` with optional overrides

### State Management
- No framework-level state management (no React, Vue, etc.)
- UI state managed via vanilla TypeScript with direct DOM manipulation
- User preferences persisted in `localStorage` via `loadSetting()` helper
- Conversion state managed imperatively in `src/main.ts`
