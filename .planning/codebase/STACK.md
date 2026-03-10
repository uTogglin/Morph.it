# Technology Stack

**Analysis Date:** 2026-03-10

## Languages

- **TypeScript** (~5.9.3) - Primary language for frontend application logic
- **JavaScript** - Configuration files and Electron main process (CommonJS)
- **WASM (WebAssembly)** - Multiple WASM modules for performance-critical operations

## Runtime

- **Node.js** - Development environment and build tooling (implied via npm/bun scripts)
- **Bun** - Fast JavaScript runtime used for build scripts and package management
- **Electron 40.6.0** - Desktop application framework for cross-platform desktop app (Windows, macOS, Linux)
- **Web Browser** - Primary runtime for browser-based converter (ES2022 target)

## Frameworks

- **Vite 7.2.4** - Frontend build tool and dev server
- **Electron** - Desktop application framework with custom protocol handler for local file serving

## Key Dependencies

### Media & Conversion Libraries

- **FFmpeg** (@ffmpeg/ffmpeg@0.12.15, @ffmpeg/core@0.12.10, @ffmpeg/util@0.12.2) - Comprehensive audio/video codec support
- **ImageMagick** (@imagemagick/magick-wasm@0.0.37) - Image processing (WASM)
- **7-Zip** (7z-wasm@1.2.0) - Archive compression/decompression
- **Pandoc** (custom WASM) - Document format conversion
- **LibOpenMPT** (custom WASM) - Tracker music format support

### Audio & Speech

- **Reflo** (@flo-audio/reflo@0.1.2) - Audio processing (WASM)
- **JS-Synthesizer** (js-synthesizer@1.11.0) - MIDI synthesis with FluidSynth
- **Verovio** (verovio@6.0.1) - Music notation rendering
- **VexFlow** (vexflow@5.0.0) - Music notation engraving
- **Meyda** (meyda@5.6.3) - Audio feature extraction
- **Kokoro-JS** (kokoro-js@1.2.1) - Text-to-speech engine
- **ESpeakNG.js** (custom WASM) - Additional TTS support

### Document & Data Processing

- **PDF** (pdfjs-dist@4.10.38, pdf-lib@1.17.1) - PDF reading and writing
- **YAML** (yaml@2.8.2) - YAML parsing
- **Papa Parse** (papaparse@5.5.3) - CSV parsing
- **BSON** (bson@7.2.0) - MongoDB data format
- **NBTify** (nbtify@2.2.0) - Minecraft NBT data handling

### Image Processing & Rendering

- **Three.js** (three@0.182.0, three-bvh-csg@0.0.17, three-mesh-bvh@0.9.8) - 3D graphics library
- **Fabric.js** (fabric@6.6.1) - Canvas-based drawing/manipulation
- **Tesseract.js** (tesseract.js@5.1.1) - OCR (Optical Character Recognition)
- **ImageTracer** (imagetracer@0.2.2) - SVG tracing from raster images
- **HEIC Convert** (heic-convert@2.1.0) - HEIC/HEIF image conversion

### Machine Learning & AI

- **HuggingFace Transformers** (@huggingface/transformers@3.8.1) - Pre-trained ML models (Whisper, BART, etc.)
- **ONNX Runtime Web** (onnxruntime-web@1.21.0) - Neural network inference
- **PDF to Image** (pdftoimg-js@0.2.5) - PDF rasterization

### Format-Specific Libraries

- **OpenType.js** (opentype.js@1.3.4) - Font file manipulation
- **WOFF2 Encoder** (woff2-encoder@2.0.0) - Web font conversion
- **VexML** (@stringsync/vexml@0.1.8) - MusicXML handling
- **Toon Format** (@toon-format/toon@2.1.0) - Toon video format
- **ts-flp** (ts-flp@1.0.3) - FL Studio project files
- **PE Library** (pe-library@2.0.1) - Windows executable parsing

### Utilities

- **JSZip** (jszip@3.10.1) - ZIP file handling in JavaScript
- **Pako** (pako@2.1.0) - Deflate/zlib compression
- **nanotar** (nanotar@0.3.0) - TAR archive handling
- **WASI Shim** (@bjorn3/browser_wasi_shim@0.4.2) - WebAssembly System Interface
- **Mediabunny** (mediabunny@1.34.5) - Media utilities
- **mime** (mime@4.1.0) - MIME type detection
- **SVG PathData** (svg-pathdata@8.0.0) - SVG path manipulation
- **WaveFile** (wavefile@11.0.0) - WAV file handling
- **SQLite3** (@sqlite.org/sqlite-wasm@3.51.2-build6) - WASM version of SQLite

### Development Dependencies

- **TypeScript** (typescript~5.9.3) - Type checking
- **Electron Builder** (electron-builder@26.8.1) - Electron app packaging and distribution
- **Puppeteer** (puppeteer@24.36.0) - Browser automation (development/testing)
- **Vite Plugins** (vite-tsconfig-paths@6.0.5, vite-plugin-static-copy@3.1.6) - Build tooling
- **Type Definitions** (@types/jszip, @types/opentype.js, @types/meyda, @types/pako, @types/papaparse, @types/three, @types/bun)

## Configuration

### TypeScript Configuration (`tsconfig.json`)

- **Target:** ES2022
- **Module System:** ESNext with bundler resolution
- **Strict Mode:** Enabled
- **Path Aliases:** Custom paths for qoi-fu and qoa-fu handlers
- **Excluded:** Non-TS handler directories (qoi-fu, qoa-fu, sppd, espeakng.js, image-to-txt, terraria-wld-parser)

### Vite Configuration (`vite.config.js`)

- **Static Asset Copying:** WASM modules, soundfonts, and worker scripts copied to `dist/wasm/` and `dist/js/`
- **Worker Format:** ES modules
- **Excluded Deps Optimization:** FFmpeg, SQLite, 7z-wasm, ONNX Runtime Web (loaded externally)
- **Base Path:** Root `/`

### Build System

- **Dev:** `vite` (hot reload)
- **Build:** `tsc && vite build`
- **Desktop Build:** `IS_DESKTOP=true vite build && bun run cache:build`
- **Desktop Distribution:** electron-builder targets (Windows NSIS, macOS DMG, Linux AppImage)
- **Cache Build:** Custom script for generating `cache.json` (minified and dev variants)

### Docker Configuration

- **Base Image:** `oven/bun:1` (build), `nginx:stable-alpine` (runtime)
- **Build Args:** `VITE_COMMIT_SHA` for versioning
- **Runtime:** Nginx serving static files at `/convert` path
- **Port:** 80 (mapped to 8080 in docker-compose)

## Platform Requirements

- **Desktop:** Windows 10+, macOS 10.13+, Linux (Ubuntu 20.04+)
- **Browser:** Modern browsers with:
  - SharedArrayBuffer support (requires COOP/COEP headers)
  - WebAssembly support
  - Web Audio API
  - Canvas API
  - Clipboard API (optional, for screenshot export)
  - Service Workers / Cache API (optional, for model caching)
  - File System Access API (optional, for file operations)

- **Development:** Node.js 18+ (or Bun 1.0+)

## Deployment Formats

- Browser-based (SPA hosted on Nginx)
- Desktop application (Electron for Windows, macOS, Linux)
- Docker container (containerized web version)
