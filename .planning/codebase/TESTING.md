# Testing Patterns

**Analysis Date:** 2026-03-10

## Test Framework

**Runtime:** Bun Test (built into the Bun runtime)
- Import: `import { test, expect, afterAll } from "bun:test"`
- No external test runner or assertion library needed

**Browser Testing:** Puppeteer
- Used for integration tests that require a real browser environment
- Launched in headless mode with `--no-sandbox`

## Test File Organization

| File | Type | Purpose |
|---|---|---|
| `test/commonFormats.test.ts` | Integration | End-to-end format conversions through a headless browser |
| `test/TraversionGraph.test.ts` | Unit | Pathfinding algorithm correctness |
| `test/MockedHandler.ts` | Helper | Mock `FormatHandler` implementation |
| `test/resources/` | Fixtures | Input files for conversion tests (`colors_50x50.png`, `doom.mp4`, `word.docx`, `markdown.md`, `gaster.mp3`) |

**Naming Convention:**
- Test files use `.test.ts` suffix
- Helper/mock files use plain `.ts` suffix
- Tests live in the top-level `test/` directory (not colocated with source)

## Test Structure

**Basic Test:**
```typescript
test("descriptive name", async () => {
  // arrange, act, assert
}, { timeout: 60000 });
```

**Lifecycle Hooks:**
- `afterAll()` for teardown (close browser, stop server)
- Top-level `await` for setup (start server, launch Puppeteer, init handlers)

**Timeout:**
- Set per-test with `{ timeout: 60000 }` (60 seconds) for integration tests that involve browser evaluation and file conversion
- Unit tests in `TraversionGraph.test.ts` use default timeouts

## Mocking

**MockedHandler** (`test/MockedHandler.ts`):
- Implements the full `FormatHandler` interface
- Constructor accepts `name`, `supportedFormats`, and `supportAnyInput`
- `init()` simply sets `ready = true`
- `doConvert()` returns the input files unchanged (pass-through)

```typescript
export class MockedHandler implements FormatHandler {
  constructor(
    public name: string,
    public supportedFormats?: FileFormat[],
    public supportAnyInput?: boolean
  ) { /* ... */ }

  ready: boolean = false;

  init() {
    this.ready = true;
    return Promise.resolve();
  }

  doConvert(inputFiles: FileData[], inputFormat: FileFormat, outputFormat: FileFormat, args?: string[]): Promise<FileData[]> {
    return Promise.resolve(inputFiles);
  }
}
```

**Usage — unit tests set up multiple mocked handlers to build a realistic graph:**
```typescript
const handlers: FormatHandler[] = [
  new MockedHandler("canvasToBlob", [
    CommonFormats.PNG.supported("png", true, true, true),
    CommonFormats.JPEG.supported("jpeg", true, true, false),
    CommonFormats.SVG.supported("svg", true, true, true),
  ], false),
  new MockedHandler("meyda", [ /* ... */ ], false),
  new MockedHandler("ffmpeg", [ /* ... */ ], false),
];
```

**Inline Dummy Handler** (integration tests):
```typescript
const dummyHandler: FormatHandler = {
  name: "dummy",
  ready: true,
  async init () { },
  async doConvert (inputFiles, inputFormat, outputFormat, args) {
    return [];
  }
};
```

## Fixtures and Factories

**Test Resource Files:**
- Located in `test/resources/`
- Served via a local Bun server during integration tests
- Loaded in browser context with `fetch("/test/" + fileName).then(r => r.bytes())`

**FileData Construction Pattern:**
```typescript
const files: FileData[] = [];
for (const fileName of testFileNames) {
  files.push({
    bytes: await fetch("/test/" + fileName).then(r => r.bytes()),
    name: fileName
  });
}
```

**Format Factory — use `CommonFormats` + `.supported()` or `.builder()`:**
```typescript
// Quick format with from/to/lossless flags
CommonFormats.PNG.supported("png", true, true, true)

// Fluent builder for customized formats
CommonFormats.PNG.builder("apng").withFormat("apng").allowFrom().allowTo()
```

**Handler Cache Setup (unit tests):**
```typescript
let supportedFormatCache = new Map<string, FileFormat[]>();
for (const handler of handlers) {
  if (!supportedFormatCache.has(handler.name)) {
    try { await handler.init(); } catch (_) { continue; }
    if (handler.supportedFormats) {
      supportedFormatCache.set(handler.name, handler.supportedFormats);
    }
  }
}
```

## Coverage

**What is tested:**
- Pathfinding algorithm: optimal path discovery, cost manipulation (category change costs, adaptive costs), dead-end avoidance, search abort, event listeners
- Format conversions: same-category (`png -> jpeg`), cross-category (`png -> mp3`, `mp3 -> gif`), multi-step chains (`docx -> html -> svg -> png -> pdf`), output size validation

**What is not tested:**
- Individual handler implementations (FFmpeg, ImageMagick, Pandoc, etc.)
- UI/DOM rendering and user interactions
- Editor subsystem (`src/editor/`)
- Utility functions (`src/utils/`)
- Worker threads (`src/kokoro-worker.ts`, `src/whisper-worker.ts`)

**No formal coverage tool is configured.** Tests are run manually via Bun.

## Test Types

### Unit Tests (`test/TraversionGraph.test.ts`)

Test the `TraversionGraph` pathfinding algorithm in isolation using mocked handlers.

**Patterns tested:**
- Find optimal path between two formats
- Strict graph mode vs. default
- Adding/removing category change costs affects chosen path
- Adding/removing adaptive category costs affects chosen path
- `abortSearch()` stops iteration after first result
- Dead-end paths are skipped on retry
- Dead-end paths detected mid-generator are skipped by continuing iteration
- Path event listeners receive `"searching"` and `"found"` events; removal stops notifications

**Example:**
```typescript
test('should find the optimal path from image to audio\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const paths = graph.searchPath(from, to);
  let optimalPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    optimalPath = path;
    break;
  }
  expect(optimalPath).not.toBeNull();
  expect(optimalPath![0].handler.name).toBe("canvasToBlob");
  expect(optimalPath![optimalPath!.length - 1].handler.name).toBe("ffmpeg");
});
```

### Integration Tests (`test/commonFormats.test.ts`)

Test complete format conversions end-to-end through a headless Chrome browser running the built app.

**Setup:**
1. Start a local Bun HTTP server serving `dist/` and `test/resources/`
2. Launch Puppeteer in headless mode
3. Navigate to the app and wait for the `"Built initial format list."` console message

**Teardown:**
```typescript
afterAll(async () => {
  await browser.close();
  server.stop();
});
```

**Test Helper:**
```typescript
function attemptConversion(files: string[], from: FileFormat, to: FileFormat) {
  return page.evaluate(async (testFileNames, from, to) => {
    const files: FileData[] = [];
    for (const fileName of testFileNames) {
      files.push({
        bytes: await fetch("/test/" + fileName).then(r => r.bytes()),
        name: fileName
      });
    }
    return await window.tryConvertByTraversing(files, from, to);
  }, files, { format: from, handler: dummyHandler }, { format: to, handler: dummyHandler });
}
```

**Global type augmentation for browser-injected functions:**
```typescript
declare global {
  interface Window {
    queryFormatNode: (testFunction: (value: ConvertPathNode) => boolean) => ConvertPathNode | undefined;
    tryConvertByTraversing: (files: FileData[], from: ConvertPathNode, to: ConvertPathNode) => Promise<{
      files: FileData[];
      path: ConvertPathNode[];
    } | null>;
  }
}
```

## Common Patterns

**Assertion Styles:**
- Truthiness: `expect(result).toBeTruthy()`, `expect(result).not.toBeNull()`
- Exact equality: `expect(value).toBe(expected)`
- Deep equality: `expect(array).toEqual([...])`
- Negated equality: `expect(newPath).not.toEqual(oldPath)`
- Numeric range: `expect(fileSize).toBeWithin(55000, 65000)`
- Count: `expect(conversion?.files.length).toBe(1)`
- Contains: `expect(events).toContain("searching")`
- Greater than: `expect(events.length).toBeGreaterThan(0)`

**Verifying Conversion Paths:**
```typescript
// Check the MIME chain matches expectations
expect(conversion!.path.map(c => c.format.mime)).toEqual([
  "image/png", "audio/wav", "audio/mpeg"
]);

// Check the format chain
expect(conversion!.path.map(c => c.format.format)).toEqual(["mp4", "apng"]);

// Verify a specific handler was selected
expect(conversion!.path[1].handler.name).toBe("espeakng");
```

**Async Generator Consumption:**
```typescript
// Get the first (optimal) result and stop
let optimalPath: ConvertPathNode[] | null = null;
for await (const path of graph.searchPath(from, to)) {
  optimalPath = path;
  break;
}

// Mark first result as dead-end mid-iteration and continue to next
for await (const path of graph.searchPath(from, to)) {
  if (!firstPath) {
    firstPath = path;
    graph.addDeadEndPath(path);
    continue;
  }
  secondPath = path;
  break;
}
```

**Before/After Comparison Pattern:**
- Run a search, record the result
- Modify graph state (add cost, mark dead-end, etc.)
- Re-init and re-search
- Assert the new result differs from the original
```typescript
// before
for await (const path of graph.searchPath(from, to)) { firstPath = path; break; }

graph.addCategoryChangeCost("image", "audio", 100);
graph.init(supportedFormatCache, handlers);

// after
for await (const path of graph.searchPath(from, to)) { newFirstPath = path; break; }

expect(newFirstPath!.map(p => p.format.mime)).not.toEqual(firstPath!.map(p => p.format.mime));
```
