# Coding Conventions

**Analysis Date:** 2026-03-10

## Naming Patterns

**Classes & Interfaces:**
- Use PascalCase for class names: `FormatDefinition`, `PlaybackEngine`, `TraversionGraph`, `ArchiveHandler`
- Use PascalCase for interface names: `IFormatDefinition`, `FileFormat`, `PlaybackEngineOptions`
- Prefix "specification" interfaces with `I`: `IFormatDefinition` (data-carrying interfaces like `FileFormat`, `FileData` omit the prefix)
- Use PascalCase for type aliases: `EngineState`

**Functions & Variables:**
- Use camelCase for functions: `supported()`, `builder()`, `attemptConversion()`, `execSafe()`
- Use camelCase for variables: `currentTime`, `supportedFormats`, `compressFFmpeg`
- Use CONSTANT_CASE for module-level numeric/string constants: `DEPTH_COST`, `DEFAULT_CATEGORY_CHANGE_COST`, `YIELD_EVERY`, `MAX_SEARCH_ITERATIONS`, `LOG_FREQUENCY`

**Private Members:**
- Use ES2022 `#` private fields for truly private data: `#ffmpeg`, `#stdout` (see `src/handlers/FFmpeg.ts`)
- Use `_` prefix for internal tracking properties that may need subclass or test access: `_rafId`, `_lastTickTime`, `_connectedDecoders`, `_rendering`, `_searchAborted` (see `src/editor/PlaybackEngine.ts`)

**Handler Classes:**
- Name handler classes descriptively with a `Handler` suffix: `FFmpegHandler`, `ArchiveHandler`, `MockedHandler`
- The `name` property on a handler is a short display string, not the class name: `"FFmpeg"`, `"archive"`

## Code Style

**TypeScript Target & Strictness:**
- Target ES2022 with `strict: true` (`tsconfig.json`)
- `forceConsistentCasingInFileNames: true`
- `noFallthroughCasesInSwitch: true`
- `noUncheckedSideEffectImports: true`
- `verbatimModuleSyntax: true` — preserve `import type` distinctions

**Class Layout:**
1. Static fields
2. Public instance fields (with type annotations and defaults)
3. Private fields
4. Constructor
5. Public API (getters, then methods)
6. Private helpers

Example from `src/editor/PlaybackEngine.ts`:
```typescript
export class PlaybackEngine {
  private project: Project;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private effectChain: EffectChain;

  private state: EngineState = 'idle';
  private currentTime = 0;

  private _rafId: number | null = null;
  private _lastTickTime: number | null = null;

  constructor(project: Project, canvas: HTMLCanvasElement, opts: PlaybackEngineOptions = {}) {
    // ...
  }

  // ── Public API ───────────────────────────────────────────────────────
  get playing(): boolean  { return this.state === 'playing'; }
  get paused(): boolean   { return this.state === 'paused' || this.state === 'idle'; }
}
```

**Getters:**
- Use ES6 `get` for simple derived properties kept on one line:
  ```typescript
  get playing(): boolean        { return this.state === 'playing'; }
  get audioMixer(): AudioMixer  { return this.mixer; }
  ```

**Builder / Fluent Pattern:**
- Use for constructing `FileFormat` objects. Builder methods return `this` for chaining:
  ```typescript
  CommonFormats.TAR.builder("tar").allowTo().markLossless()
  CommonFormats.PNG.builder("apng").withFormat("apng")
  ```

**Semicolons:**
- Semicolons are used at the end of statements in most files, but some files omit them (e.g. `src/CommonFormats.ts`, `src/FormatHandler.ts` in some lines). Be consistent within a file.

## Import Organization

**Order:**
1. External / third-party packages (`import { gzip } from "pako"`)
2. Type-only imports (`import type { FileData, FileFormat } from "../FormatHandler.ts"`)
3. Local absolute imports (`import CommonFormats from "src/CommonFormats.ts"`)
4. Local relative imports (`import { cdnUrl } from "../cdn.ts"`)

**Rules:**
- Use `import type` for type-only imports — enforced by `verbatimModuleSyntax`
- Include file extensions in local imports: `.ts` or `.js`
- Both relative paths (`../FormatHandler.ts`) and absolute paths (`src/CommonFormats.ts`) are used; prefer relative for nearby files, absolute for cross-directory imports
- Use named exports; default exports are used for singleton objects like `CommonFormats`

Example from `src/handlers/FFmpeg.ts`:
```typescript
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { getBaseName } from "../utils/file-utils.ts";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { LogEvent } from "@ffmpeg/ffmpeg";
import mime from "mime";
import normalizeMimeType from "../normalizeMimeType.ts";
import CommonFormats from "src/CommonFormats.ts";
import { cdnUrl } from "../cdn.ts";
```

## Error Handling

**Throwing Errors:**
- Throw `Error` with a descriptive message including context:
  ```typescript
  throw new Error("Handler not initialized.");
  throw new Error("Model not loaded");
  throw new Error(`All CDN mirrors failed for "${key}"`);
  ```

**Try-Catch:**
- Wrap fallible operations (network, WASM, codec init) in try-catch
- Catch blocks should log with context tags and re-throw or degrade gracefully
- Use `catch (err: any)` when accessing `.message` on the error
- Use bare `catch` or `catch (_)` when the error is intentionally swallowed:
  ```typescript
  try { input?.dispose(); } catch { /* already disposed by conversion */ }
  ```

**Retry & Fallback:**
- CDN loading retries across multiple mirror URLs (`src/cdn.ts`)
- FFmpeg restarts on OOB errors via `reloadFFmpeg()` (`src/handlers/FFmpeg.ts`)
- `execSafe()` wraps FFmpeg exec with a timeout and configurable retry count

**Null Safety:**
- Use optional chaining: `this.#ffmpeg?.terminate()`
- Use nullish coalescing: `lossless ?? false`
- Guard early: `if (!this.#ffmpeg) return "";`

## Logging

**Levels — use the right one:**
- `console.log()` — startup/init milestones: `"Setup finished."`, `"[Kokoro Worker] Model loaded"`
- `console.info()` — progress/strategy info: `"[reencode] trying ${label} for ${ext}→${targetFormat}"`
- `console.warn()` — recoverable failures or fallbacks: `"[reencode] all strategies exhausted"`
- `console.error()` — hard errors: `"[OCR] Error:", err`

**Format:**
- Prefix with a bracketed category tag: `[Kokoro Worker]`, `[OCR]`, `[Whisper Worker]`, `[reencode]`
- Pattern: `console.level("[Tag] message", optionalData)`

**Suppressed Errors:**
- Comment intentionally empty catch blocks: `catch { /* ignore */ }` or `catch { /* already disposed */ }`

## Comments

**Section Dividers:**
- Use a horizontal rule with a title for major sections in large files:
  ```typescript
  // ── PlaybackEngine ──────────────────────────────────────────────────
  // ── Public API ──────────────────────────────────────────────────────
  ```

**Inline Comments:**
- Use `//` for brief explanations; reference fix/issue codes when relevant:
  ```typescript
  // C1: guard against concurrent seekTo+play per clip ID
  private _decoderStarting = new Set<string>();

  // M7: store the wall-clock timestamp of the previous RAF tick
  private _lastTickTime: number | null = null;
  ```

**JSDoc:**
- Use `/** */` for public API, interfaces, and class-level docs
- Include `@param` and `@returns` tags
- Use bold markdown in descriptions for emphasis:
  ```typescript
  /**
   * Returns `FileFormat` object that uses this format definition
   * and specified options
   * @param ref Format identifier for the handler's internal reference.
   * @param from Whether conversion **from** this format is supported.
   * @param to Whether conversion **to** this format is supported.
   * @param lossless (Optional) Whether the format is lossless. Defaults to `false`.
   */
  ```

**Block Comment Markers in Tests:**
```typescript
// ==================================================================
//                         START OF TESTS
// ==================================================================
```

## Function Design

**Parameters:**
- Use descriptive names; avoid abbreviations except well-known ones (`ctx`, `opts`, `pct`)
- Group many parameters into an options interface: `PlaybackEngineOptions`
- Use default parameter values: `opts: PlaybackEngineOptions = {}`
- Use optional parameters with `?`: `lossless?: boolean`, `cancel?: () => void`

**Async Functions:**
- Always annotate the return type: `async init(): Promise<void>`
- Prefer `async`/`await` over raw Promise chains

**Small Helpers:**
- Extract single-purpose helpers for readability, even when short:
  ```typescript
  const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const yieldToBrowser = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  function privacyArgs(): string[] { /* ... */ }
  ```

**Async Generators:**
- Use `async function*` / `for await...of` for lazy result production
- `TraversionGraph.searchPath()` yields paths one at a time; consumers `break` after finding a suitable one

## Module Design

**Handler Interface (`FormatHandler`):**
- Every converter implements `FormatHandler` from `src/FormatHandler.ts`
- Required: `name`, `ready`, `init()`, `doConvert()`
- Optional: `supportedFormats`, `supportAnyInput`, `cancel()`
- Handlers live in `src/handlers/` — one file per handler

**Handler Boilerplate:**
```typescript
class ArchiveHandler implements FormatHandler {
  public name = "archive";
  public supportAnyInput = true;
  public ready = false;
  public supportedFormats: FileFormat[] = [
    CommonFormats.TAR.builder("tar").allowTo().markLossless(),
    // ...
  ];

  async init() { /* load WASM / CDN assets */ }
  async doConvert(inputFiles, inputFormat, outputFormat, args) { /* ... */ }
}
```

**Singleton / Lazy Init:**
- Shared heavy resources (FFmpeg instances) use module-level singletons with lazy loading:
  ```typescript
  let compressFFmpeg: FFmpeg | null = null;
  let ffmpegReady: Promise<void> | null = null;

  async function getFFmpeg(): Promise<FFmpeg> {
    if (!compressFFmpeg) compressFFmpeg = new FFmpeg();
    if (!ffmpegReady) ffmpegReady = compressFFmpeg.load({ coreURL: await cdnUrl("ffmpegCore") }).then(() => {});
    await ffmpegReady;
    return compressFFmpeg;
  }
  ```

**Format Registry:**
- `src/CommonFormats.ts` exports a single object with UPPERCASE keys: `CommonFormats.PNG`, `CommonFormats.MP3`, `CommonFormats.DOCX`
- Categories defined in a `Category` const object: `Category.IMAGE`, `Category.AUDIO`, `Category.VIDEO`
- Each entry is a `FormatDefinition` instance constructed with `(name, format, extension, mime, category)`

**Directory Layout:**
| Directory | Purpose |
|---|---|
| `src/` | Core modules, entry points, type declarations |
| `src/handlers/` | `FormatHandler` implementations (one per file) |
| `src/editor/` | Video/audio editor subsystem |
| `src/utils/` | Small utility functions |
| `test/` | Test files and resources |
