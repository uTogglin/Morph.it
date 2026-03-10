# Codebase Structure
**Analysis Date:** 2026-03-10

## Directory Layout

```
Morph.it/
├── .github/                    # GitHub Actions workflows and CI config
├── .planning/                  # Project planning and documentation
│   └── codebase/               # Architecture and structure docs
├── .vscode/                    # VS Code workspace settings
├── docker/                     # Docker deployment files
│   ├── docker-compose.yml
│   └── docker-compose.override.yml
├── docs/                       # Project documentation assets
├── public/                     # Static assets served as-is by Vite
│   └── minipaint/              # Embedded MiniPaint image editor (submodule)
├── src/                        # Main application source
│   ├── editor/                 # Video editor subsystem
│   ├── handlers/               # Format conversion handler plugins
│   └── utils/                  # Shared utility modules
├── test/                       # Test files
├── index.html                  # SPA entry point
├── style.css                   # Global stylesheet
├── package.json                # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── vite.config.js              # Vite bundler configuration
├── buildCache.js               # Build-time format cache generator
├── discoverDeadRoutes.js       # Puppeteer dead route discovery script
├── dead-routes.json            # Known failing conversion routes
├── favicon.ico                 # Site favicon
├── CNAME                       # Custom domain for GitHub Pages
├── LICENSE                     # Project license
└── README.md                   # Project readme
```

## Directory Purposes

### `src/` - Application Source
The main application code. Everything here is TypeScript (ES modules) bundled by Vite.

### `src/handlers/` - Conversion Handler Plugins
Contains 67+ handler modules, each implementing the `FormatHandler` interface. This is the largest directory by file count. Handlers are organized as:

- **Top-level `.ts` files** - One file per handler (e.g., `FFmpeg.ts`, `ImageMagick.ts`, `font.ts`)
- **Subdirectories** - Handlers with extra assets or vendored code:
  - `bsor/` - Beat Saber replay handler (renderer + replay parser)
  - `lzh/` - LZH archive encoder/decoder
  - `batToExe/` - BAT-to-EXE conversion resources
  - `envelope/` - Envelope format handler
  - `espeakng.js/` - eSpeak-NG TTS engine (vendored JS/WASM)
  - `libopenmpt/` - OpenMPT tracker module player (vendored JS/WASM)
  - `midi/` - MIDI codec and synthesizer (with soundfont `.sf2`)
  - `pandoc/` - Pandoc document converter (vendored WASM)
  - `qoi-fu/`, `qoa-fu/` - QOI image / QOA audio codecs (git submodules)
  - `sppd/` - SPPD format handler (git submodule)
  - `image-to-txt/` - Image-to-text converter (git submodule)
  - `terraria-wld-parser/` - Terraria world file parser (git submodule)

**Registry**: `src/handlers/index.ts` imports and instantiates all handlers into a single `FormatHandler[]` array.

### `src/editor/` - Video Editor Subsystem
Self-contained video editing module with its own barrel export (`index.ts`). Key files:
- `types.ts` - Core data types (Project, Track, Clip, Effect)
- `PlaybackEngine.ts` - Frame-accurate playback with audio sync
- `TimelineController.ts` - Timeline interaction state
- `TimelineRenderer.ts` - Canvas-based timeline drawing
- `ClipDecoder.ts` - WebCodecs frame decoding with worker pool
- `EffectChain.ts` - Visual effects pipeline
- `AudioMixer.ts` - Multi-track audio with per-track EQ
- `Exporter.ts` - Video export pipeline
- `ColorGradingPanel.ts` - Color grading UI
- `AudioTrackPanel.ts` - Audio controls UI
- `LutParser.ts` - .cube LUT file parser
- `ThumbnailCache.ts` - Video thumbnail cache
- `WaveformCache.ts` - Audio waveform cache

### `src/utils/` - Shared Utilities
Small, focused helper modules:
- `build-wav.ts` - Construct WAV files from raw PCM data
- `canvas-to-bytes.ts` - Convert canvas elements to byte arrays
- `detect-format.ts` - File format detection (magic bytes, extension, MIME)
- `file-utils.ts` - General file manipulation helpers
- `tts-player.ts` - Text-to-speech audio playback
- `worker-gpu-utils.ts` - WebGPU availability detection for workers

### `public/` - Static Assets
Files served directly by Vite without processing. Contains the MiniPaint image editor as a git submodule at `public/minipaint/`.

### `docker/` - Docker Configuration
Docker Compose files for containerized deployment.

### `test/` - Tests
Test files including `MockedHandler.ts` for handler testing.

## Key File Locations

| Purpose | File |
|---------|------|
| **App entry (web)** | `index.html` -> `src/main.ts` |
| **App entry (desktop)** | `src/electron.cjs` |
| **Handler interface** | `src/FormatHandler.ts` |
| **Format definitions** | `src/CommonFormats.ts` |
| **Handler registry** | `src/handlers/index.ts` |
| **Pathfinding engine** | `src/TraversionGraph.ts` |
| **Priority queue** | `src/PriorityQueue.ts` |
| **Format detection** | `src/utils/detect-format.ts` |
| **MIME normalization** | `src/normalizeMimeType.ts` |
| **Editor public API** | `src/editor/index.ts` |
| **Editor data types** | `src/editor/types.ts` |
| **Playback engine** | `src/editor/PlaybackEngine.ts` |
| **File compression** | `src/compress.ts` |
| **Model caching** | `src/cached-fetch.ts` |
| **CDN fetching** | `src/cdn.ts` |
| **Speech tool** | `src/speech-tool.ts` |
| **OCR tool** | `src/ocr-tool.ts` |
| **PDF editor** | `src/pdf-editor-tool.ts` |
| **Summarization** | `src/summarize-tool.ts` |
| **Subtitle generation** | `src/subtitle-generator.ts` |
| **Video compression** | `src/webcodecs-compress.ts` |
| **Build config** | `vite.config.js` |
| **TS config** | `tsconfig.json` |
| **Dead routes data** | `dead-routes.json` |
| **Global types** | `src/global.d.ts` |
| **Type declarations** | `src/heic-convert.d.ts`, `src/onnx.d.ts` |

## Naming Conventions

### Files
- **Handlers**: lowercase or camelCase matching the tool/format name (e.g., `FFmpeg.ts`, `canvasToBlob.ts`, `midi.ts`, `threejs.ts`)
- **Workers**: `*-worker.ts` suffix (e.g., `kokoro-worker.ts`, `ocr-worker.ts`)
- **Tools**: `*-tool.ts` suffix (e.g., `speech-tool.ts`, `ocr-tool.ts`, `pdf-editor-tool.ts`)
- **Utilities**: kebab-case (e.g., `detect-format.ts`, `build-wav.ts`, `cached-fetch.ts`)
- **Editor modules**: PascalCase matching the class name (e.g., `PlaybackEngine.ts`, `EffectChain.ts`)
- **Type declarations**: `*.d.ts` suffix (e.g., `global.d.ts`, `heic-convert.d.ts`)

### Exports
- **Handlers**: default export of a class (instantiated in `handlers/index.ts`)
- **Editor modules**: named exports of classes and types (re-exported via `editor/index.ts`)
- **Tools**: named export of an `init*` function (e.g., `initSpeechTool`, `initOcrTool`)
- **Utilities**: named exports of functions
- **Format definitions**: default export of the formats object (`CommonFormats`)

### Classes & Interfaces
- `FormatHandler` - Interface for all handlers
- `FormatDefinition` - Class for format metadata
- `FileFormat` - Interface extending `IFormatDefinition` with conversion flags
- `FileData` - Interface for file name + bytes
- `ConvertPathNode` - Class linking a handler to a format in a conversion path
- `TraversionGraph` - Class for the pathfinding graph

## Where to Add New Code

### Adding a New File Format Handler
1. Create `src/handlers/yourHandler.ts`
2. Implement the `FormatHandler` interface
3. Define supported formats using `CommonFormats` definitions or create new `FormatDefinition` instances
4. Import and register in `src/handlers/index.ts`:
   ```typescript
   import yourHandler from "./yourHandler.ts";
   // ...
   try { handlers.push(new yourHandler()) } catch (e) { console.warn("Failed to init handler:", e); };
   ```

### Adding a New Common Format Definition
- Add to `src/CommonFormats.ts` using the `FormatDefinition` constructor
- Assign a category from the `Category` enum (image, video, audio, text, document, data, code, archive, game, etc.)

### Adding a New Processing Tool
1. Create `src/your-tool.ts` with an `initYourTool()` function
2. If CPU-intensive, create `src/your-worker.ts` as a Web Worker
3. Import and call the init function from `src/main.ts`

### Adding a New Editor Feature
- Data types: extend `src/editor/types.ts`
- New effect: add `EffectKind` variant, implement in `src/editor/EffectChain.ts`
- New panel/UI: create `src/editor/YourPanel.ts`, export from `src/editor/index.ts`
- Wire into the editor page via `src/editor-page.ts`

### Adding a New Utility
- Create `src/utils/your-util.ts` with named exports
- Import where needed

### Adding WASM Dependencies
1. Install the npm package
2. Add static copy target in `vite.config.js` under `viteStaticCopy.targets`
3. Add to `optimizeDeps.exclude` in `vite.config.js` if it should not be pre-bundled
4. Reference the copied path at runtime

### Adding a New Worker
- Create `src/your-worker.ts`
- Use `worker: { format: "es" }` (already configured in `vite.config.js`)
- Instantiate with `new Worker(new URL("./your-worker.ts", import.meta.url), { type: "module" })`

## Special Directories

### Git Submodules (defined in `.gitmodules`)
Several handlers use git submodules for vendored dependencies:
- `src/handlers/qoi-fu/` - QOI image codec
- `src/handlers/qoa-fu/` - QOA audio codec
- `src/handlers/sppd/` - SPPD format handler
- `src/handlers/image-to-txt/` - Image-to-text converter
- `src/handlers/terraria-wld-parser/` - Terraria world parser
- `public/minipaint/` - MiniPaint image editor

These are excluded from TypeScript compilation in `tsconfig.json` because they have their own build setups or incompatible TS settings.

### `public/minipaint/`
A full embedded image editor served as static files. This is a separate application (git submodule) accessed via the browser.

### `docker/`
Contains Docker Compose configuration for containerized deployment. Uses build args (e.g., `VITE_COMMIT_SHA`) for version tracking.
