# Codebase Concerns
**Analysis Date:** 2026-03-10

## Tech Debt

### 1. Extensive Use of `innerHTML` Without Sanitization
**Files:** `src/main.ts`, `src/utils/tts-player.ts`, `src/cached-fetch.ts`, `src/pdf-editor-tool.ts`, `src/handlers/pyTurtle.ts`, `src/handlers/svgForeignObject.ts`, `src/editor-page.ts`, `src/compress.ts`, `src/ocr-tool.ts`, `src/summarize-tool.ts`, `src/speech-tool.ts`, `src/editor/AudioTrackPanel.ts`, `src/editor/ColorGradingPanel.ts`

**Impact:** 30+ uses of `innerHTML` across the codebase. While most assign controlled content, several inject dynamic values (e.g. `src/main.ts:999` injects `escapeHtml(activeFolderName)` but `src/main.ts:2395` injects conversion path names without escaping). The `src/handlers/pyTurtle.ts:26` case is notable: it strips `<script>` tags from SVG but still inserts remaining HTML via `innerHTML`, which is bypassable (e.g. `<img onerror=...>`).

**Fix Approach:** Replace with DOM APIs (`createElement`/`appendChild`) for dynamic content. For static markup, use tagged template sanitizers or a Content Security Policy.

### 2. Heavy TypeScript `any` Usage (254 Occurrences)
**Files:** `src/pdf-editor-tool.ts` (69), `src/main.ts` (47), `src/compress.ts` (17), `src/whisper-worker.ts` (7), `src/handlers/flo.worker.ts` (7), `src/kokoro-worker.ts` (6), `src/handlers/midi.ts` (6), `src/handlers/mcSchematicHandler.ts` (6), `src/summarize-tool.ts` (6), `src/speech-tool.ts` (10), and 31 other files

**Impact:** Reduces type safety across the codebase. `src/pdf-editor-tool.ts` alone has 69 `any` uses, making it the most fragile file for refactoring. Runtime errors are caught late.

**Fix Approach:** Prioritize files with highest `any` count. Create proper interfaces for PDF operations, worker message types, and handler state objects.

### 3. Incomplete BSOR Renderer
**File:** `src/handlers/bsor/renderer.ts:167`

**Impact:** Beat Saber replay rendering omits wall obstacles (`// TODO: walls`). Replays that depend on wall dodging are visually inaccurate.

**Fix Approach:** Implement wall geometry rendering using obstacle data from `BSOR.Replay` or document as a known limitation.

### 4. Debug Flag Pollution in Production Code
**File:** `src/handlers/exeToBat.ts:5`

**Impact:** Hardcoded `const DEBUG_EXE_TO_BAT = false;` with 10+ conditional `console.log()` calls that remain in production bundles. Dead code increases bundle size and clutters the handler.

**Fix Approach:** Use a build-time environment variable or strip debug blocks via a Vite plugin. Apply the same pattern to any other handlers with similar debug flags.

## Known Bugs

### 1. FFmpeg WASM Memory Exhaustion and Stalling
**File:** `src/handlers/FFmpeg.ts:66-98`

**Description:** The handler documents two failure modes:
- "index out of bounds" errors, likely caused by WASM memory exhaustion
- Indefinite stalling with no error thrown, irrespective of timeout

The `execSafe()` method works around these with retry logic and `Promise.race` timeouts, but the root cause is unresolved.

**Impact:** Video/audio conversions fail unpredictably. Users may wait indefinitely if the timeout is set to `-1` (default). The retry mechanism silently restarts FFmpeg, potentially losing intermediate state.

**Fix Approach:** Investigate WASM memory limits (currently unbounded). Add explicit memory caps to FFmpeg initialization. Track failure frequency with telemetry. Consider streaming input/output to reduce peak memory.

### 2. Potential AudioContext Leak in WaveformCache
**File:** `src/editor/WaveformCache.ts:24-29`

**Description:** `getAudioContext()` creates a new `AudioContext` if the previous one is closed, but browsers limit concurrent AudioContexts (typically 6-8). If `dispose()` is called and then waveforms are requested again, a new context is created without checking the browser limit.

**Impact:** Could exhaust AudioContext quota on repeated editor open/close cycles, causing silent audio failures.

**Fix Approach:** Track context count globally. Reuse a single shared AudioContext across the application. Add error handling for context creation failure.

### 3. FFmpeg Format Parsing Assumes Specific stdout Layout
**File:** `src/handlers/FFmpeg.ts:112-120`

**Description:** `getMuxerDetails()` splits stdout by exact strings like `"Common extensions: "` and `"Mime type: "`. If FFmpeg's output format changes across versions, parsing silently produces garbage values (wrong extensions, wrong MIME types).

**Impact:** Format detection breaks silently on FFmpeg version updates. Users get files with wrong extensions.

**Fix Approach:** Add validation for parsed values. Fall back gracefully if parsing fails. Consider maintaining a static format map instead of runtime parsing.

## Security Considerations

### 1. EXE to BAT Handler: Command Injection Risk
**File:** `src/handlers/exeToBat.ts:97-153`

**Description:** The generated batch script embeds the original filename directly into PowerShell and CMD commands without escaping:
- Line 104: `set "outExe=%TEMP%\\${exeName}.exe"` - `exeName` comes from `file.name.replace(/\.[^.]*$/, "")` which only strips the extension
- A filename like `foo" & del /f /q C:\*` would break out of the `set` command

Additionally, the generated script runs `start "" "%outExe%"` which executes the reconstructed EXE automatically.

**Impact:** HIGH - Crafted filenames can execute arbitrary commands on the user's system when the generated `.bat` file is run.

**Fix Approach:** Sanitize `exeName` to alphanumeric/underscore only. Remove or gate the auto-execution behavior. Add a prominent security warning in the UI.

### 2. SVG and HTML Injection via Handlers
**Files:** `src/handlers/pyTurtle.ts:24-26`, `src/handlers/svgForeignObject.ts:39`, `src/handlers/htmlEmbed.ts`

**Description:** `pyTurtle.ts` strips `<script>` tags from SVG but assigns the rest via `innerHTML`. This is bypassable with event handler attributes (`<svg onload=...>`, `<img onerror=...>`). `svgForeignObject.ts` injects arbitrary HTML into a shadow DOM container.

**Impact:** Malicious files could execute JavaScript in the app's origin context when previewed.

**Fix Approach:** Use DOMPurify or a similar library for HTML/SVG sanitization. Render untrusted content in sandboxed iframes with `sandbox` attribute.

### 3. API Key Storage Pattern
**File:** `src/main.ts:124`

**Description:** Reference to "remove.bg API key" stored via `localStorage`. While no hardcoded key was found, the pattern of storing API keys in localStorage is insecure - any XSS vulnerability exposes all stored keys.

**Fix Approach:** Use `sessionStorage` at minimum. Prefer a backend proxy for API key management. Never store keys in client-side JavaScript.

### 4. No File Size Limits on Input
**Files:** All handlers in `src/handlers/`

**Description:** No handler validates input file size before processing. Users can drop multi-gigabyte files which are read entirely into memory via `Uint8Array`.

**Impact:** Browser tab crash (OOM). On shared hosting, could affect other users.

**Fix Approach:** Add configurable per-handler size limits. Validate before `arrayBuffer()` call. Show user-friendly error for oversized files.

## Performance Bottlenecks

### 1. Synchronous FFmpeg Format Discovery at Init
**File:** `src/handlers/FFmpeg.ts:100-180`

**Description:** `init()` sequentially queries FFmpeg for every supported muxer format, parsing stdout strings one at a time. Each query involves `execSafe()` with a 3-second timeout and up to 5 retries.

**Impact:** FFmpeg handler initialization could take 10+ seconds on first load, blocking the UI thread during format list population.

**Fix Approach:** Cache the format list in `localStorage` or IndexedDB after first discovery. Move parsing to a Web Worker. Consider shipping a static format map and only querying FFmpeg for unknown formats.

### 2. In-Memory Archive Construction
**File:** `src/handlers/archive.ts:9-60`

**Description:** `createTar()` builds the entire archive in memory as an array of `Uint8Array` blocks, then allocates a single contiguous buffer (`new Uint8Array(total)`) and copies everything. For N files of average size S, peak memory is roughly `2 * N * S` (blocks array + final buffer).

**Impact:** Creating a 500MB tar archive requires ~1GB of heap. Browser will crash on low-memory devices.

**Fix Approach:** Use `ReadableStream` to stream blocks directly to a download. Use File System Access API for writing to disk. Process files in chunks with `requestAnimationFrame` yielding (partially implemented but insufficient).

### 3. Fixed Waveform Peak Resolution
**File:** `src/editor/WaveformCache.ts:13`

**Description:** `PEAK_RESOLUTION = 2000` is hardcoded. A 3-hour podcast and a 2-second sound effect both get 2000 samples.

**Impact:** Memory waste for short clips (2000 floats regardless). Poor visual fidelity for long clips at high zoom. Mono mixdown in `_computePeaks()` also allocates a full-length `Float32Array` for the mono mix.

**Fix Approach:** Scale resolution based on `audioBuffer.duration * pixelsPerSecond`. Compute peaks lazily per-viewport-segment. Avoid full mono mixdown allocation.

### 4. Mono Mixdown Allocates Full Audio Length
**File:** `src/editor/WaveformCache.ts:102-109`

**Description:** `_computePeaks()` creates `new Float32Array(length)` where `length` is the full sample count. For a 10-minute 44.1kHz stereo file, this is ~26MB just for the intermediate mono buffer.

**Impact:** Temporary memory spike during waveform computation. Combined with the AudioBuffer itself, peak memory doubles briefly.

**Fix Approach:** Compute peaks in a single pass without materializing the full mono buffer. Process blocks of samples and compute per-channel max inline.

## Fragile Areas

### 1. Zero Test Coverage for Format Handlers
**Files:** No test files exist for any of the 80+ handlers in `src/handlers/`

**Impact:** Any change to a handler risks breaking conversions silently. The only tests found are `test/commonFormats.test.ts` and `test/TraversionGraph.test.ts`, which cover data structures but not conversion logic.

**Fix Approach:** Establish a testing framework. Create round-trip tests (encode then decode) for each handler. Prioritize FFmpeg, archive, and image handlers which are most used.

### 2. Worker Thread Lifecycle Management
**Files:** `src/handlers/flo.worker.ts`, `src/ocr-worker.ts`, `src/whisper-worker.ts`, `src/summarize-worker.ts`, `src/kokoro-worker.ts`

**Description:** Five separate worker implementations with no shared lifecycle management. Each worker manages its own initialization, error handling, and cleanup independently. No centralized worker pool, no shared cancellation mechanism.

**Impact:** If a conversion is cancelled mid-flight, workers may continue processing in the background. Workers that crash silently leave the UI in a loading state. No way to limit total worker count.

**Fix Approach:** Create a `WorkerPool` abstraction with:
- Maximum concurrent worker count
- `AbortSignal` integration for cancellation
- Centralized error propagation
- Automatic cleanup on page unload

### 3. Editor State Machine Complexity
**Files:** `src/editor/PlaybackEngine.ts`, `src/editor/TimelineController.ts`, `src/editor/ClipDecoder.ts`, `src/editor/AudioMixer.ts`, `src/editor/Exporter.ts`

**Description:** The video editor involves tightly coupled state across playback, timeline, decoder, audio mixer, and exporter. State transitions (play/pause/seek/export) must coordinate across all components. Recent git history shows multiple fixes for playback freezing after pause/edit operations.

**Impact:** High regression risk. Any change to one component may break another. The commit history (`ef8fda5`, `256f054`, `007759e`, `d1b58e4`) shows a pattern of fixing cascading audio/playback bugs.

**Fix Approach:** Introduce a formal state machine (e.g. XState). Add integration tests for common state transitions. Document the expected event flow between components.

### 4. CDN Fallback Chain
**File:** `src/cdn.ts`

**Description:** External assets (FFmpeg core, 7z WASM, fonts, etc.) are loaded via CDN with fallback URLs. `cdnUrlSync()` falls back to the last URL in the array without verification. If the primary CDN is down, initialization is slow due to sequential fallback attempts.

**Impact:** App startup is fragile and depends on external CDN availability. `cdnUrlSync()` may return a URL that has not been verified to work.

**Fix Approach:** Pre-check CDN availability in a service worker. Cache resolved URLs in `localStorage`. Bundle critical WASM files locally as fallback.

## Scaling Limits

### 1. Conversion Graph Search
**File:** `src/TraversionGraph.ts`

**Description:** The graph traversal builds edges for every handler's supported format pairs. With 80+ handlers and hundreds of formats, the graph can have thousands of edges. Search is unbounded - no maximum path length or visited-node tracking beyond basic shortest-path.

**Impact:** Pathological format combinations could cause long search times. Adding more handlers increases search time non-linearly.

**Fix Approach:** Add maximum path depth (e.g., 5 hops). Implement A* with format-distance heuristic instead of Dijkstra. Cache frequently-used paths.

### 2. No Concurrent Conversion Limits
**File:** `src/main.ts`

**Description:** The conversion queue processes files without limiting concurrency. A user dropping 100 files triggers 100 sequential conversions, each potentially loading heavy WASM modules.

**Impact:** Browser becomes unresponsive during large batch conversions. Memory accumulates across conversions if handlers don't clean up properly.

**Fix Approach:** Limit concurrent conversions to 2-3. Add a progress indicator showing queue position. Allow users to cancel individual items.

### 3. LocalStorage Limits for Settings
**File:** `src/main.ts:86-93`

**Description:** Settings and recent history stored in `localStorage`, which has a ~5MB limit per origin. No eviction strategy for old entries.

**Impact:** If users convert many files, recent history could fill localStorage, causing silent failures when saving new settings.

**Fix Approach:** Use IndexedDB for larger data (recent history, cached format lists). Implement LRU eviction for history entries.

## Dependencies at Risk

### 1. FFmpeg WASM (`@ffmpeg/ffmpeg@^0.12.15`)
**Risk:** Core dependency loaded from CDN at runtime. Semver range allows minor/patch updates that could change behavior. The WASM binary is not integrity-checked.

**Fix Approach:** Pin exact version. Add Subresource Integrity (SRI) hash verification. Bundle locally as fallback.

### 2. ImageMagick WASM (`@imagemagick/magick-wasm@^0.0.37`)
**Risk:** Pre-1.0 library (0.0.x range). API may change without notice. Limited maintenance activity.

**Fix Approach:** Pin exact version. Evaluate Canvas API or sharp-wasm as alternatives for common image operations.

### 3. Electron (`electron@^40.6.0`)
**Risk:** Desktop build depends on Electron. Security vulnerabilities in Electron are common and require prompt updates. The `^` range may pull in breaking changes.

**Fix Approach:** Pin exact version. Subscribe to Electron security advisories. Consider Tauri as a lighter alternative.

### 4. Hugging Face Transformers (`@huggingface/transformers@^3.8.1`)
**Risk:** AI model loading depends on Hugging Face CDN availability. Large model downloads (100MB+) may fail on slow connections with no resume capability.

**Fix Approach:** Add download progress UI. Implement resume-capable fetching. Cache models in IndexedDB via the existing `cached-fetch.ts` mechanism.

### 5. pdf-lib (`pdf-lib@^1.17.1`)
**Risk:** Last published 2021. No active maintenance. Known issues with certain PDF features.

**Fix Approach:** Monitor for security vulnerabilities. Evaluate pdf.js for editing capabilities or mozilla/pdfjs-dist which is actively maintained.

## Missing Critical Features

### 1. Standardized Handler Cancellation
**File:** `src/FormatHandler.ts:185`

**Description:** The `cancel` method is optional (`cancel?: () => void`). Most handlers do not implement it. There is no `AbortSignal` integration.

**Impact:** Users cannot reliably cancel long-running conversions. The UI shows a cancel button but it may not work for most handlers.

**Fix Approach:** Make `cancel()` required in the `FormatHandler` interface. Pass `AbortSignal` to `doConvert()`. Implement cancellation in all handlers, starting with FFmpeg and archive handlers.

### 2. No Progress Reporting Interface
**File:** `src/FormatHandler.ts`

**Description:** The `doConvert()` method returns `Promise<FileData[]>` with no progress callback. The UI cannot show meaningful progress for long operations.

**Impact:** Users see an indeterminate spinner for conversions that may take minutes (e.g., large video transcoding, archive creation).

**Fix Approach:** Add `onProgress?: (percent: number, message?: string) => void` parameter to `doConvert()`. Implement in FFmpeg (via log parsing), archive (via file count), and image handlers.

### 3. No Auto-Save or Recovery in Editor
**Files:** `src/editor-page.ts`, `src/editor/`

**Description:** The video editor has no auto-save, undo history persistence, or crash recovery. If the browser tab crashes or is accidentally closed, all work is lost.

**Impact:** Users editing complex video projects risk losing significant work.

**Fix Approach:** Implement periodic auto-save of project state to IndexedDB. Add crash recovery prompt on editor open. Consider using the File System Access API for persistent project files.

## Test Coverage Gaps

### 1. No Handler Unit Tests
**Impact:** 80+ format handlers completely untested. Any handler change risks silent regression.
**Priority:** CRITICAL

### 2. No Integration Tests for Conversion Chains
**Impact:** Multi-hop conversions (e.g., MIDI -> WAV -> MP3) are only validated manually.
**Priority:** HIGH

### 3. No Editor Component Tests
**Impact:** Complex state interactions between PlaybackEngine, AudioMixer, ClipDecoder, and TimelineController are untested. Recent commits show a pattern of cascading bug fixes in this area.
**Priority:** HIGH

### 4. No Worker Communication Tests
**Impact:** Message passing between main thread and 5 worker types is untested. Serialization errors or missing handlers fail silently.
**Priority:** MEDIUM

### 5. No Performance Regression Tests
**Impact:** No benchmarks for conversion speed, memory usage, or initialization time. Degradations go unnoticed until user reports.
**Priority:** LOW
