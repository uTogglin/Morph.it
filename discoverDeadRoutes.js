/**
 * Discovers dead conversion routes by testing each graph edge with fixture files.
 * Outputs dead-routes.json containing edges that always fail.
 *
 * Usage: bun run discoverDeadRoutes.js [output-path] [--timeout=ms]
 */
import puppeteer from "puppeteer";

const outputPath = process.argv[2] || "dist/dead-routes.json";
const perEdgeTimeout = parseInt(
  (process.argv.find(a => a.startsWith("--timeout=")) || "").split("=")[1] || "30000",
  10
);

// Map graph node identifiers (mime(format)) → fixture file + extension.
// Covers all formats we have fixture files for.
const FIXTURES = {
  // ── Images ──
  "image/png(png)":        { file: "colors_50x50.png", ext: "png"  },
  "image/jpeg(jpeg)":      { file: "fixture.jpg",      ext: "jpg"  },
  "image/gif(gif)":        { file: "fixture.gif",      ext: "gif"  },
  "image/bmp(bmp)":        { file: "fixture.bmp",      ext: "bmp"  },
  "image/tiff(tiff)":      { file: "fixture.tiff",     ext: "tiff" },
  "image/webp(webp)":      { file: "fixture.webp",     ext: "webp" },
  "image/svg+xml(svg)":    { file: "fixture.svg",      ext: "svg"  },
  "image/x-icon(ico)":     { file: "fixture.ico",      ext: "ico"  },
  "image/vnd.microsoft.icon(ico)": { file: "fixture.ico", ext: "ico" },
  "image/x-qoi(qoi)":     { file: "fixture.qoi",      ext: "qoi"  },

  // ── Audio ──
  "audio/mpeg(mp3)":       { file: "gaster.mp3",       ext: "mp3"  },
  "audio/wav(wav)":        { file: "fixture.wav",       ext: "wav"  },
  "audio/ogg(ogg)":        { file: "fixture.ogg",      ext: "ogg"  },
  "audio/flac(flac)":      { file: "fixture.flac",     ext: "flac" },
  "audio/midi(midi)":      { file: "fixture.mid",      ext: "mid"  },
  "audio/midi(mid)":       { file: "fixture.mid",      ext: "mid"  },

  // ── Video ──
  "video/mp4(mp4)":        { file: "doom.mp4",         ext: "mp4"  },

  // ── Text / Data ──
  "text/plain(text)":      { file: "fixture.txt",      ext: "txt"  },
  "text/markdown(markdown)": { file: "markdown.md",     ext: "md"   },
  "text/html(html)":       { file: "fixture.html",     ext: "html" },
  "text/csv(csv)":         { file: "fixture.csv",      ext: "csv"  },
  "text/tab-separated-values(tsv)": { file: "fixture.tsv", ext: "tsv" },
  "application/json(json)": { file: "fixture.json",    ext: "json" },
  "application/xml(xml)":  { file: "fixture.xml",      ext: "xml"  },
  "application/yaml(yaml)": { file: "fixture.yml",     ext: "yml"  },
  "text/x-python(py)":     { file: "fixture.py",       ext: "py"   },
  "application/x-sh(sh)":  { file: "fixture.sh",       ext: "sh"   },
  "text/windows-batch(batch)": { file: "fixture.bat",  ext: "bat"  },
  "text/x-go(go)":         { file: "fixture.go",       ext: "go"   },
  "text/x-csharp(cs)":     { file: "fixture.cs",       ext: "cs"   },
  "text/x-csharp(csharp)": { file: "fixture.cs",       ext: "cs"   },

  // ── Documents ──
  "application/pdf(pdf)":  { file: "fixture.pdf",      ext: "pdf"  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document(docx)":
                           { file: "word.docx",         ext: "docx" },
  "application/vnd.recordare.musicxml+xml(musicxml)":
                           { file: "fixture.musicxml",  ext: "musicxml" },

  // ── Archives ──
  "application/zip(zip)":  { file: "fixture.zip",      ext: "zip"  },
  "application/x-tar(tar)": { file: "fixture.tar",     ext: "tar"  },
  "application/gzip(gz)":  { file: "fixture.gz",       ext: "gz"   },

  // ── Fonts ──
  "font/ttf(ttf)":         { file: "fixture.ttf",      ext: "ttf"  },

  // ── 3D Models ──
  "model/gltf+json(gltf)": { file: "fixture.gltf",    ext: "gltf" },
  "model/obj(obj)":        { file: "fixture.obj",      ext: "obj"  },
  "model/stl(stl)":        { file: "fixture.stl",      ext: "stl"  },

  // ── Specialty ──
  "application/x-nbt(nbt)": { file: "fixture.nbt",    ext: "nbt"  },
  "application/bson(bson)": { file: "fixture.bson",    ext: "bson" },
  "application/x-sqlite3(sqlite)": { file: "fixture.sqlite", ext: "sqlite" },
  "application/vnd.sqlite3(sqlite)": { file: "fixture.sqlite", ext: "sqlite" },
};

const server = Bun.serve({
  async fetch(req) {
    let path = new URL(req.url).pathname.replace("/convert/", "").replace(/^\//, "") || "index.html";
    path = path.replaceAll("..", "");
    if (path.startsWith("test/")) path = "../test/resources/" + path.slice(5);
    const file = Bun.file(`${__dirname}/dist/${path}`);
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  },
  port: 8080,
});

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 0, // disable CDP timeout — the edge loop can run for hours
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
page.setDefaultTimeout(0); // no timeout on page-level operations either

// Forward ALL browser console messages to stdout so CI can see progress
page.on("console", (msg) => {
  const type = msg.type();
  const text = msg.text();
  if (type === "error") console.error(`[browser] ${text}`);
  else if (type === "warning") console.warn(`[browser] ${text}`);
  else console.log(`[browser] ${text}`);
});

// Wait for the app to be fully ready
await Promise.all([
  new Promise((resolve) => {
    page.on("console", (msg) => {
      if (msg.text() === "Built initial format list.") resolve(null);
    });
  }),
  page.goto("http://localhost:8080/convert/index.html"),
]);

console.log("App loaded. Discovering dead routes...");

// Build a map of nodeId → fixture server URL (fetched inside browser, avoids
// serialising large binary blobs through page.evaluate which hangs on big files).
const fixtureUrls = {};
for (const [nodeId, info] of Object.entries(FIXTURES)) {
  const file = Bun.file(`${__dirname}/test/resources/${info.file}`);
  if (!(await file.exists())) {
    console.warn(`Fixture missing, skipping: ${info.file}`);
    continue;
  }
  fixtureUrls[nodeId] = { url: `/test/${info.file}`, ext: info.ext };
}
console.log(`Registered ${Object.keys(fixtureUrls).length} fixture files.`);

const deadRoutes = await page.evaluate(
  async (fixtureUrls, perEdgeTimeout) => {
    const graphData = window.traversionGraph.getData();
    const handlers = window._handlers;

    // Build handler lookup
    const handlerMap = new Map();
    for (const h of handlers) handlerMap.set(h.name, h);

    // Build a secondary lookup by format name for fuzzy matching
    const fixtureByFormat = {};
    for (const [nodeId, data] of Object.entries(fixtureUrls)) {
      const fmt = nodeId.match(/\(([^)]+)\)$/)?.[1];
      if (fmt && !fixtureByFormat[fmt]) fixtureByFormat[fmt] = data;
    }

    // Cache fetched fixture bytes so each file is only downloaded once
    const bytesCache = new Map();
    async function getFixtureBytes(info) {
      if (bytesCache.has(info.url)) return bytesCache.get(info.url);
      const bytes = new Uint8Array(await fetch(info.url).then(r => r.arrayBuffer()));
      bytesCache.set(info.url, bytes);
      return bytes;
    }

    const edges = graphData.edges;
    const dead = [];
    let tested = 0;
    let skipped = 0;

    console.log(`Total edges in graph: ${edges.length}`);

    for (const edge of edges) {
      const fromId = `${edge.from.format.mime}(${edge.from.format.format})`;
      const toId = `${edge.to.format.mime}(${edge.to.format.format})`;
      // Try exact MIME match first, then fall back to format-name match
      const fixtureInfo = fixtureUrls[fromId] || fixtureByFormat[edge.from.format.format];
      if (!fixtureInfo) {
        skipped++;
        continue;
      }

      const handler = handlerMap.get(edge.handler);
      if (!handler) continue;

      tested++;
      const label = `[${tested}] ${edge.handler}: ${edge.from.format.format} -> ${edge.to.format.format}`;

      try {
        // Init handler if needed
        if (!handler.ready) {
          console.log(`${label} — initializing handler...`);
          await Promise.race([
            handler.init(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("init timeout")), perEdgeTimeout)),
          ]);
          if (!handler.ready) throw new Error(`Handler "${handler.name}" not ready after init`);
        }

        const bytes = await getFixtureBytes(fixtureInfo);
        const fileData = [{ bytes: new Uint8Array(bytes), name: `test.${fixtureInfo.ext}` }];

        // Run conversion with a timeout
        const result = await Promise.race([
          handler.doConvert(fileData, edge.from.format, edge.to.format),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), perEdgeTimeout)
          ),
        ]);

        if (!result || !result.length || result.some((f) => !f.bytes || !f.bytes.length)) {
          console.log(`${label} — DEAD (empty output)`);
          dead.push({ handler: edge.handler, from: fromId, to: toId });
        } else {
          if (tested % 25 === 0) console.log(`${label} — ok`);
        }
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        // Don't count timeouts or OOM as dead routes — they're resource-dependent
        if (msg === "timeout" || msg === "init timeout" || msg.includes("out of memory") || msg.includes("OOM")) {
          console.log(`${label} — skipped (${msg})`);
          continue;
        }
        // Don't count errors that indicate the fixture file couldn't be
        // read/decoded — these are fixture quality issues, not proof that
        // the conversion itself is broken.
        const fixtureIssue = [
          "InsufficientImageDataInFile",  // bad WebP/image fixture
          "Unable to decode audio data",  // browser can't decode OGG/FLAC stub
          "CorruptImage",                 // generic corrupt fixture
          "[object Event]",               // Image/Audio element onerror
          "Could not decode",             // generic decode failure
          "Invalid image data",           // bad fixture pixels
          "bad string length in bson",    // minimal BSON not complex enough
          "pandoc-api-version",           // generic JSON ≠ Pandoc JSON AST
          "unexpected element",           // generic XML ≠ DocBook XML
          "No valid cmap sub-tables",     // minimal TTF missing font tables
          "Invalid SVG font format",      // SVG image ≠ SVG font
        ].some(p => msg.includes(p));
        if (fixtureIssue) {
          console.log(`${label} — skipped (fixture issue: ${msg.slice(0, 80)})`);
          continue;
        }
        console.log(`${label} — DEAD (${msg.slice(0, 120)})`);
        dead.push({ handler: edge.handler, from: fromId, to: toId });
      }
    }

    console.log(`\nDone. Tested: ${tested}, Skipped (no fixture): ${skipped}, Dead: ${dead.length}`);
    return dead;
  },
  fixtureUrls,
  perEdgeTimeout
);

console.log(`Found ${deadRoutes.length} dead routes.`);

// Sort for stable diffs
deadRoutes.sort((a, b) =>
  a.handler.localeCompare(b.handler) ||
  a.from.localeCompare(b.from) ||
  a.to.localeCompare(b.to)
);

await Bun.write(outputPath, JSON.stringify(deadRoutes, null, 2) + "\n");
console.log(`Written to ${outputPath}`);

await browser.close();
server.stop();
