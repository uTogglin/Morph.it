# External Integrations

**Analysis Date:** 2026-03-10

## APIs & External Services

### Background Removal

- **remove.bg API** (https://api.remove.bg/v1.0/removebg)
  - Purpose: Cloud-based background removal for images
  - Authentication: API key (user-provided, stored in localStorage as `bgApiKey`)
  - Reference in code: `src/main.ts` lines 2472+
  - Privacy Mode: Optional metadata stripping and filename randomization for API calls
  - Configuration: Toggle between "local" (RMBG-1.4 model) and "api" (remove.bg) modes

### Image Generation & Enhancement

- **OpenRouter API** (https://openrouter.ai/api/v1/chat/completions)
  - Purpose: AI image generation and manipulation
  - Authentication: API key (user-provided, stored as `openrouterApiKey`)
  - Reference in code: `src/main.ts` lines 3973+
  - Configuration: Settings -> Image Tools
  - Privacy Mode: Affects image transmission

### ML Model Hosting

- **HuggingFace Hub**
  - **ONNX Models:**
    - MiGAN: https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx
    - LaMa Inpainting: https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx
  - **Transformers Library Models:**
    - Whisper (speech-to-text)
    - BART (summarization)
    - Kokoro (text-to-speech)
    - Various vision/language models accessed via @huggingface/transformers
  - Cache Integration: Uses browser cache for downloaded models (up to 1.5GB per model)
  - Reference: `src/cached-fetch.ts`, `src/main.ts`

## Data Storage

### Local Storage

- **Browser localStorage** - Persistent user preferences and settings:
  - `convert-cache-models`: Caching preference ("yes"/"no")
  - `convert-bg-mode`: Background removal mode selection
  - `bgApiKey`: remove.bg API key (encrypted storage recommended but not enforced)
  - `openrouterApiKey`: OpenRouter API key
  - Custom settings and user state

### Browser Caches

- **IndexedDB** - Model caching managed by @huggingface/transformers
- **Cache API** - Two dedicated caches:
  - `convert-assets-v1`: WASM/static asset cache
  - `transformers-cache`: HuggingFace model cache

### File System

- **Local WASM fallback** (`/wasm/` directory):
  - ffmpeg-core.js/wasm
  - magick.wasm
  - 7zz.wasm
  - reflo_bg.wasm
  - libfluidsynth JS
  - js-synthesizer JS
  - pandoc.wasm
  - libopenmpt wasm/js
  - TimGM6mb.sf2 (soundfont)
  - espeakng worker files

## Authentication & Identity

- **No native authentication system** - Application is client-side only
- **API Keys:** User-provided and managed:
  - remove.bg API key (optional, for cloud background removal)
  - OpenRouter API key (optional, for AI image generation)
  - Keys stored in browser localStorage (no server-side account)
- **Privacy Mode:** User-controlled flag for sensitive API operations
  - Enables metadata stripping
  - Randomizes filenames for API submissions

## Monitoring & Observability

- **No dedicated monitoring** - Application is client-side only
- **Optional Build Metadata:**
  - `VITE_COMMIT_SHA` environment variable injected at build time (Docker builds)
  - Available for debugging/versioning

## CI/CD & Deployment

### Build Artifacts

- **Desktop:** electron-builder generates platform-specific installers:
  - Windows: NSIS installer
  - macOS: DMG bundle
  - Linux: AppImage
  - Output: `./release/` directory

### Docker Deployment

- **Docker Compose** configuration in `docker/docker-compose.yml`:
  - Image registry: GitHub Container Registry (`ghcr.io/${GITHUB_REPOSITORY}`)
  - Service name: `convert`
  - Environment variables: `CONVERT_IMAGE_TAG` (defaults to `latest`)
  - Restart policy: unless-stopped

### Build Environment

- **Package Manager:** Bun (preferred) with npm fallback
- **Lockfile:** `.npmrc` configuration committed
- **Build Commands:**
  - Web: `tsc && vite build`
  - Desktop: `IS_DESKTOP=true vite build && bun run cache:build`
  - Cache: `bun run buildCache.js dist/cache.json [--minify]`
- **Environment:** `VITE_COMMIT_SHA` passed to build

## Environment Configuration

### Build-Time Variables

- `IS_DESKTOP` - Conditional compilation for desktop vs web
- `VITE_COMMIT_SHA` - Git commit hash for versioning (Docker builds)

### Runtime Configuration

- **localStorage keys:**
  - `convert-cache-models` - Model caching preference
  - `convert-bg-mode` - Background removal mode
  - `bgApiKey` - remove.bg API credentials
  - `openrouterApiKey` - OpenRouter API credentials

### Static Asset References

- **Protocol Handler** (Electron Desktop):
  - Custom `app://` protocol for local file serving
  - Maps to `dist/` directory with path traversal protection
  - Injects COOP/COEP headers for SharedArrayBuffer support

## CDN & Asset Delivery

### Multi-CDN Fallback Strategy

Implemented in `src/cdn.ts` with fallback hierarchy:

| Asset | Primary CDN | Secondary | Fallback |
|-------|-------------|-----------|----------|
| FFmpeg Core | jsDelivr | unpkg | `/wasm/ffmpeg-core.js` |
| ImageMagick WASM | jsDelivr | unpkg | `/wasm/magick.wasm` |
| 7-Zip WASM | jsDelivr | unpkg | `/wasm/7zz.wasm` |
| Reflo Audio WASM | jsDelivr | unpkg | `/wasm/reflo_bg.wasm` |
| FluidSynth | jsDelivr | unpkg | `/wasm/libfluidsynth-*.js` |
| JS-Synthesizer | jsDelivr | unpkg | `/wasm/js-synthesizer.js` |
| Pandoc WASM | GitHub Raw | - | `/wasm/pandoc.wasm` |
| LibOpenMPT | jsDelivr + GitHub | GitHub Raw | `/wasm/libopenmpt.*` |
| SoundFont | jsDelivr + GitHub | GitHub Raw | `/wasm/TimGM6mb.sf2` |

- **jsDelivr** - Primary for npm packages (50MB file limit, skips pandoc)
- **unpkg** - Secondary npm CDN
- **GitHub Raw** - Used for large files and custom WASM
- **Local Fallback** - All assets available locally in `dist/wasm/`

### Caching Strategy

- **Service Worker Cache API** - User-opt-in model caching (up to 1.5GB)
- **Persistent Storage** - Browser API request for cache permanence
- **Automatic Fallback** - cachedFetch() handles cache misses gracefully

## Webhooks & Callbacks

- **None implemented** - Application is stateless and client-side only
- **No server communication** - Except for optional API calls (remove.bg, OpenRouter)

## External Resources Referenced

### GitHub Repositories

- **uTogglin/convert.it** - Main source repository
  - Provides: pandoc.wasm, libopenmpt assets, soundfont
  - Branch: `master`

### Standards & Specifications

- **SVG Namespace** - `http://www.w3.org/2000/svg` for DOM operations
- **ONNX Runtime** - https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ for WASM paths
