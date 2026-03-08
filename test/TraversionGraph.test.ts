import { TraversionGraph } from "../src/TraversionGraph";
import CommonFormats from "../src/CommonFormats.ts";
import { ConvertPathNode, type FileFormat, type FormatHandler } from "../src/FormatHandler.ts";
import { MockedHandler } from "./MockedHandler.ts";
import { expect, test } from "bun:test";

const handlers : FormatHandler[] = [
  new MockedHandler("canvasToBlob", [
    CommonFormats.PNG.supported("png", true, true, true),
    CommonFormats.JPEG.supported("jpeg", true, true, false),
    CommonFormats.SVG.supported("svg", true, true, true),

  ], false),
  new MockedHandler("meyda", [
    CommonFormats.JPEG.supported("jpeg", true, true, false),
    CommonFormats.PNG.supported("png", true, true, false),
    CommonFormats.WAV.supported("wav", true, true, false)
  ], false),
  new MockedHandler("ffmpeg", [
    CommonFormats.PNG.supported("png", true, true, true),
    CommonFormats.MP3.supported("mp3", true, true, false),
    CommonFormats.WAV.supported("wav", true, true, true),
    CommonFormats.MP4.supported("mp4", true, true, true)
  ], false),
]

let supportedFormatCache = new Map<string, FileFormat[]>();
for (const handler of handlers) {
  if (!supportedFormatCache.has(handler.name)) {
    try {
      await handler.init();
    } catch (_) { continue; }
    if (handler.supportedFormats) {
      supportedFormatCache.set(handler.name, handler.supportedFormats);
    }
  }
  const supportedFormats = supportedFormatCache.get(handler.name);
  if (!supportedFormats) {
    continue;
  }
}

console.log("Testing...\n");
test('should find the optimal path from image to audio\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let optimalPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    optimalPath = path;
    break;
  }
  expect(optimalPath).not.toBeNull();
  expect(optimalPath![0].handler.name).toBe("canvasToBlob");
  expect(optimalPath![optimalPath!.length - 1].handler.name).toBe("ffmpeg");
});

test('should find the optimal path from image to audio in strict graph\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers, true);

  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let optimalPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    optimalPath = path;
    break;
  }
  expect(optimalPath).not.toBeNull();
  expect(optimalPath![0].handler.name).toBe("canvasToBlob");
  expect(optimalPath![optimalPath!.length - 1].handler.name).toBe("ffmpeg");
});


test('add category change costs should affect pathfinding\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let firstPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    firstPath = path;
    break;
  }

  graph.addCategoryChangeCost("image", "audio", 100);
  graph.init(supportedFormatCache, handlers);
  const newPaths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let newFirstPath: ConvertPathNode[] | null = null;
  for await (const path of newPaths) {
    newFirstPath = path;
    break;
  }
  expect(firstPath).not.toBeNull();
  expect(newFirstPath).not.toBeNull();
  expect(newFirstPath!.map(p => p.format.mime)).not.toEqual(firstPath!.map(p => p.format.mime));
});

test('remove category change costs should affect pathfinding\n', async () => {
  const graph = new TraversionGraph();
  graph.updateCategoryChangeCost("image", "audio", 100);
  graph.init(supportedFormatCache, handlers);

  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let firstPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    firstPath = path;
    break;
  }

  graph.removeCategoryChangeCost("image", "audio");
  graph.init(supportedFormatCache, handlers);
  const newPaths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let newFirstPath: ConvertPathNode[] | null = null;
  for await (const path of newPaths) {
    newFirstPath = path;
    break;
  }
  expect(firstPath).not.toBeNull();
  expect(newFirstPath).not.toBeNull();
  expect(newFirstPath!.map(p => p.format.mime)).not.toEqual(firstPath!.map(p => p.format.mime));
});

test('add adaptive category costs should affect pathfinding\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let firstPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    firstPath = path;
    break;
  }

  graph.addCategoryAdaptiveCost(["image", "audio"], 20000);
  graph.init(supportedFormatCache, handlers);
  const newPaths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let newFirstPath: ConvertPathNode[] | null = null;
  for await (const path of newPaths) {
    newFirstPath = path;
    break;
  }
  expect(firstPath).not.toBeNull();
  expect(newFirstPath).not.toBeNull();
  expect(newFirstPath!.map(p => p.format.mime)).not.toEqual(firstPath!.map(p => p.format.mime));
});

test('remove adaptive category costs should affect pathfinding\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let firstPath: ConvertPathNode[] | null = null;
  for await (const path of paths) {
    firstPath = path;
    break;
  }

  graph.removeCategoryAdaptiveCost(["image", "video", "audio"]);
  graph.init(supportedFormatCache, handlers);
  const newPaths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let newFirstPath: ConvertPathNode[] | null = null;
  for await (const path of newPaths) {
    newFirstPath = path;
    break;
  }
  expect(firstPath).not.toBeNull();
  expect(newFirstPath).not.toBeNull();
  expect(newFirstPath!.map(p => p.format.mime)).not.toEqual(firstPath!.map(p => p.format.mime));
});

test('abortSearch should stop path search early\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  // Abort immediately before iteration can complete
  graph.abortSearch();
  const paths = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let foundPath = false;
  for await (const path of paths) {
    foundPath = true;
    break;
  }
  // abortSearch is reset at the start of searchPath, so it should still find paths
  expect(foundPath).toBe(true);

  // Now abort mid-search by aborting after first yield
  const paths2 = graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  );
  let count = 0;
  for await (const path of paths2) {
    count++;
    graph.abortSearch(); // abort after first result
  }
  expect(count).toBe(1);
});

test('dead-end paths should be avoided in same search\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const from = new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true));
  const to = new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true));

  // Find the optimal path first
  let firstPath: ConvertPathNode[] | null = null;
  for await (const path of graph.searchPath(from, to)) {
    firstPath = path;
    break;
  }
  expect(firstPath).not.toBeNull();

  // Mark that path as a dead end, then search again — should find a different path
  graph.addDeadEndPath(firstPath!);

  let secondPath: ConvertPathNode[] | null = null;
  for await (const path of graph.searchPath(from, to)) {
    secondPath = path;
    break;
  }
  expect(secondPath).not.toBeNull();
  expect(secondPath).not.toEqual(firstPath);

  // Clear dead ends — should get original path back
  graph.clearDeadEndPaths();
  let thirdPath: ConvertPathNode[] | null = null;
  for await (const path of graph.searchPath(from, to)) {
    thirdPath = path;
    break;
  }
  expect(thirdPath).not.toBeNull();
  expect(thirdPath!.map(p => p.format.mime)).toEqual(firstPath!.map(p => p.format.mime));
});

test('dead-end paths found mid-search should be skipped by continuing generator\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const from = new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true));
  const to = new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true));

  // Iterate the generator, marking the first path as dead and continuing
  // to get the next path — without restarting the search.
  let firstPath: ConvertPathNode[] | null = null;
  let secondPath: ConvertPathNode[] | null = null;
  for await (const path of graph.searchPath(from, to)) {
    if (!firstPath) {
      firstPath = path;
      graph.addDeadEndPath(path); // simulate runtime failure
      continue; // ask generator for next path
    }
    secondPath = path;
    break;
  }
  expect(firstPath).not.toBeNull();
  expect(secondPath).not.toBeNull();
  expect(secondPath).not.toEqual(firstPath);
});

test('path event listener should receive events\n', async () => {
  const graph = new TraversionGraph();
  graph.init(supportedFormatCache, handlers);

  const events: string[] = [];
  const listener = (state: string, _path: ConvertPathNode[]) => {
    events.push(state);
  };
  graph.addPathEventListener(listener);

  for await (const _path of graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  )) { break; } // just need one path

  expect(events.length).toBeGreaterThan(0);
  expect(events).toContain("searching");
  expect(events).toContain("found");

  // removePathEventListener should work
  graph.removePathEventListener(listener);
  const eventCountBefore = events.length;
  for await (const _path of graph.searchPath(
    new ConvertPathNode(handlers.find(h => h.name === "canvasToBlob")!, CommonFormats.PNG.supported("png", true, true, true)),
    new ConvertPathNode(handlers.find(h => h.name === "ffmpeg")!, CommonFormats.MP3.supported("mp3", true, true, true)),
  )) { break; }
  expect(events.length).toBe(eventCountBefore);
});
