// ── PDF Editor Tool ──────────────────────────────────────────────────────────
// Renders PDF pages with pdfjs-dist, lets users annotate with Fabric.js,
// and exports the annotated PDF with pdf-lib.

type PdeTool = "select" | "text" | "draw" | "highlight" | "redact" | "image";

export function initPdfEditorTool() {
  /* ── DOM refs ── */
  const uploadSection = document.getElementById("pde-upload") as HTMLDivElement;
  const editorSection = document.getElementById("pde-editor") as HTMLDivElement;
  const dropArea = document.getElementById("pde-drop-area") as HTMLDivElement;
  const dropText = document.getElementById("pde-drop-text") as HTMLSpanElement;
  const fileInput = document.getElementById("pde-file-input") as HTMLInputElement;
  const imgInput = document.getElementById("pde-img-input") as HTMLInputElement;

  const bgCanvas = document.getElementById("pde-bg-canvas") as HTMLCanvasElement;
  const fabricCanvasEl = document.getElementById("pde-fabric-canvas") as HTMLCanvasElement;

  const prevBtn = document.getElementById("pde-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("pde-next") as HTMLButtonElement;
  const pageInfo = document.getElementById("pde-page-info") as HTMLSpanElement;
  const zoomInBtn = document.getElementById("pde-zoom-in") as HTMLButtonElement;
  const zoomOutBtn = document.getElementById("pde-zoom-out") as HTMLButtonElement;
  const zoomLabel = document.getElementById("pde-zoom-label") as HTMLSpanElement;
  const downloadBtn = document.getElementById("pde-download") as HTMLButtonElement;

  const undoBtn = document.getElementById("pde-undo") as HTMLButtonElement;
  const redoBtn = document.getElementById("pde-redo") as HTMLButtonElement;
  const deleteBtn = document.getElementById("pde-delete-obj") as HTMLButtonElement;

  const colorInput = document.getElementById("pde-color") as HTMLInputElement;
  const colorHex = document.getElementById("pde-color-hex") as HTMLSpanElement;
  const textProps = document.getElementById("pde-text-props") as HTMLDivElement;
  const drawProps = document.getElementById("pde-draw-props") as HTMLDivElement;
  const redactProps = document.getElementById("pde-redact-props") as HTMLDivElement;
  const redactColorInput = document.getElementById("pde-redact-color") as HTMLInputElement;
  const redactColorHex = document.getElementById("pde-redact-color-hex") as HTMLSpanElement;
  const brushInput = document.getElementById("pde-brush-size") as HTMLInputElement;
  const brushLabel = document.getElementById("pde-brush-label") as HTMLSpanElement;
  const fontInput = document.getElementById("pde-font-size") as HTMLInputElement;
  const fontSearchInput = document.getElementById("pde-font-search") as HTMLInputElement;
  const fontListEl = document.getElementById("pde-font-list") as HTMLDivElement;
  const boldBtn = document.getElementById("pde-bold") as HTMLButtonElement;
  const italicBtn = document.getElementById("pde-italic") as HTMLButtonElement;
  const underlineBtn = document.getElementById("pde-underline") as HTMLButtonElement;
  const strikeBtn = document.getElementById("pde-strikethrough") as HTMLButtonElement;
  const bulletBtn = document.getElementById("pde-bullet") as HTMLButtonElement;
  const matchTextBtn = document.getElementById("pde-match-text") as HTMLButtonElement;
  const changeDocFontBtn = document.getElementById("pde-change-doc-font") as HTMLButtonElement;
  const docFontStatus = document.getElementById("pde-doc-font-status") as HTMLSpanElement;
  const alignBtns = document.querySelectorAll<HTMLButtonElement>("[data-pde-align]");
  const opacityInput = document.getElementById("pde-opacity") as HTMLInputElement;
  const opacityLabel = document.getElementById("pde-opacity-label") as HTMLSpanElement;
  const thumbnailsContainer = document.getElementById("pde-thumbnails") as HTMLDivElement;
  const mergeFileInput = document.getElementById("pde-merge-file-input") as HTMLInputElement;
  const mergeAddBtn = document.getElementById("pde-merge-add") as HTMLButtonElement;
  const mergeListEl = document.getElementById("pde-merge-list") as HTMLDivElement;

  /* ── State ── */
  let pdfDoc: any = null;
  let pdfBytes: Uint8Array | null = null;
  let pdfFileName = "document.pdf";
  let currentPage = 1;
  let totalPages = 1;
  let zoom = 1;
  let activePdeTool: PdeTool = "select";
  let fabricCanvas: any = null;
  let fabricModule: any = null;

  const pageAnnotations: Map<number, string> = new Map();
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  let skipHistory = false;

  // Bullet point state
  const bulletedObjects = new WeakSet<any>();
  let bulletModeActive = false;
  let bulletGuard = false;

  // Font detection state
  const pageTextContent: Map<number, any> = new Map();

  // Merge PDFs state
  interface PageEntry {
    source: "primary" | "merge";
    primaryPageNum?: number;    // 1-indexed, only for source==="primary"
    mergeFileIndex?: number;    // index into pdfMergeFiles
    mergePageNum?: number;      // 1-indexed page within merge PDF
    id: number;                 // unique key for annotation maps
  }
  let pageOrder: PageEntry[] = [];
  let pdfMergeFiles: { name: string; bytes: Uint8Array; doc: any }[] = [];
  let nextMergePageId = 100000;

  function currentEntry(): PageEntry | undefined { return pageOrder[currentPage - 1]; }
  function isCurrentPrimary(): boolean { return currentEntry()?.source === "primary"; }
  function currentPrimaryPageNum(): number | null {
    const e = currentEntry();
    return e?.source === "primary" ? e.primaryPageNum! : null;
  }
  /** Returns a unique key for any page (primary or merge) for annotation/redaction maps. */
  function currentPageKey(): number | null {
    return currentEntry()?.id ?? null;
  }
  function getDocAndPage(entry: PageEntry): { doc: any; pageNum: number } {
    if (entry.source === "primary") return { doc: pdfDoc, pageNum: entry.primaryPageNum! };
    return { doc: pdfMergeFiles[entry.mergeFileIndex!].doc, pageNum: entry.mergePageNum! };
  }
  function initPageOrder() {
    pageOrder = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      pageOrder.push({ source: "primary", primaryPageNum: i, id: i });
    }
    totalPages = pageOrder.length;
    nextMergePageId = 100000;
  }

  // Text editing state
  interface TextEdit {
    id: string;
    originalStr: string;
    pdfX: number;
    pdfY: number;
    fontSizePt: number;
    fontName: string;
    detectedFamily: string;
    originalFamily?: string;
    bold: boolean;
    italic: boolean;
    color: string;
    newStr: string;
    deleted: boolean;
    ocrBased?: boolean;
  }
  const pageTextEdits: Map<number, TextEdit[]> = new Map();
  let textEditCounter = 0;

  // OCR fallback state — tracks image-only pages where text was detected via Tesseract
  const ocrPages = new Set<number>();
  const ocrOverlay = document.getElementById("pde-ocr-overlay") as HTMLDivElement;
  const ocrStatus = document.getElementById("pde-ocr-status") as HTMLSpanElement;
  function showOcrOverlay(show: boolean) { ocrOverlay.classList.toggle("hidden", !show); }
  function updateOcrProgress(pct: number, msg: string) { ocrStatus.textContent = `${msg} (${pct}%)`; }

  // Redact tool state — track independently of fabric serialization
  const pagesWithRedactions = new Set<number>();
  let redactDragStart: { x: number; y: number } | null = null;
  let redactDragRect: any = null;

  // ── Font picker state ──
  interface FontEntry { id: string; family: string; category: string; }
  let fontsourceList: FontEntry[] | null = null;
  let fontsourceFetching = false;
  let currentFontFamily = "Arial";
  const loadedFonts = new Set<string>();

  // Document-wide font override state
  let documentFontOverride: FontEntry | null = null;
  let docFontPickerMode = false;
  const docFontAppliedPages = new Set<number>();

  const SYSTEM_FONTS: FontEntry[] = [
    { id: "_arial", family: "Arial", category: "sans-serif" },
    { id: "_book-antiqua", family: "Book Antiqua", category: "serif" },
    { id: "_calibri", family: "Calibri", category: "sans-serif" },
    { id: "_cambria", family: "Cambria", category: "serif" },
    { id: "_comic-sans-ms", family: "Comic Sans MS", category: "sans-serif" },
    { id: "_consolas", family: "Consolas", category: "monospace" },
    { id: "_courier-new", family: "Courier New", category: "monospace" },
    { id: "_garamond", family: "Garamond", category: "serif" },
    { id: "_georgia", family: "Georgia", category: "serif" },
    { id: "_helvetica", family: "Helvetica", category: "sans-serif" },
    { id: "_impact", family: "Impact", category: "sans-serif" },
    { id: "_palatino-linotype", family: "Palatino Linotype", category: "serif" },
    { id: "_segoe-ui", family: "Segoe UI", category: "sans-serif" },
    { id: "_tahoma", family: "Tahoma", category: "sans-serif" },
    { id: "_times-new-roman", family: "Times New Roman", category: "serif" },
    { id: "_trebuchet-ms", family: "Trebuchet MS", category: "sans-serif" },
    { id: "_verdana", family: "Verdana", category: "sans-serif" },
  ];

  async function fetchFontsourceList(): Promise<FontEntry[]> {
    if (fontsourceList) return fontsourceList;
    if (fontsourceFetching) {
      // Wait for in-flight fetch
      return new Promise(resolve => {
        const check = setInterval(() => {
          if (fontsourceList) { clearInterval(check); resolve(fontsourceList); }
        }, 100);
      });
    }
    fontsourceFetching = true;
    try {
      const resp = await fetch("https://api.fontsource.org/v1/fonts?subsets=latin");
      const data: any[] = await resp.json();
      fontsourceList = data.map(f => ({ id: f.id, family: f.family, category: f.category || "sans-serif" }));
    } catch (err) {
      console.warn("[PDF Editor] Failed to fetch Fontsource fonts:", err);
      fontsourceList = [];
    }
    fontsourceFetching = false;
    return fontsourceList;
  }

  async function loadFontsourceFont(fontId: string, family: string): Promise<boolean> {
    if (loadedFonts.has(family)) return true;
    if (fontId.startsWith("_")) return true; // system font
    try {
      const weights = [400, 700];
      const styles: Array<"normal" | "italic"> = ["normal", "italic"];
      const promises: Promise<void>[] = [];
      for (const w of weights) {
        for (const s of styles) {
          const url = `https://cdn.jsdelivr.net/fontsource/fonts/${fontId}@latest/latin-${w}-${s}.woff2`;
          const face = new FontFace(family, `url(${url})`, { weight: String(w), style: s });
          promises.push(face.load().then(() => { document.fonts.add(face); }));
        }
      }
      await Promise.allSettled(promises);
      loadedFonts.add(family);
      return true;
    } catch {
      return false;
    }
  }

  function getAllFonts(): FontEntry[] {
    const webFonts = fontsourceList || [];
    // Merge: system fonts first, then web fonts (skip duplicates by family name)
    const seen = new Set<string>();
    const result: FontEntry[] = [];
    for (const f of SYSTEM_FONTS) { seen.add(f.family.toLowerCase()); result.push(f); }
    for (const f of webFonts) { if (!seen.has(f.family.toLowerCase())) { seen.add(f.family.toLowerCase()); result.push(f); } }
    return result;
  }

  function renderFontList(filter: string) {
    const fonts = getAllFonts();
    const lower = filter.toLowerCase();
    const filtered = lower ? fonts.filter(f => f.family.toLowerCase().includes(lower)) : fonts;
    const capped = filtered.slice(0, 100);

    fontListEl.innerHTML = "";
    for (const f of capped) {
      const div = document.createElement("div");
      div.className = "pde-font-item" + (f.family === currentFontFamily ? " active" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = f.family;
      const catSpan = document.createElement("span");
      catSpan.className = "pde-font-category";
      catSpan.textContent = f.category;
      div.appendChild(nameSpan);
      div.appendChild(catSpan);
      div.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur before click completes
        selectFont(f);
      });
      fontListEl.appendChild(div);
    }
    if (capped.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pde-font-item";
      empty.textContent = "No fonts found";
      empty.style.color = "var(--text-muted)";
      fontListEl.appendChild(empty);
    }
  }

  async function selectFont(font: FontEntry) {
    currentFontFamily = font.family;
    fontSearchInput.value = font.family;
    fontListEl.classList.remove("open");

    // Load web font if needed
    if (!font.id.startsWith("_")) {
      await loadFontsourceFont(font.id, font.family);
    }

    // Document-wide font override mode
    if (docFontPickerMode) {
      docFontPickerMode = false;
      changeDocFontBtn.classList.remove("active");
      await applyDocumentFontOverride(font);
      return;
    }

    // Apply to active text object
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("fontFamily", font.family);
      syncActiveTextEdit();
      fabricCanvas.renderAll();
    }
  }

  // Font picker event handlers
  fontSearchInput.addEventListener("focus", async () => {
    fontSearchInput.select();
    await fetchFontsourceList();
    renderFontList(fontSearchInput.value === currentFontFamily ? "" : fontSearchInput.value);
    fontListEl.classList.add("open");
  });

  fontSearchInput.addEventListener("input", () => {
    renderFontList(fontSearchInput.value);
    fontListEl.classList.add("open");
  });

  document.addEventListener("mousedown", (e) => {
    const picker = document.getElementById("pde-font-picker");
    if (picker && !picker.contains(e.target as Node)) {
      fontListEl.classList.remove("open");
      // Restore display to current font if user didn't pick
      fontSearchInput.value = currentFontFamily;
      // Cancel doc font picker mode if active
      if (docFontPickerMode) {
        docFontPickerMode = false;
        changeDocFontBtn.classList.remove("active");
      }
    }
  });

  /** Try to load a font family from Fontsource (best-effort). Returns the family name. */
  async function tryLoadFont(family: string): Promise<void> {
    if (loadedFonts.has(family)) return;
    const list = fontsourceList || await fetchFontsourceList();
    const entry = list.find(f => f.family.toLowerCase() === family.toLowerCase());
    if (entry) await loadFontsourceFont(entry.id, entry.family);
  }

  /** Sync fabric text object styling back to its TextEdit record for export. */
  function syncEditStyle(obj: any, edit: TextEdit) {
    edit.bold = obj.fontWeight === "bold";
    edit.italic = obj.fontStyle === "italic";
    if (obj.fill && typeof obj.fill === "string") edit.color = obj.fill;
    if (obj.fontFamily) edit.detectedFamily = obj.fontFamily;
    // Convert canvas pixel fontSize back to PDF points for export
    if (obj.fontSize) edit.fontSizePt = obj.fontSize / (zoom * 1.5);
  }

  /** Sync styling from the active fabric object to its TextEdit (if any). */
  function syncActiveTextEdit() {
    const obj = fabricCanvas?.getActiveObject();
    if (!obj || !obj._pdeTextEditId || obj._pdeCoverRect) return;
    const ppn = currentPrimaryPageNum();
    if (ppn === null) return;
    const edits = pageTextEdits.get(ppn);
    if (!edits) return;
    const edit = edits.find((e: TextEdit) => e.id === obj._pdeTextEditId);
    if (edit) syncEditStyle(obj, edit);
  }

  function getDefaults() {
    const brush = (() => { try { return parseInt(localStorage.getItem("convert-pde-brush") ?? "3"); } catch { return 3; } })();
    const font = (() => { try { return parseInt(localStorage.getItem("convert-pde-font") ?? "16"); } catch { return 16; } })();
    return { brush, font };
  }

  /* ── File loading ── */
  dropArea.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) loadPdf(fileInput.files[0]);
    fileInput.value = "";
  });
  dropArea.addEventListener("dragover", (e) => { e.preventDefault(); dropArea.classList.add("drag-over"); });
  dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-over"));
  dropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove("drag-over");
    if (e.dataTransfer?.files?.[0]) loadPdf(e.dataTransfer.files[0]);
  });

  async function loadPdf(file: File) {
    try {
      pdfBytes = new Uint8Array(await file.arrayBuffer());
      pdfFileName = file.name;
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      // Pass a copy to pdfjs — it detaches the ArrayBuffer, and we need the original for pdf-lib export
      pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
      initPageOrder();
      currentPage = 1;
      zoom = 1;
      pageAnnotations.clear();
      pageTextContent.clear();
      pageTextEdits.clear();
      pagesWithRedactions.clear();
      ocrPages.clear();
      textEditCounter = 0;
      documentFontOverride = null;
      docFontPickerMode = false;
      docFontAppliedPages.clear();
      changeDocFontBtn.classList.remove("active");
      docFontStatus.style.display = "none";
      docFontStatus.textContent = "";
      undoStack = [];
      redoStack = [];
      pdfMergeFiles = [];
      renderMergeList();

      uploadSection.classList.add("hidden");
      editorSection.classList.remove("hidden");

      await initFabric();
      await renderPage();
      await renderThumbnails();
    } catch (err: any) {
      console.error("[PDF Editor] Failed to load PDF:", err);
      dropText.textContent = `Error: ${err?.message || "Failed to load PDF"}`;
    }
  }

  /* ── Thumbnails ── */
  let dragFromIdx: number | null = null;

  async function renderThumbnails() {
    if (!pdfDoc) return;
    thumbnailsContainer.innerHTML = "";
    for (let idx = 0; idx < pageOrder.length; idx++) {
      const entry = pageOrder[idx];
      const { doc, pageNum } = getDocAndPage(entry);
      const page = await doc.getPage(pageNum);
      const vp = page.getViewport({ scale: 0.25 });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      const ctx = c.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const displayIdx = idx + 1;
      const item = document.createElement("div");
      item.className = "pde-thumb" + (displayIdx === currentPage ? " active" : "") + (entry.source === "merge" ? " pde-thumb-merge" : "");
      item.dataset.page = String(displayIdx);
      item.dataset.idx = String(idx);
      item.draggable = true;

      const img = document.createElement("img");
      img.src = c.toDataURL();
      img.alt = `Page ${displayIdx}`;

      const label = document.createElement("span");
      label.className = "pde-thumb-num";
      if (entry.source === "merge") {
        label.textContent = `${displayIdx} (${pdfMergeFiles[entry.mergeFileIndex!].name} p${entry.mergePageNum})`;
      } else {
        label.textContent = String(displayIdx);
      }

      // Reorder/remove controls
      const controls = document.createElement("div");
      controls.className = "pde-thumb-controls";

      if (idx > 0) {
        const upBtn = document.createElement("button");
        upBtn.className = "pde-thumb-reorder-btn";
        upBtn.title = "Move up";
        upBtn.textContent = "\u25B2";
        upBtn.addEventListener("click", (e) => { e.stopPropagation(); movePage(idx, idx - 1); });
        controls.appendChild(upBtn);
      }
      if (idx < pageOrder.length - 1) {
        const downBtn = document.createElement("button");
        downBtn.className = "pde-thumb-reorder-btn";
        downBtn.title = "Move down";
        downBtn.textContent = "\u25BC";
        downBtn.addEventListener("click", (e) => { e.stopPropagation(); movePage(idx, idx + 1); });
        controls.appendChild(downBtn);
      }
      if (entry.source === "merge") {
        const rmBtn = document.createElement("button");
        rmBtn.className = "pde-thumb-reorder-btn pde-thumb-remove";
        rmBtn.title = "Remove page";
        rmBtn.textContent = "\u00D7";
        rmBtn.addEventListener("click", (e) => { e.stopPropagation(); removePage(idx); });
        controls.appendChild(rmBtn);
      }

      // Drag-and-drop events
      item.addEventListener("dragstart", (e) => {
        dragFromIdx = idx;
        item.classList.add("pde-thumb-dragging");
        e.dataTransfer!.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        dragFromIdx = null;
        item.classList.remove("pde-thumb-dragging");
        document.querySelectorAll(".pde-thumb-drop-above, .pde-thumb-drop-below").forEach(el => {
          el.classList.remove("pde-thumb-drop-above", "pde-thumb-drop-below");
        });
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragFromIdx === null || dragFromIdx === idx) return;
        e.dataTransfer!.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        item.classList.toggle("pde-thumb-drop-above", e.clientY < midY);
        item.classList.toggle("pde-thumb-drop-below", e.clientY >= midY);
      });
      item.addEventListener("dragleave", () => {
        item.classList.remove("pde-thumb-drop-above", "pde-thumb-drop-below");
      });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("pde-thumb-drop-above", "pde-thumb-drop-below");
        if (dragFromIdx === null || dragFromIdx === idx) return;
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        let toIdx = e.clientY < midY ? idx : idx + 1;
        // Adjust if dragging from before the drop target
        if (dragFromIdx < toIdx) toIdx--;
        if (dragFromIdx !== toIdx) movePage(dragFromIdx, toIdx);
        dragFromIdx = null;
      });

      item.appendChild(img);
      item.appendChild(controls);
      item.appendChild(label);
      ((pageIdx: number) => {
        item.addEventListener("click", () => {
          saveCurrentAnnotations();
          currentPage = pageIdx + 1;
          renderPage();
          updateThumbHighlight();
        });
      })(idx);
      thumbnailsContainer.appendChild(item);
    }
  }

  function updateThumbHighlight() {
    document.querySelectorAll(".pde-thumb").forEach(el => {
      el.classList.toggle("active", parseInt((el as HTMLElement).dataset.page!) === currentPage);
    });
    document.querySelector(".pde-thumb.active")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function movePage(fromIdx: number, toIdx: number) {
    if (fromIdx < 0 || fromIdx >= pageOrder.length || toIdx < 0 || toIdx >= pageOrder.length) return;
    saveCurrentAnnotations();
    const [moved] = pageOrder.splice(fromIdx, 1);
    pageOrder.splice(toIdx, 0, moved);
    // Track current page to follow the viewed page
    const viewedIdx = currentPage - 1;
    if (viewedIdx === fromIdx) {
      currentPage = toIdx + 1;
    } else if (fromIdx < viewedIdx && toIdx >= viewedIdx) {
      currentPage--;
    } else if (fromIdx > viewedIdx && toIdx <= viewedIdx) {
      currentPage++;
    }
    renderThumbnails();
  }

  function removePage(idx: number) {
    if (idx < 0 || idx >= pageOrder.length) return;
    saveCurrentAnnotations();
    pageOrder.splice(idx, 1);
    totalPages = pageOrder.length;
    if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
    else if (idx < currentPage - 1) currentPage--;
    cleanupUnusedMergeFiles();
    renderThumbnails();
    renderPage();
    renderMergeList();
  }

  function cleanupUnusedMergeFiles() {
    const usedIndices = new Set<number>();
    for (const e of pageOrder) {
      if (e.source === "merge") usedIndices.add(e.mergeFileIndex!);
    }
    // Build index remap
    const remap = new Map<number, number>();
    const newFiles: typeof pdfMergeFiles = [];
    for (let i = 0; i < pdfMergeFiles.length; i++) {
      if (usedIndices.has(i)) {
        remap.set(i, newFiles.length);
        newFiles.push(pdfMergeFiles[i]);
      }
    }
    pdfMergeFiles = newFiles;
    // Remap indices in pageOrder
    for (const e of pageOrder) {
      if (e.source === "merge") {
        e.mergeFileIndex = remap.get(e.mergeFileIndex!)!;
      }
    }
  }

  let thumbUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleThumbUpdate() {
    if (thumbUpdateTimer) clearTimeout(thumbUpdateTimer);
    thumbUpdateTimer = setTimeout(updateCurrentThumbnail, 300);
  }

  function updateCurrentThumbnail() {
    if (!fabricCanvas || !bgCanvas) return;
    const thumbEl = thumbnailsContainer.querySelector(`.pde-thumb[data-page="${currentPage}"] img`) as HTMLImageElement | null;
    if (!thumbEl) return;

    // Composite PDF background + annotations into a small canvas
    const tw = 150;
    const scale = tw / bgCanvas.width;
    const th = Math.round(bgCanvas.height * scale);
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bgCanvas, 0, 0, tw, th);

    // Draw fabric annotations on top
    const fabricEl = fabricCanvas.getElement();
    if (fabricEl) ctx.drawImage(fabricEl, 0, 0, tw, th);

    thumbEl.src = c.toDataURL();
  }

  /* ── Merge PDFs ── */
  mergeAddBtn.addEventListener("click", () => mergeFileInput.click());
  mergeFileInput.addEventListener("change", async () => {
    const files = mergeFileInput.files;
    if (!files) return;
    const pdfjsLib = await import("pdfjs-dist");
    for (const f of Array.from(files)) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
      const mergeIdx = pdfMergeFiles.length;
      pdfMergeFiles.push({ name: f.name, bytes, doc });
      for (let p = 1; p <= doc.numPages; p++) {
        pageOrder.push({ source: "merge", mergeFileIndex: mergeIdx, mergePageNum: p, id: nextMergePageId++ });
      }
    }
    totalPages = pageOrder.length;
    mergeFileInput.value = "";
    renderMergeList();
    await renderThumbnails();
  });

  function renderMergeList() {
    mergeListEl.innerHTML = "";
    pdfMergeFiles.forEach((entry, i) => {
      const item = document.createElement("div");
      item.className = "pde-merge-item";

      const nameSpan = document.createElement("span");
      nameSpan.className = "pde-merge-item-name";
      const pgCount = pageOrder.filter(e => e.source === "merge" && e.mergeFileIndex === i).length;
      nameSpan.textContent = `${entry.name} (${pgCount} pg)`;
      nameSpan.title = entry.name;

      const actions = document.createElement("span");
      actions.className = "pde-merge-item-actions";

      const rmBtn = document.createElement("button");
      rmBtn.className = "pde-merge-item-btn";
      rmBtn.title = "Remove all pages";
      rmBtn.textContent = "\u00D7";
      rmBtn.addEventListener("click", () => {
        // Remove all pages from this merge file
        pageOrder = pageOrder.filter(e => !(e.source === "merge" && e.mergeFileIndex === i));
        totalPages = pageOrder.length;
        if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
        cleanupUnusedMergeFiles();
        renderMergeList();
        renderThumbnails();
        renderPage();
      });
      actions.appendChild(rmBtn);

      item.appendChild(nameSpan);
      item.appendChild(actions);
      mergeListEl.appendChild(item);
    });
  }

  /* ── Properties panel ── */
  function updatePropsPanel() {
    if (!fabricCanvas) return;
    const obj = fabricCanvas.getActiveObject();
    const isTextObj = obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text");

    // Show/hide property sections
    textProps.style.display = (activePdeTool === "text" || isTextObj) ? "" : "none";
    drawProps.style.display = activePdeTool === "draw" ? "" : "none";
    redactProps.style.display = activePdeTool === "redact" ? "" : "none";
    // Populate text properties from selected object
    if (isTextObj) {
      currentFontFamily = obj.fontFamily || "Arial";
      fontSearchInput.value = currentFontFamily;
      fontInput.value = String(Math.round(obj.fontSize || 16));
      boldBtn.classList.toggle("active", obj.fontWeight === "bold");
      italicBtn.classList.toggle("active", obj.fontStyle === "italic");
      underlineBtn.classList.toggle("active", !!obj.underline);
      strikeBtn.classList.toggle("active", !!obj.linethrough);
      bulletBtn.classList.toggle("active", bulletedObjects.has(obj));
      alignBtns.forEach(b => b.classList.toggle("active", b.dataset.pdeAlign === (obj.textAlign || "left")));
      if (obj.fill && typeof obj.fill === "string") {
        colorInput.value = obj.fill;
        colorHex.textContent = obj.fill;
      }
    }

    // Opacity
    if (obj) {
      const op = Math.round((obj.opacity ?? 1) * 100);
      opacityInput.value = String(op);
      opacityLabel.textContent = `${op}%`;
    } else {
      opacityInput.value = "100";
      opacityLabel.textContent = "100%";
    }
  }

  /* ── Fabric.js initialization ── */
  async function initFabric() {
    fabricModule = await import("fabric");
    const FabricCanvas = fabricModule.Canvas || (fabricModule as any).default?.Canvas;

    if (fabricCanvas) {
      fabricCanvas.dispose();
    }

    fabricCanvas = new FabricCanvas(fabricCanvasEl, {
      isDrawingMode: false,
      selection: true,
    });

    const defaults = getDefaults();
    brushInput.value = String(defaults.brush);
    brushLabel.textContent = `${defaults.brush}px`;
    fontInput.value = String(defaults.font);

    // Explicitly create a PencilBrush for drawing/signing
    const PencilBrush = fabricModule.PencilBrush || (fabricModule as any).default?.PencilBrush;
    if (PencilBrush) {
      fabricCanvas.freeDrawingBrush = new PencilBrush(fabricCanvas);
      fabricCanvas.freeDrawingBrush.width = defaults.brush;
      fabricCanvas.freeDrawingBrush.color = colorInput.value;
    }

    // Track modifications for undo
    fabricCanvas.on("object:added", () => { if (!skipHistory) pushHistory(); scheduleThumbUpdate(); });
    fabricCanvas.on("object:modified", () => { if (!skipHistory) pushHistory(); scheduleThumbUpdate(); });
    fabricCanvas.on("object:removed", (opt: any) => {
      // Skip all side effects during state restoration (clear/loadFromJSON)
      if (skipHistory) return;
      pushHistory();
      scheduleThumbUpdate();
      // Handle text edit deletion — mark edit as deleted and remove paired cover rect
      const obj = opt.target;
      if (obj?._pdeTextEditId && !obj._pdeCoverRect) {
        const ppn = currentPrimaryPageNum();
        if (ppn !== null) {
          const edits = pageTextEdits.get(ppn);
          if (edits) {
            const edit = edits.find((e: TextEdit) => e.id === obj._pdeTextEditId);
            if (edit) edit.deleted = true;
          }
        }
        // Remove paired cover rect
        const all = fabricCanvas.getObjects();
        for (const o of all) {
          if (o._pdeTextEditId === obj._pdeTextEditId && o._pdeCoverRect) {
            fabricCanvas.remove(o);
            break;
          }
        }
      }
      // If a redact rect was removed, check if page still has any
      if (obj?._pdeRedact) {
        const key = currentPageKey();
        if (key !== null) {
          const stillHasRedacts = fabricCanvas.getObjects().some((o: any) => o._pdeRedact);
          if (!stillHasRedacts) pagesWithRedactions.delete(key);
        }
      }
    });

    // Selection state for delete button + properties panel
    fabricCanvas.on("selection:created", () => { deleteBtn.disabled = false; updatePropsPanel(); });
    fabricCanvas.on("selection:updated", () => { deleteBtn.disabled = false; updatePropsPanel(); });
    fabricCanvas.on("selection:cleared", () => { deleteBtn.disabled = true; updatePropsPanel(); });

    // Auto-bullet on text changes
    fabricCanvas.on("text:changed", (opt: any) => {
      scheduleThumbUpdate();
      const obj = opt.target;
      if (!obj) return;

      // Track text edit changes
      if (obj._pdeTextEditId && !obj._pdeCoverRect) {
        const ppn = currentPrimaryPageNum();
        if (ppn !== null) {
          const edits = pageTextEdits.get(ppn);
          if (edits) {
            const edit = edits.find((e: TextEdit) => e.id === obj._pdeTextEditId);
            if (edit) {
              edit.newStr = obj.text || "";
              edit.deleted = !edit.newStr;
              syncEditStyle(obj, edit);
            }
          }
        }
      }

      if (!bulletedObjects.has(obj) || bulletGuard) return;
      bulletGuard = true;
      const lines = (obj.text as string).split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("• ") && lines[i] !== "•") {
          lines[i] = "• " + lines[i];
          changed = true;
        }
      }
      if (changed) {
        obj.set("text", lines.join("\n"));
        fabricCanvas.renderAll();
      }
      bulletGuard = false;
    });

    // Click to add or edit text
    fabricCanvas.on("mouse:down", (opt: any) => {
      if (activePdeTool === "text" && !opt.target) {
        const fabricMod = fabricModule as any;
        const IText = fabricMod.IText || fabricMod.default?.IText;
        const Rect = fabricMod.Rect || fabricMod.default?.Rect;
        const defaults = getDefaults();
        const pointer = fabricCanvas.getViewportPoint(opt.e);

        // Check if clicking on existing PDF text (primary pages only)
        const hitItem = isCurrentPrimary() ? findTextItemAtPoint(pointer.x, pointer.y) : null;
        if (hitItem) {
          // Check if this text was already edited
          const existingEdits = pageTextEdits.get(currentPrimaryPageNum()!) || [];
          const alreadyEdited = existingEdits.find(e =>
            Math.abs(e.pdfX - hitItem.pdfX) < 1 && Math.abs(e.pdfY - hitItem.pdfY) < 1
          );
          if (alreadyEdited) {
            // Already has an edit object on canvas — let user click it normally
          } else {
            // Create a cover rect matching the background color
            const bgColor = hitItem.bgColor || sampleBgColor(hitItem.canvasLeft, hitItem.canvasTop, hitItem.width, hitItem.height);
            const editId = `textedit-${++textEditCounter}`;

            const coverRect = new Rect({
              left: Math.round(hitItem.canvasLeft),
              top: Math.round(hitItem.canvasTop),
              width: Math.ceil(hitItem.width),
              height: Math.ceil(hitItem.height),
              fill: bgColor,
              stroke: bgColor,
              strokeWidth: 0,
              selectable: false,
              evented: false,
            });
            (coverRect as any)._pdeTextEditId = editId;
            (coverRect as any)._pdeCoverRect = true;
            fabricCanvas.add(coverRect);

            // Load the matched font from Fontsource if it's a web font
            tryLoadFont(hitItem.fontFamily);

            // Create editable IText with matched font
            const editText = new IText(hitItem.str, {
              left: hitItem.canvasLeft,
              top: hitItem.canvasTop,
              fontSize: hitItem.fontSize,
              fill: hitItem.color,
              fontFamily: hitItem.fontFamily,
              fontWeight: hitItem.bold ? "bold" : "normal",
              fontStyle: hitItem.italic ? "italic" : "normal",
              editable: true,
            });
            (editText as any)._pdeTextEditId = editId;
            (editText as any)._pdeCoverRect = false;

            fabricCanvas.add(editText);
            fabricCanvas.setActiveObject(editText);
            editText.enterEditing();
            editText.selectAll();

            // Record the text edit
            const textEdit: TextEdit = {
              id: editId,
              originalStr: hitItem.str,
              pdfX: hitItem.pdfX,
              pdfY: hitItem.pdfY,
              fontSizePt: hitItem.fontSizePt,
              fontName: hitItem.fontName,
              detectedFamily: hitItem.fontFamily,
              originalFamily: hitItem.fontFamily,
              bold: hitItem.bold,
              italic: hitItem.italic,
              color: hitItem.color,
              newStr: hitItem.str,
              deleted: false,
              ocrBased: ocrPages.has(currentPrimaryPageNum()!),
            };
            const ppn = currentPrimaryPageNum()!;
            if (!pageTextEdits.has(ppn)) pageTextEdits.set(ppn, []);
            pageTextEdits.get(ppn)!.push(textEdit);
            return;
          }
        }

        // No existing text hit — create new text
        const initialText = bulletModeActive ? "• " : "Type here";
        const text = new IText(initialText, {
          left: pointer.x,
          top: pointer.y,
          fontSize: parseInt(fontInput.value) || defaults.font,
          fill: colorInput.value,
          fontFamily: currentFontFamily,
          editable: true,
        });

        if (bulletModeActive) bulletedObjects.add(text);

        fabricCanvas.add(text);
        fabricCanvas.setActiveObject(text);
        text.enterEditing();
        if (!bulletModeActive) text.selectAll();
      } else if (activePdeTool === "highlight" && !opt.target) {
        const fabricMod = fabricModule as any;
        const Rect = fabricMod.Rect || fabricMod.default?.Rect;
        const pointer = fabricCanvas.getViewportPoint(opt.e);
        // Convert hex color to rgba with user-chosen opacity for highlight
        const hex = colorInput.value;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const hlAlpha = parseInt(opacityInput.value) / 100;
        const rect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: 200,
          height: 30,
          fill: `rgba(${r}, ${g}, ${b}, ${hlAlpha})`,
          stroke: `rgba(${r}, ${g}, ${b}, ${Math.min(hlAlpha + 0.15, 1)})`,
          strokeWidth: 1,
        });
        fabricCanvas.add(rect);
        fabricCanvas.setActiveObject(rect);
      } else if (activePdeTool === "redact" && !opt.target) {
        // Start drag to draw redaction rect
        const pointer = fabricCanvas.getViewportPoint(opt.e);
        redactDragStart = { x: pointer.x, y: pointer.y };
        const fabricMod = fabricModule as any;
        const Rect = fabricMod.Rect || fabricMod.default?.Rect;
        redactDragRect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: 0,
          height: 0,
          fill: redactColorInput.value,
          stroke: "transparent",
          strokeWidth: 0,
          selectable: false,
          evented: false,
          opacity: 1,
        });
        redactDragRect._pdeRedact = true;
        fabricCanvas.add(redactDragRect);
      }
    });

    // Redact tool: drag to resize
    fabricCanvas.on("mouse:move", (opt: any) => {
      if (activePdeTool !== "redact" || !redactDragStart || !redactDragRect) return;
      const pointer = fabricCanvas.getViewportPoint(opt.e);
      const left = Math.min(redactDragStart.x, pointer.x);
      const top = Math.min(redactDragStart.y, pointer.y);
      const width = Math.abs(pointer.x - redactDragStart.x);
      const height = Math.abs(pointer.y - redactDragStart.y);
      redactDragRect.set({ left, top, width, height });
      fabricCanvas.renderAll();
    });

    // Redact tool: finish drag
    fabricCanvas.on("mouse:up", () => {
      if (activePdeTool !== "redact" || !redactDragStart || !redactDragRect) return;
      const w = redactDragRect.width;
      const h = redactDragRect.height;
      if (w < 3 && h < 3) {
        fabricCanvas.remove(redactDragRect);
      } else {
        redactDragRect.set({ selectable: true, evented: true });
        fabricCanvas.setActiveObject(redactDragRect);
        pagesWithRedactions.add(currentPageKey()!);
      }
      redactDragStart = null;
      redactDragRect = null;
      fabricCanvas.renderAll();
    });


    // Image tool — convert to data URL so it survives JSON serialization
    imgInput.addEventListener("change", async () => {
      if (!imgInput.files?.[0] || !fabricCanvas) return;
      const file = imgInput.files[0];
      // Read as data URL so it's embedded in fabric JSON (blob URLs break on restore)
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const fabricMod = fabricModule as any;
      const FabricImage = fabricMod.FabricImage || fabricMod.Image || fabricMod.default?.FabricImage || fabricMod.default?.Image;
      if (FabricImage?.fromURL) {
        const img = await FabricImage.fromURL(dataUrl);
        // Scale to fit if too large
        const maxDim = Math.min(fabricCanvas.width! / 2, fabricCanvas.height! / 2);
        if (img.width! > maxDim || img.height! > maxDim) {
          const scale = maxDim / Math.max(img.width!, img.height!);
          img.scale(scale);
        }
        img.set({ left: 50, top: 50 });
        fabricCanvas.add(img);
        fabricCanvas.setActiveObject(img);
      }
      imgInput.value = "";
    });
  }

  /* ── Font detection helpers ── */

  // Strip subset prefix (e.g. "BCDFEE+Calibri" → "Calibri")
  function stripSubset(name: string): string {
    return name.replace(/^[A-Z]{6}\+/, "");
  }

  // Detect bold/italic from font name (e.g. "TimesNewRomanPS-BoldItalicMT")
  function detectFontStyle(fontName: string): { bold: boolean; italic: boolean } {
    const lower = stripSubset(fontName).toLowerCase();
    return {
      bold: /bold|demi|heavy|black/i.test(lower),
      italic: /italic|oblique|slant/i.test(lower),
    };
  }

  function mapFontFamily(pdfFamily: string): string {
    const lower = stripSubset(pdfFamily).toLowerCase().replace(/[-_,\s]+/g, "");
    // Specific font families — ordered by commonality in PDFs
    if (lower.includes("arial")) return "Arial";
    if (lower.includes("helvetica")) return "Helvetica";
    if (lower.includes("timesnewroman") || lower.includes("timesnew")) return "Times New Roman";
    if (lower.includes("times")) return "Times New Roman";
    if (lower.includes("calibri")) return "Calibri";
    if (lower.includes("cambria")) return "Cambria";
    if (lower.includes("palatino") || lower.includes("palatin")) return "Palatino Linotype";
    if (lower.includes("garamond")) return "Garamond";
    if (lower.includes("bookantiqua")) return "Book Antiqua";
    if (lower.includes("georgia")) return "Georgia";
    if (lower.includes("verdana")) return "Verdana";
    if (lower.includes("tahoma")) return "Tahoma";
    if (lower.includes("trebuchet")) return "Trebuchet MS";
    if (lower.includes("couriernew") || lower.includes("courier")) return "Courier New";
    if (lower.includes("lucidaconsole")) return "Lucida Console";
    if (lower.includes("lucidasans")) return "Lucida Sans Unicode";
    if (lower.includes("consolas")) return "Consolas";
    if (lower.includes("segoeui") || lower.includes("segoe")) return "Segoe UI";
    if (lower.includes("comicsans")) return "Comic Sans MS";
    if (lower.includes("impact")) return "Impact";
    if (lower.includes("centuryschl") || lower.includes("century")) return "Georgia";
    if (lower.includes("bookman")) return "Bookman Old Style";
    if (lower.includes("nimbus") && lower.includes("rom")) return "Times New Roman";
    if (lower.includes("nimbus") && lower.includes("san")) return "Arial";
    if (lower.includes("nimbus") && lower.includes("mon")) return "Courier New";
    if (lower.includes("liberationserif") || lower.includes("freeserif")) return "Times New Roman";
    if (lower.includes("liberationsans") || lower.includes("freesans")) return "Arial";
    if (lower.includes("liberationmono") || lower.includes("freemono")) return "Courier New";
    if (lower.includes("dejavuserif")) return "Georgia";
    if (lower.includes("dejavusans") && lower.includes("mono")) return "Courier New";
    if (lower.includes("dejavusans")) return "Verdana";
    if (lower.includes("roboto") && lower.includes("mono")) return "Roboto Mono";
    if (lower.includes("roboto")) return "Roboto";
    if (lower.includes("opensans") || (lower.includes("open") && lower.includes("sans"))) return "Open Sans";
    if (lower.includes("lato")) return "Lato";
    if (lower.includes("inter")) return "Inter";
    if (lower.includes("nunito")) return "Nunito";
    if (lower.includes("ptsans")) return "PT Sans";
    if (lower.includes("ptserif")) return "PT Serif";
    if (lower.includes("sourcesans")) return "Source Sans 3";
    if (lower.includes("sourceserif")) return "Source Serif 4";
    if (lower.includes("sourcecode")) return "Source Code Pro";
    if (lower.includes("notosans")) return "Noto Sans";
    if (lower.includes("notoserif")) return "Noto Serif";
    if (lower.includes("merriweather")) return "Merriweather";
    if (lower.includes("playfair")) return "Playfair Display";
    if (lower.includes("baskerville")) return "Libre Baskerville";
    if (lower.includes("firacode") || lower.includes("firamono")) return "Source Code Pro";
    // Generic families
    if (lower === "serif" || (lower.includes("serif") && !lower.includes("sans"))) return "Times New Roman";
    if (lower === "sansserif" || lower.includes("sans")) return "Arial";
    if (lower === "monospace" || lower.includes("mono")) return "Courier New";
    return "Arial";
  }

  function detectNearestFont(canvasX: number, canvasY: number): { fontFamily: string; fontSize: number; color: string; bold: boolean; italic: boolean } | null {
    const ppn = currentPrimaryPageNum();
    if (ppn === null) return null;
    const textContent = pageTextContent.get(ppn);
    if (!textContent || !textContent._vpTransform) return null;

    const scale = zoom * 1.5;
    const vt = textContent._vpTransform;

    let bestDist = Infinity;
    let bestItem: any = null;
    let bestCx = 0;
    let bestCy = 0;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;

      const dist = Math.sqrt((cx - canvasX) ** 2 + (cy - canvasY) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestItem = item;
        bestCx = cx;
        bestCy = cy;
      }
    }

    if (!bestItem || bestDist > 500) return null;

    // Get font family and style from the PDF font name
    let fontFamily = "Arial";
    let bold = false;
    let italic = false;
    if (bestItem.fontName) {
      // Detect bold/italic from the raw font name (e.g. "TimesNewRomanPS-BoldItalicMT")
      const style = detectFontStyle(bestItem.fontName);
      bold = style.bold;
      italic = style.italic;

      if (textContent.styles?.[bestItem.fontName]) {
        const s = textContent.styles[bestItem.fontName];
        fontFamily = mapFontFamily(s.fontFamily || bestItem.fontName);
      } else {
        fontFamily = mapFontFamily(bestItem.fontName);
      }
    }

    // Font size: pdfjs transform[0] is the effective font size in PDF user space.
    // Multiply by viewport scale to get canvas pixels (fabric fontSize units).
    const pdfPts = Math.abs(bestItem.transform[0]) || Math.abs(bestItem.transform[3]);
    const fontSize = pdfPts * scale;

    // Sample text color by scanning a grid of pixels near the matched text
    // and picking the darkest one (most likely the text, not background)
    let color = "#000000";
    try {
      const ctx = bgCanvas.getContext("2d")!;
      const glyphH = pdfPts * scale;
      let darkest = 255;
      let darkR = 0, darkG = 0, darkB = 0;
      // Sample a 5x5 grid within the glyph area
      for (let dy = -0.6; dy <= -0.1; dy += 0.12) {
        for (let dx = 0.2; dx <= 0.8; dx += 0.15) {
          const sx = Math.round(bestCx + glyphH * dx);
          const sy = Math.round(bestCy + glyphH * dy);
          if (sx < 0 || sy < 0 || sx >= bgCanvas.width || sy >= bgCanvas.height) continue;
          const px = ctx.getImageData(sx, sy, 1, 1).data;
          const brightness = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
          if (brightness < darkest) {
            darkest = brightness;
            darkR = px[0]; darkG = px[1]; darkB = px[2];
          }
        }
      }
      // Only use sampled color if it's clearly not background (< 200 brightness)
      if (darkest < 200) {
        color = "#" + [darkR, darkG, darkB].map(c => c.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* use default black */ }

    return { fontFamily, fontSize: Math.max(8, fontSize), color, bold, italic };
  }

  /* ── Text editing: hit test + background sampling ── */

  function findTextItemAtPoint(canvasX: number, canvasY: number): {
    str: string; pdfX: number; pdfY: number; canvasLeft: number; canvasTop: number;
    width: number; height: number; fontFamily: string; fontSize: number; fontSizePt: number;
    fontName: string; color: string; bold: boolean; italic: boolean; bgColor?: string;
  } | null {
    const ppn = currentPrimaryPageNum();
    if (ppn === null) return null;
    const textContent = pageTextContent.get(ppn);
    if (!textContent || !textContent._vpTransform) return null;

    const scale = zoom * 1.5;
    const vt = textContent._vpTransform;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      // Convert PDF coords to canvas coords
      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;

      // Compute text bounding box in canvas space
      const pdfPts = Math.abs(item.transform[0]) || Math.abs(item.transform[3]);
      const glyphH = pdfPts * scale;
      const textW = (item.width ?? 0) * scale;

      // Bounding box: text baseline is at cy, text extends upward
      const boxLeft = cx;
      const boxTop = cy - glyphH;
      const boxRight = cx + textW;
      const boxBottom = cy + glyphH * 0.3; // small descender allowance

      if (canvasX >= boxLeft - 2 && canvasX <= boxRight + 2 &&
          canvasY >= boxTop - 2 && canvasY <= boxBottom + 2) {
        // Hit! Get font info
        let fontFamily = "Arial";
        let bold = false;
        let italic = false;
        let fontName = item.fontName || "";
        if (item._ocrBold !== undefined) {
          // OCR-detected item — use visually matched font + Tesseract style flags
          bold = !!item._ocrBold;
          italic = !!item._ocrItalic;
          if (item._ocrFontFamily) fontFamily = item._ocrFontFamily;
        } else if (fontName) {
          const style = detectFontStyle(fontName);
          bold = style.bold;
          italic = style.italic;
          if (textContent.styles?.[fontName]) {
            fontFamily = mapFontFamily(textContent.styles[fontName].fontFamily || fontName);
          } else {
            fontFamily = mapFontFamily(fontName);
          }
        }

        const fontSize = pdfPts * scale;

        // Sample text color
        let color = "#000000";
        try {
          const ctx = bgCanvas.getContext("2d")!;
          let darkest = 255;
          let darkR = 0, darkG = 0, darkB = 0;
          for (let dy = -0.6; dy <= -0.1; dy += 0.12) {
            for (let dx = 0.2; dx <= 0.8; dx += 0.15) {
              const sx = Math.round(cx + glyphH * dx);
              const sy = Math.round(cy + glyphH * dy);
              if (sx < 0 || sy < 0 || sx >= bgCanvas.width || sy >= bgCanvas.height) continue;
              const px = ctx.getImageData(sx, sy, 1, 1).data;
              const brightness = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
              if (brightness < darkest) {
                darkest = brightness;
                darkR = px[0]; darkG = px[1]; darkB = px[2];
              }
            }
          }
          if (darkest < 200) {
            color = "#" + [darkR, darkG, darkB].map(c => c.toString(16).padStart(2, "0")).join("");
          }
        } catch { /* default black */ }

        // For OCR items, use stored line bbox for cover rect to fully hide original text
        let coverTop = boxTop;
        let coverH = glyphH * 1.3;
        if (item._ocrLineTop !== undefined) {
          coverTop = item._ocrLineTop - 1;
          coverH = (item._ocrLineBot - item._ocrLineTop) + 1;
        }

        return {
          str: item.str, pdfX, pdfY,
          canvasLeft: boxLeft - 1, canvasTop: coverTop,
          width: Math.max(textW, 20) + 2, height: coverH,
          fontFamily, fontSize: Math.max(8, fontSize), fontSizePt: pdfPts,
          fontName, color, bold, italic,
          bgColor: item._ocrBgColor || undefined,
        };
      }
    }
    return null;
  }

  function sampleBgColor(x: number, y: number, w: number, h: number): string {
    try {
      const ctx = bgCanvas.getContext("2d")!;
      // Sample pixels around the edges of the bounding box (background, not text)
      let totalR = 0, totalG = 0, totalB = 0, count = 0;
      const offsets = [
        [x - 3, y + h / 2], [x + w + 3, y + h / 2],       // left/right of box
        [x + w / 2, y - 3], [x + w / 2, y + h + 3],       // above/below box
        [x - 3, y - 3], [x + w + 3, y - 3],                // corners above
        [x - 3, y + h + 3], [x + w + 3, y + h + 3],       // corners below
      ];
      for (const [sx, sy] of offsets) {
        const px = Math.round(sx);
        const py = Math.round(sy);
        if (px < 0 || py < 0 || px >= bgCanvas.width || py >= bgCanvas.height) continue;
        const pd = ctx.getImageData(px, py, 1, 1).data;
        totalR += pd[0]; totalG += pd[1]; totalB += pd[2];
        count++;
      }
      if (count > 0) {
        const r = Math.round(totalR / count);
        const g = Math.round(totalG / count);
        const b = Math.round(totalB / count);
        return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* fallback */ }
    return "#ffffff";
  }

  /* ── Document-wide font override ── */

  /** Create TextEdits for all text items on a page, applying the given font family. */
  function createTextEditsForEntirePage(pageNum: number, fontFamily: string) {
    const textContent = pageTextContent.get(pageNum);
    if (!textContent || !textContent._vpTransform) return;

    const scale = zoom * 1.5;
    const vt = textContent._vpTransform;
    const existingEdits = pageTextEdits.get(pageNum) || [];
    const fabricMod = fabricModule as any;
    const IText = fabricMod.IText || fabricMod.default?.IText;
    const Rect = fabricMod.Rect || fabricMod.default?.Rect;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      // Skip if already has an edit
      const alreadyEdited = existingEdits.find(e =>
        Math.abs(e.pdfX - pdfX) < 1 && Math.abs(e.pdfY - pdfY) < 1
      );
      if (alreadyEdited) {
        // Update existing edit's font
        alreadyEdited.detectedFamily = fontFamily;
        // Update the corresponding fabric object on current page
        if (pageNum === currentPrimaryPageNum() && fabricCanvas) {
          for (const obj of fabricCanvas.getObjects()) {
            if ((obj as any)._pdeTextEditId === alreadyEdited.id && !(obj as any)._pdeCoverRect) {
              obj.set("fontFamily", fontFamily);
            }
          }
        }
        continue;
      }

      // Compute canvas coordinates
      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;
      const pdfPts = Math.abs(item.transform[0]) || Math.abs(item.transform[3]);
      const glyphH = pdfPts * scale;
      const textW = (item.width ?? 0) * scale;
      const boxLeft = cx;
      const boxTop = cy - glyphH;

      // Detect original font info
      let origFamily = "Arial";
      let bold = false;
      let italic = false;
      const fontName = item.fontName || "";
      if (item._ocrBold !== undefined) {
        bold = !!item._ocrBold;
        italic = !!item._ocrItalic;
        if (item._ocrFontFamily) origFamily = item._ocrFontFamily;
      } else if (fontName) {
        const style = detectFontStyle(fontName);
        bold = style.bold;
        italic = style.italic;
        if (textContent.styles?.[fontName]) {
          origFamily = mapFontFamily(textContent.styles[fontName].fontFamily || fontName);
        } else {
          origFamily = mapFontFamily(fontName);
        }
      }

      // Sample text color
      let color = "#000000";
      try {
        const ctx = bgCanvas.getContext("2d")!;
        let darkest = 255;
        let darkR = 0, darkG = 0, darkB = 0;
        for (let dy = -0.6; dy <= -0.1; dy += 0.12) {
          for (let dx = 0.2; dx <= 0.8; dx += 0.15) {
            const sx = Math.round(cx + glyphH * dx);
            const sy = Math.round(cy + glyphH * dy);
            if (sx < 0 || sy < 0 || sx >= bgCanvas.width || sy >= bgCanvas.height) continue;
            const px = ctx.getImageData(sx, sy, 1, 1).data;
            const brightness = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
            if (brightness < darkest) {
              darkest = brightness;
              darkR = px[0]; darkG = px[1]; darkB = px[2];
            }
          }
        }
        if (darkest < 200) {
          color = "#" + [darkR, darkG, darkB].map(c => c.toString(16).padStart(2, "0")).join("");
        }
      } catch { /* default black */ }

      const fontSize = Math.max(8, pdfPts * scale);
      let coverTop = boxTop;
      let coverH = glyphH * 1.3;
      if (item._ocrLineTop !== undefined) {
        coverTop = item._ocrLineTop - 1;
        coverH = (item._ocrLineBot - item._ocrLineTop) + 1;
      }
      const canvasLeft = boxLeft - 1;
      const coverWidth = Math.max(textW, 20) + 2;

      const editId = `textedit-${++textEditCounter}`;
      const bgColor = item._ocrBgColor || sampleBgColor(canvasLeft, coverTop, coverWidth, coverH);

      // Only create fabric objects if this is the current page
      if (pageNum === currentPrimaryPageNum() && fabricCanvas) {
        const coverRect = new Rect({
          left: Math.round(canvasLeft),
          top: Math.round(coverTop),
          width: Math.ceil(coverWidth),
          height: Math.ceil(coverH),
          fill: bgColor,
          stroke: bgColor,
          strokeWidth: 0,
          selectable: false,
          evented: false,
        });
        (coverRect as any)._pdeTextEditId = editId;
        (coverRect as any)._pdeCoverRect = true;
        fabricCanvas.add(coverRect);

        const editText = new IText(item.str, {
          left: canvasLeft,
          top: coverTop,
          fontSize,
          fill: color,
          fontFamily,
          fontWeight: bold ? "bold" : "normal",
          fontStyle: italic ? "italic" : "normal",
          editable: true,
        });
        (editText as any)._pdeTextEditId = editId;
        (editText as any)._pdeCoverRect = false;
        fabricCanvas.add(editText);
      }

      const textEdit: TextEdit = {
        id: editId,
        originalStr: item.str,
        pdfX,
        pdfY,
        fontSizePt: pdfPts,
        fontName,
        detectedFamily: fontFamily,
        originalFamily: origFamily,
        bold,
        italic,
        color,
        newStr: item.str,
        deleted: false,
        ocrBased: ocrPages.has(pageNum),
      };
      if (!pageTextEdits.has(pageNum)) pageTextEdits.set(pageNum, []);
      pageTextEdits.get(pageNum)!.push(textEdit);
    }

    docFontAppliedPages.add(pageNum);
    if (pageNum === currentPrimaryPageNum() && fabricCanvas) {
      saveCurrentAnnotations();
      fabricCanvas.renderAll();
    }
  }

  /** Apply a document-wide font override — process current page, mark for lazy apply. */
  async function applyDocumentFontOverride(font: FontEntry) {
    documentFontOverride = font;
    docFontAppliedPages.clear();

    // Load the font
    if (!font.id.startsWith("_")) {
      await loadFontsourceFont(font.id, font.family);
    }

    // Apply to current page (only if it's a primary page)
    const ppn = currentPrimaryPageNum();
    if (ppn !== null) createTextEditsForEntirePage(ppn, font.family);

    // Update status label
    docFontStatus.textContent = `Document font: ${font.family}`;
    docFontStatus.style.display = "";
  }

  /* ── Width-calibrated font detection via pixel comparison ── */
  const FONT_CANDIDATES = [
    // Sans-serif
    "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI",
    "Calibri", "Lucida Sans Unicode",
    // Serif
    "Times New Roman", "Georgia", "Palatino Linotype", "Garamond",
    "Book Antiqua", "Cambria",
    // Monospace
    "Courier New", "Consolas", "Lucida Console",
  ];

  /** Binary-search the fontSize where measureText(text).width ≈ targetW */
  function calibrateFontSize(
    ctx: CanvasRenderingContext2D, text: string, targetW: number,
    font: string, bold: boolean, italic: boolean,
  ): number {
    const weight = bold ? "bold" : "normal";
    const style = italic ? "italic" : "normal";
    let lo = 4, hi = targetW; // fontSize can't exceed targetW for any reasonable text
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      ctx.font = `${style} ${weight} ${mid}px "${font}"`;
      if (ctx.measureText(text).width < targetW) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Detect font + correct fontSize for an OCR line by:
   * 1. For each candidate font, calibrate fontSize so rendered width matches source width
   * 2. Render at calibrated size, compare pixel luminance against source
   * 3. Return the best-matching font and its calibrated pixel size
   */
  function detectFontForLine(
    srcCanvas: HTMLCanvasElement, text: string,
    bbox: { x0: number; y0: number; x1: number; y1: number },
    bold: boolean, italic: boolean, candidates: string[],
  ): { font: string; fontSizePx: number } {
    const bw = Math.round(bbox.x1 - bbox.x0);
    const bh = Math.round(bbox.y1 - bbox.y0);
    const fallback = { font: "Arial", fontSizePx: bh * 0.92 };
    if (bw < 10 || bh < 8 || text.length < 2) return fallback;

    // Crop source luminance
    const srcCtx = srcCanvas.getContext("2d")!;
    const srcData = srcCtx.getImageData(Math.round(bbox.x0), Math.round(bbox.y0), bw, bh).data;
    const srcLum = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) {
      srcLum[i] = srcData[i * 4] * 0.299 + srcData[i * 4 + 1] * 0.587 + srcData[i * 4 + 2] * 0.114;
    }
    let srcMin = 255, srcMax = 0;
    for (let i = 0; i < srcLum.length; i++) {
      if (srcLum[i] < srcMin) srcMin = srcLum[i];
      if (srcLum[i] > srcMax) srcMax = srcLum[i];
    }
    const srcRange = srcMax - srcMin || 1;

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = bw;
    tmpCanvas.height = bh;
    const tmpCtx = tmpCanvas.getContext("2d")!;
    const calCanvas = document.createElement("canvas");
    const calCtx = calCanvas.getContext("2d")!;

    let bestFont = "Arial";
    let bestSize = bh * 0.92;
    let bestScore = Infinity;

    for (const font of candidates) {
      // Step 1: calibrate fontSize so rendered width matches source width
      const fontSize = calibrateFontSize(calCtx, text, bw, font, bold, italic);

      // Step 2: render at calibrated size, compare pixels
      tmpCtx.clearRect(0, 0, bw, bh);
      tmpCtx.fillStyle = "#ffffff";
      tmpCtx.fillRect(0, 0, bw, bh);
      const weight = bold ? "bold" : "normal";
      const style = italic ? "italic" : "normal";
      tmpCtx.font = `${style} ${weight} ${fontSize}px "${font}"`;
      tmpCtx.fillStyle = "#000000";
      tmpCtx.textBaseline = "top";
      tmpCtx.fillText(text, 0, 0);

      const tmpData = tmpCtx.getImageData(0, 0, bw, bh).data;
      let diff = 0;
      for (let i = 0; i < bw * bh; i++) {
        const tLum = tmpData[i * 4] * 0.299 + tmpData[i * 4 + 1] * 0.587 + tmpData[i * 4 + 2] * 0.114;
        const s = (srcLum[i] - srcMin) / srcRange;
        const t = tLum / 255;
        diff += (s - t) * (s - t);
      }
      if (diff < bestScore) {
        bestScore = diff;
        bestFont = font;
        bestSize = fontSize;
      }
    }
    return { font: bestFont, fontSizePx: bestSize };
  }

  /** Sample background color for an OCR line by reading pixels around it and from page margins */
  function sampleOcrBgColor(srcCanvas: HTMLCanvasElement, bbox: { x0: number; y0: number; x1: number; y1: number }): string {
    const ctx = srcCanvas.getContext("2d")!;
    const samples: [number, number, number][] = [];
    const w = bbox.x1 - bbox.x0;
    const midY = Math.round((bbox.y0 + bbox.y1) / 2);

    // Sample from 15px above and below the line (far enough to avoid anti-aliased text)
    for (const sy of [bbox.y0 - 15, bbox.y1 + 15]) {
      if (sy < 0 || sy >= srcCanvas.height) continue;
      for (let i = 0; i < 10; i++) {
        const sx = Math.round(bbox.x0 + (w * i) / 9);
        if (sx < 0 || sx >= srcCanvas.width) continue;
        const pd = ctx.getImageData(sx, Math.round(sy), 1, 1).data;
        const brightness = pd[0] * 0.299 + pd[1] * 0.587 + pd[2] * 0.114;
        if (brightness > 200) samples.push([pd[0], pd[1], pd[2]]);
      }
    }
    // Sample from left/right page margins at the same Y level as the text
    for (const sx of [5, 15, srcCanvas.width - 15, srcCanvas.width - 5]) {
      if (sx < 0 || sx >= srcCanvas.width) continue;
      const pd = ctx.getImageData(sx, midY, 1, 1).data;
      const brightness = pd[0] * 0.299 + pd[1] * 0.587 + pd[2] * 0.114;
      if (brightness > 200) samples.push([pd[0], pd[1], pd[2]]);
    }

    if (samples.length > 0) {
      // Use the brightest samples (top half) to avoid any residual text influence
      samples.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
      const top = samples.slice(0, Math.max(1, Math.ceil(samples.length / 2)));
      let tR = 0, tG = 0, tB = 0;
      for (const [r, g, b] of top) { tR += r; tG += g; tB += b; }
      const r = Math.round(tR / top.length);
      const g = Math.round(tG / top.length);
      const b = Math.round(tB / top.length);
      return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
    }
    return "#ffffff";
  }

  /** Scan an OCR line's bbox to find the actual ink boundaries (dark pixel extents) */
  function findInkBounds(
    srcCanvas: HTMLCanvasElement,
    bbox: { x0: number; y0: number; x1: number; y1: number },
  ): { top: number; bottom: number; left: number; right: number } {
    const ctx = srcCanvas.getContext("2d")!;
    const x = Math.max(0, Math.round(bbox.x0));
    const y = Math.max(0, Math.round(bbox.y0));
    const w = Math.min(Math.round(bbox.x1 - bbox.x0), srcCanvas.width - x);
    const h = Math.min(Math.round(bbox.y1 - bbox.y0), srcCanvas.height - y);
    if (w < 1 || h < 1) return { top: bbox.y0, bottom: bbox.y1, left: bbox.x0, right: bbox.x1 };

    const data = ctx.getImageData(x, y, w, h).data;
    let firstRow = h, lastRow = -1, firstCol = w, lastCol = -1;

    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4;
        const brightness = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (brightness < 128) {
          if (row < firstRow) firstRow = row;
          if (row > lastRow) lastRow = row;
          if (col < firstCol) firstCol = col;
          if (col > lastCol) lastCol = col;
        }
      }
    }

    if (lastRow < 0) return { top: bbox.y0, bottom: bbox.y1, left: bbox.x0, right: bbox.x1 };
    return {
      top: y + firstRow,
      bottom: y + lastRow + 1,
      left: x + firstCol,
      right: x + lastCol + 1,
    };
  }

  /* ── OCR fallback for image-only pages ── */
  async function runOcrForPage(pageNum: number, canvas: HTMLCanvasElement, currentZoom: number) {
    try {
      showOcrOverlay(true);
      updateOcrProgress(0, "Loading OCR engine");
      const { getOcrWorker } = await import("./ocr-worker.js");
      const worker = await getOcrWorker("eng", (pct, msg) => updateOcrProgress(pct, msg));
      updateOcrProgress(25, "Recognizing text");
      const { data } = await worker.recognize(canvas);
      const lines: any[] = data.lines || [];
      if (lines.length === 0) { showOcrOverlay(false); return; }

      const scale = currentZoom * 1.5; // must match renderPage scale
      const items: any[] = [];
      updateOcrProgress(50, "Detecting fonts");
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineText = line.text?.trim();
        if (!lineText) continue;
        const { x0, y0, x1, y1 } = line.bbox;
        const lineH = y1 - y0;
        const lineW = x1 - x0;
        if (lineH < 4 || lineW < 4) continue;

        // Detect bold/italic from majority vote across words
        const lineWords: any[] = line.words || [];
        const boldCount = lineWords.filter((w: any) => w.is_bold).length;
        const italicCount = lineWords.filter((w: any) => w.is_italic).length;
        const lineBold = boldCount > lineWords.length / 2;
        const lineItalic = italicCount > lineWords.length / 2;

        // Find actual ink boundaries for precise cover rect and font matching
        const inkBounds = findInkBounds(canvas, line.bbox);
        const inkBbox = { x0: inkBounds.left, y0: inkBounds.top, x1: inkBounds.right, y1: inkBounds.bottom };
        const inkH = inkBounds.bottom - inkBounds.top;
        const inkW = inkBounds.right - inkBounds.left;

        // Width-calibrated font detection using tight ink bounds
        const { font: lineFont, fontSizePx } = lineText.length >= 2 && inkW >= 10 && inkH >= 8
          ? detectFontForLine(canvas, lineText, inkBbox, lineBold, lineItalic, FONT_CANDIDATES)
          : { font: "Arial", fontSizePx: inkH * 0.92 };
        const lineFontPt = fontSizePx / scale;

        // Pre-compute background color from above/below the line (avoids sampling text)
        const bgColor = sampleOcrBgColor(canvas, line.bbox);

        // Baseline: ink bottom minus ~20% of ink height (descender allowance)
        const baselinePx = inkBounds.bottom - inkH * 0.2;
        items.push({
          str: lineText,
          transform: [lineFontPt, 0, 0, lineFontPt, inkBounds.left / scale, baselinePx / scale],
          width: inkW / scale,
          fontName: "",
          _ocrBold: lineBold,
          _ocrItalic: lineItalic,
          _ocrFontFamily: lineFont,
          _ocrLineTop: inkBounds.top,
          _ocrLineBot: inkBounds.bottom,
          _ocrBgColor: bgColor,
        });
        if (li % 5 === 0) updateOcrProgress(50 + Math.round((li / lines.length) * 45), "Detecting fonts");
      }

      // Identity viewport transform — pdfX * scale = canvasX directly
      const syntheticTc = { items, styles: {}, _vpTransform: [1, 0, 0, 1, 0, 0] };
      pageTextContent.set(pageNum, syntheticTc);
      updateOcrProgress(100, "Done");
    } catch (err) {
      console.warn("[PDF Editor] OCR fallback failed:", err);
    } finally {
      showOcrOverlay(false);
    }
  }

  /* ── Annotation tools enabled/disabled for merge pages ── */
  function setAnnotationToolsEnabled(enabled: boolean) {
    if (fabricCanvas) {
      if (!enabled) {
        fabricCanvas.isDrawingMode = false;
        fabricCanvas.selection = false;
      } else {
        // Restore based on active tool
        fabricCanvas.selection = activePdeTool === "select";
        fabricCanvas.isDrawingMode = activePdeTool === "draw";
      }
    }
    document.querySelectorAll<HTMLElement>("[data-pde-tool]").forEach(el => {
      el.classList.toggle("pde-tool-disabled", !enabled);
    });
  }

  /* ── Render PDF page ── */
  async function renderPage() {
    if (!pdfDoc || !fabricCanvas) return;

    const entry = currentEntry();
    if (!entry) return;
    const { doc, pageNum } = getDocAndPage(entry);
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: zoom * 1.5 }); // 1.5 base for quality

    // Size canvases
    const w = Math.round(vp.width);
    const h = Math.round(vp.height);
    bgCanvas.width = w;
    bgCanvas.height = h;
    bgCanvas.style.width = `${w}px`;
    bgCanvas.style.height = `${h}px`;
    fabricCanvas.setDimensions({ width: w, height: h });

    // Render PDF page to background canvas
    const ctx = bgCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    setAnnotationToolsEnabled(true);

    if (entry.source === "primary") {
      const ppn = entry.primaryPageNum!;

      // Extract text content for font detection (cache per page)
      if (!pageTextContent.has(ppn)) {
        try {
          const tc = await page.getTextContent();
          const hasText = tc.items?.some((it: any) => it.str && it.str.trim());
          if (hasText) {
            const rawVp = page.getViewport({ scale: 1 });
            tc._vpTransform = rawVp.transform;
            pageTextContent.set(ppn, tc);
          } else {
            ocrPages.add(ppn);
            await runOcrForPage(ppn, bgCanvas, zoom);
          }
        } catch { /* non-critical */ }
      }

      // Lazy-apply document font override to newly visited pages
      if (documentFontOverride && !docFontAppliedPages.has(ppn) && pageTextContent.has(ppn)) {
        createTextEditsForEntirePage(ppn, documentFontOverride.family);
      }
    }

    // Restore annotations for this page (works for both primary and merge)
    await restoreAnnotations();

    // Update UI
    pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    updateThumbHighlight();
  }

  function saveCurrentAnnotations() {
    if (!fabricCanvas) return;
    const key = currentPageKey();
    if (key === null) return;
    pageAnnotations.set(key, serializeFabricState());
  }

  async function restoreAnnotations(): Promise<void> {
    if (!fabricCanvas) return;
    skipHistory = true;
    fabricCanvas.clear();
    const key = currentPageKey();
    const saved = key !== null ? pageAnnotations.get(key) : undefined;
    if (saved) {
      await loadFabricState(saved);
    } else {
      fabricCanvas.renderAll();
    }
    skipHistory = false;
  }

  /* ── Undo/Redo ── */
  /** Serialize fabric canvas state with custom properties preserved */
  function serializeFabricState(): string {
    const jsonObj = fabricCanvas.toJSON(["_pdeTextEditId", "_pdeCoverRect", "_pdeRedact"]);
    const objs = fabricCanvas.getObjects();
    for (let i = 0; i < objs.length && i < jsonObj.objects.length; i++) {
      const obj = objs[i] as any;
      if (obj._pdeRedact) jsonObj.objects[i]._pdeRedact = true;
      if (obj._pdeTextEditId) jsonObj.objects[i]._pdeTextEditId = obj._pdeTextEditId;
      if (obj._pdeCoverRect) jsonObj.objects[i]._pdeCoverRect = true;
    }
    return JSON.stringify(jsonObj);
  }

  /** Load fabric state and re-apply custom properties */
  async function loadFabricState(json: string): Promise<void> {
    const parsed = JSON.parse(json);
    await fabricCanvas.loadFromJSON(json);
    const objs = fabricCanvas.getObjects();
    for (let i = 0; i < parsed.objects.length && i < objs.length; i++) {
      const src = parsed.objects[i];
      const obj = objs[i] as any;
      if (src._pdeRedact) obj._pdeRedact = true;
      if (src._pdeTextEditId) obj._pdeTextEditId = src._pdeTextEditId;
      if (src._pdeCoverRect) obj._pdeCoverRect = true;
    }
    fabricCanvas.renderAll();
  }

  function pushHistory() {
    undoStack.push(serializeFabricState());
    redoStack = [];
    if (undoStack.length > 50) undoStack.shift();
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length <= 0;
    redoBtn.disabled = redoStack.length <= 0;
  }

  undoBtn.addEventListener("click", async () => {
    if (undoStack.length === 0) return;
    redoStack.push(serializeFabricState());
    const prev = undoStack.pop()!;
    skipHistory = true;
    await loadFabricState(prev);
    skipHistory = false;
    updateUndoRedoButtons();
    scheduleThumbUpdate();
  });

  redoBtn.addEventListener("click", async () => {
    if (redoStack.length === 0) return;
    undoStack.push(serializeFabricState());
    const next = redoStack.pop()!;
    skipHistory = true;
    await loadFabricState(next);
    skipHistory = false;
    updateUndoRedoButtons();
    scheduleThumbUpdate();
  });

  /* ── Delete selected ── */
  deleteBtn.addEventListener("click", () => {
    const active = fabricCanvas?.getActiveObjects();
    if (active?.length) {
      active.forEach((obj: any) => fabricCanvas.remove(obj));
      fabricCanvas.discardActiveObject();
      fabricCanvas.renderAll();
    }
  });

  // Keyboard delete
  window.addEventListener("keydown", (e) => {
    if (!fabricCanvas || !pdfDoc) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      // Don't delete while editing text
      const active = fabricCanvas.getActiveObject();
      if (active?.isEditing) return;
      const objs = fabricCanvas.getActiveObjects();
      if (objs?.length) {
        e.preventDefault();
        objs.forEach((obj: any) => fabricCanvas.remove(obj));
        fabricCanvas.discardActiveObject();
        fabricCanvas.renderAll();
      }
    }
    // Ctrl+Z / Ctrl+Y
    if (e.ctrlKey && e.key === "z") { e.preventDefault(); undoBtn.click(); }
    if (e.ctrlKey && e.key === "y") { e.preventDefault(); redoBtn.click(); }
  });

  /* ── Tool switching ── */
  const toolBtns = document.querySelectorAll<HTMLButtonElement>(".pde-tool-btn[data-pde-tool]");
  for (const btn of toolBtns) {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.pdeTool as PdeTool;
      activePdeTool = tool;
      toolBtns.forEach(b => b.classList.toggle("active", b === btn));

      // Update properties panel visibility
      updatePropsPanel();

      if (fabricCanvas) {
        if (tool === "draw") {
          // Ensure brush exists before enabling drawing mode
          if (!fabricCanvas.freeDrawingBrush && fabricModule) {
            const PencilBrush = fabricModule.PencilBrush || (fabricModule as any).default?.PencilBrush;
            if (PencilBrush) fabricCanvas.freeDrawingBrush = new PencilBrush(fabricCanvas);
          }
          if (fabricCanvas.freeDrawingBrush) {
            fabricCanvas.freeDrawingBrush.width = parseInt(brushInput.value) || 3;
            fabricCanvas.freeDrawingBrush.color = colorInput.value;
          }
          fabricCanvas.isDrawingMode = true;
        } else {
          fabricCanvas.isDrawingMode = false;
        }
        if (tool === "select") {
          fabricCanvas.selection = true;
        }
        if (tool === "redact") {
          fabricCanvas.defaultCursor = "crosshair";
          fabricCanvas.selection = false;
        } else {
          fabricCanvas.defaultCursor = "default";
        }
      }

      if (tool === "highlight") {
        colorInput.value = "#ffff00";
        colorHex.textContent = "#ffff00";
        opacityInput.value = "20";
        opacityLabel.textContent = "20%";
      }

      if (tool === "image") {
        imgInput.click();
      }
    });
  }

  /* ── Tool options ── */
  colorInput.addEventListener("input", () => {
    colorHex.textContent = colorInput.value;
    if (fabricCanvas?.freeDrawingBrush && fabricCanvas.isDrawingMode) {
      fabricCanvas.freeDrawingBrush.color = colorInput.value;
    }
    const obj = fabricCanvas?.getActiveObject();
    if (!obj) return;
    if (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text") {
      obj.set("fill", colorInput.value);
      syncActiveTextEdit();
      fabricCanvas.renderAll();
    } else if (obj.type === "rect") {
      obj.set("fill", colorInput.value);
      fabricCanvas.renderAll();
    }
  });

  brushInput.addEventListener("input", () => {
    brushLabel.textContent = `${brushInput.value}px`;
    if (fabricCanvas?.freeDrawingBrush && fabricCanvas.isDrawingMode) {
      fabricCanvas.freeDrawingBrush.width = parseInt(brushInput.value) || 3;
    }
  });

  // Font family change is handled by the font picker selectFont() function

  // Font size
  fontInput.addEventListener("input", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("fontSize", parseInt(fontInput.value) || 16);
      syncActiveTextEdit();
      fabricCanvas.renderAll();
    }
  });

  // Bold
  boldBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      const isBold = obj.fontWeight === "bold";
      obj.set("fontWeight", isBold ? "normal" : "bold");
      boldBtn.classList.toggle("active", !isBold);
      syncActiveTextEdit();
      fabricCanvas.renderAll();
    }
  });

  // Italic
  italicBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      const isItalic = obj.fontStyle === "italic";
      obj.set("fontStyle", isItalic ? "normal" : "italic");
      italicBtn.classList.toggle("active", !isItalic);
      syncActiveTextEdit();
      fabricCanvas.renderAll();
    }
  });

  // Underline
  underlineBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("underline", !obj.underline);
      underlineBtn.classList.toggle("active", !!obj.underline);
      fabricCanvas.renderAll();
    }
  });

  // Strikethrough
  strikeBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("linethrough", !obj.linethrough);
      strikeBtn.classList.toggle("active", !!obj.linethrough);
      fabricCanvas.renderAll();
    }
  });

  // Bullet toggle
  bulletBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      // Toggle bullets on existing selected text
      if (bulletedObjects.has(obj)) {
        // Remove bullets
        bulletedObjects.delete(obj);
        const lines = (obj.text as string).split("\n");
        const cleaned = lines.map((l: string) => l.startsWith("• ") ? l.slice(2) : l === "•" ? "" : l);
        obj.set("text", cleaned.join("\n"));
        bulletBtn.classList.remove("active");
      } else {
        // Add bullets
        bulletedObjects.add(obj);
        const lines = (obj.text as string).split("\n");
        const bulleted = lines.map((l: string) => l.startsWith("• ") ? l : "• " + l);
        obj.set("text", bulleted.join("\n"));
        bulletBtn.classList.add("active");
      }
      fabricCanvas.renderAll();
    } else {
      // No text selected — toggle bullet mode for next new text
      bulletModeActive = !bulletModeActive;
      bulletBtn.classList.toggle("active", bulletModeActive);
    }
  });

  // Alignment
  for (const btn of alignBtns) {
    btn.addEventListener("click", () => {
      const obj = fabricCanvas?.getActiveObject();
      if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
        obj.set("textAlign", btn.dataset.pdeAlign!);
        alignBtns.forEach(b => b.classList.toggle("active", b === btn));
        fabricCanvas.renderAll();
      }
    });
  }

  // Match surrounding text
  matchTextBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (!obj || (obj.type !== "i-text" && obj.type !== "textbox" && obj.type !== "text")) return;

    // Use the object's position to find the nearest PDF text
    const detected = detectNearestFont(obj.left ?? 0, obj.top ?? 0);
    if (!detected) return;

    obj.set("fontFamily", detected.fontFamily);
    obj.set("fontSize", detected.fontSize);
    obj.set("fill", detected.color);
    obj.set("fontWeight", detected.bold ? "bold" : "normal");
    obj.set("fontStyle", detected.italic ? "italic" : "normal");

    // Load the detected font from Fontsource if available
    tryLoadFont(detected.fontFamily);

    // Update UI controls
    currentFontFamily = detected.fontFamily;
    fontSearchInput.value = detected.fontFamily;
    fontInput.value = String(Math.round(detected.fontSize));
    colorInput.value = detected.color;
    colorHex.textContent = detected.color;
    boldBtn.classList.toggle("active", detected.bold);
    italicBtn.classList.toggle("active", detected.italic);

    fabricCanvas.renderAll();
  });

  // Change Document Font — enters picker mode
  changeDocFontBtn.addEventListener("click", async () => {
    docFontPickerMode = !docFontPickerMode;
    changeDocFontBtn.classList.toggle("active", docFontPickerMode);
    if (docFontPickerMode) {
      // Open font picker
      await fetchFontsourceList();
      fontSearchInput.value = "";
      renderFontList("");
      fontListEl.classList.add("open");
      fontSearchInput.focus();
    } else {
      fontListEl.classList.remove("open");
    }
  });

  // Redact color
  redactColorInput.addEventListener("input", () => {
    redactColorHex.textContent = redactColorInput.value;
    const obj = fabricCanvas?.getActiveObject();
    if (obj && obj._pdeRedact) {
      obj.set("fill", redactColorInput.value);
      fabricCanvas.renderAll();
    }
  });

  // Opacity
  opacityInput.addEventListener("input", () => {
    opacityLabel.textContent = `${opacityInput.value}%`;
    const obj = fabricCanvas?.getActiveObject();
    if (obj) {
      obj.set("opacity", parseInt(opacityInput.value) / 100);
      fabricCanvas.renderAll();
    }
  });

  /* ── Page navigation ── */
  prevBtn.addEventListener("click", () => {
    if (currentPage > 1) { saveCurrentAnnotations(); currentPage--; renderPage(); }
  });
  nextBtn.addEventListener("click", () => {
    if (currentPage < totalPages) { saveCurrentAnnotations(); currentPage++; renderPage(); }
  });

  /* ── Zoom ── */
  zoomInBtn.addEventListener("click", () => {
    zoom = Math.min(3, zoom + 0.25);
    saveCurrentAnnotations();
    renderPage();
  });
  zoomOutBtn.addEventListener("click", () => {
    zoom = Math.max(0.25, zoom - 0.25);
    saveCurrentAnnotations();
    renderPage();
  });

  /* ── Capture annotation overlay as PNG for a given page ── */
  // For redacted pages: flattens bg + redaction rects into one image (destroys text).
  // For other annotated pages: captures transparent fabric overlay only.
  async function capturePageAnnotations(): Promise<{ overlays: Map<number, string>; flatRedacted: Map<number, string> }> {
    const overlays = new Map<number, string>();
    const flatRedacted = new Map<number, string>();
    const origPage = currentPage;
    saveCurrentAnnotations();

    for (let idx = 0; idx < pageOrder.length; idx++) {
      const entry = pageOrder[idx];
      const pageId = entry.id;
      const hasRedactRects = pagesWithRedactions.has(pageId);
      const annotJson = pageAnnotations.get(pageId);
      const parsed = annotJson ? JSON.parse(annotJson) : { objects: [] };

      // For primary pages, OCR-based edit objects count as visible
      const ppn = entry.source === "primary" ? entry.primaryPageNum! : null;
      const ocrEditIds = ppn !== null
        ? new Set((pageTextEdits.get(ppn) || []).filter(e => e.ocrBased).map(e => e.id))
        : new Set<string>();
      const hasNonEditObjects = parsed.objects?.some((o: any) => !o._pdeTextEditId || ocrEditIds.has(o._pdeTextEditId));

      if (!hasRedactRects && !hasNonEditObjects) continue;

      // Navigate to this page position to load annotations
      currentPage = idx + 1;
      await renderPage();

      if (hasRedactRects) {
        const flatCanvas = document.createElement("canvas");
        flatCanvas.width = bgCanvas.width;
        flatCanvas.height = bgCanvas.height;
        const flatCtx = flatCanvas.getContext("2d")!;
        flatCtx.drawImage(bgCanvas, 0, 0);

        const hiddenObjs: any[] = [];
        for (const obj of fabricCanvas.getObjects()) {
          if (obj._pdeTextEditId && !ocrEditIds.has(obj._pdeTextEditId)) {
            obj.set("visible", false);
            hiddenObjs.push(obj);
          }
        }
        fabricCanvas.renderAll();
        const fabricEl = fabricCanvas.getElement();
        flatCtx.drawImage(fabricEl, 0, 0, flatCanvas.width, flatCanvas.height);
        for (const obj of hiddenObjs) obj.set("visible", true);
        fabricCanvas.renderAll();

        flatRedacted.set(pageId, flatCanvas.toDataURL("image/png"));
      } else if (hasNonEditObjects) {
        const hiddenObjs: any[] = [];
        for (const obj of fabricCanvas.getObjects()) {
          if (obj._pdeTextEditId && !ocrEditIds.has(obj._pdeTextEditId)) {
            obj.set("visible", false);
            hiddenObjs.push(obj);
          }
        }
        fabricCanvas.renderAll();
        const dataUrl = fabricCanvas.toDataURL({ format: "png", multiplier: 1 });
        overlays.set(pageId, dataUrl);
        for (const obj of hiddenObjs) obj.set("visible", true);
        fabricCanvas.renderAll();
      }
    }

    // Restore original page
    currentPage = origPage;
    await renderPage();
    return { overlays, flatRedacted };
  }

  /* ── Font mapping for pdf-lib export ── */
  function mapToStandardFont(family: string, bold: boolean, italic: boolean): string {
    const lower = family.toLowerCase();
    let base: string;
    if (lower.includes("courier") || lower.includes("consolas") || lower.includes("mono")) {
      base = "Courier";
    } else if (lower.includes("times") || lower.includes("georgia") || lower.includes("serif") ||
               lower.includes("palatino") || lower.includes("garamond") || lower.includes("cambria") ||
               lower.includes("book")) {
      base = "TimesRoman";
    } else {
      base = "Helvetica";
    }

    if (base === "Courier") {
      if (bold && italic) return "CourierBoldOblique";
      if (bold) return "CourierBold";
      if (italic) return "CourierOblique";
      return "Courier";
    }
    if (base === "TimesRoman") {
      if (bold && italic) return "TimesRomanBoldItalic";
      if (bold) return "TimesRomanBold";
      if (italic) return "TimesRomanItalic";
      return "TimesRoman";
    }
    // Helvetica
    if (bold && italic) return "HelveticaBoldOblique";
    if (bold) return "HelveticaBold";
    if (italic) return "HelveticaOblique";
    return "Helvetica";
  }

  /* ── Collect redaction regions and find text items underneath ── */
  function collectRedactionEdits(pageNum: number): { pdfX: number; pdfY: number; tolerance: number; delete: boolean }[] {
    const annotJson = pageAnnotations.get(pageNum);
    if (!annotJson) return [];
    const parsed = JSON.parse(annotJson);
    if (!parsed.objects) return [];

    const textContent = pageTextContent.get(pageNum);
    if (!textContent || !textContent._vpTransform) return [];

    const scale = zoom * 1.5;
    const vt = textContent._vpTransform;
    const edits: { pdfX: number; pdfY: number; tolerance: number; delete: boolean }[] = [];

    // Get redaction rectangles from the fabric JSON
    const redactRects = parsed.objects.filter((o: any) => o._pdeRedact);
    if (redactRects.length === 0) return [];

    // For each text item, check if it falls within any redaction rectangle
    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      // Convert PDF coords to canvas coords
      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;

      for (const rect of redactRects) {
        const rl = rect.left ?? 0;
        const rt = rect.top ?? 0;
        const rw = (rect.width ?? 0) * (rect.scaleX ?? 1);
        const rh = (rect.height ?? 0) * (rect.scaleY ?? 1);

        if (cx >= rl - 2 && cx <= rl + rw + 2 && cy >= rt - 2 && cy <= rt + rh + 2) {
          edits.push({ pdfX, pdfY, tolerance: 5.0, delete: true });
          break; // text item matched one rect, no need to check others
        }
      }
    }

    return edits;
  }

  /* ── Apply text edits and redactions to PDF content streams ── */
  async function applyTextEdits(outPdf: any, pdfLibModule: any, hasRedactions: boolean) {
    const { PDFName, PDFArray, PDFRawStream } = pdfLibModule;
    const { removeTextFromStream } = await import("./pdf-content-stream");
    const pako = await import("pako");

    const pages = outPdf.getPages();

    // Collect all pages that need content stream edits (text edits + redactions)
    const primaryPageCount = pdfDoc.numPages;
    const pagesToProcess = new Set<number>();
    for (const [pageNum] of pageTextEdits) pagesToProcess.add(pageNum);
    if (hasRedactions) {
      for (let p = 1; p <= primaryPageCount; p++) pagesToProcess.add(p);
    }

    // If document font override is active, process ALL primary pages
    if (documentFontOverride) {
      for (let p = 1; p <= primaryPageCount; p++) pagesToProcess.add(p);

      // Create TextEdits for unvisited pages on-the-fly
      for (let p = 1; p <= primaryPageCount; p++) {
        if (docFontAppliedPages.has(p)) continue;
        // Load text content for this page if not cached
        if (!pageTextContent.has(p)) {
          try {
            const pg = await pdfDoc.getPage(p);
            const tc = await pg.getTextContent();
            const hasText = tc.items?.some((it: any) => it.str && it.str.trim());
            if (hasText) {
              const rawVp = pg.getViewport({ scale: 1 });
              tc._vpTransform = rawVp.transform;
              pageTextContent.set(p, tc);
            }
          } catch { /* skip */ }
        }
        if (pageTextContent.has(p)) {
          // Create edits without fabric objects (pageNum !== currentPage)
          createTextEditsForEntirePage(p, documentFontOverride.family);
        }
      }
    }

    for (const pageNum of pagesToProcess) {
      const pageIdx = pageNum - 1;
      if (pageIdx < 0 || pageIdx >= pages.length) continue;
      const page = pages[pageIdx];

      // Collect text edit deletions (skip OCR-based — no content stream text to remove)
      const textEdits = pageTextEdits.get(pageNum) || [];
      const deleteEdits = textEdits
        .filter(e => !e.ocrBased && (e.deleted || e.newStr !== e.originalStr || (e.originalFamily && e.detectedFamily !== e.originalFamily)))
        .map(e => ({ pdfX: e.pdfX, pdfY: e.pdfY, tolerance: 2.0, delete: true }));

      // Collect redaction region deletions
      const redactEdits = hasRedactions ? collectRedactionEdits(pageNum) : [];
      const allEdits = [...deleteEdits, ...redactEdits];
      if (allEdits.length > 0) {
        try {
          const pageNode = page.node;
          let contentsRef = pageNode.get(PDFName.of("Contents"));

          // Dereference if it's an indirect reference to an array
          if (contentsRef && !(contentsRef instanceof PDFArray) && typeof contentsRef === "object" && "objectNumber" in contentsRef) {
            const deref = outPdf.context.lookup(contentsRef);
            if (deref instanceof PDFArray) contentsRef = deref;
          }

          if (contentsRef) {
            const streamRefs: any[] = [];
            if (contentsRef instanceof PDFArray) {
              for (let i = 0; i < contentsRef.size(); i++) {
                streamRefs.push(contentsRef.get(i));
              }
            } else {
              streamRefs.push(contentsRef);
            }
            for (const ref of streamRefs) {
              const streamObj = outPdf.context.lookup(ref);
              if (!streamObj) continue;

              let streamBytes: Uint8Array;
              try {
                if (typeof streamObj.getContents === "function") {
                  streamBytes = streamObj.getContents();
                } else if (streamObj.contents) {
                  streamBytes = streamObj.contents;
                } else {
                  continue;
                }
              } catch {
                continue;
              }

              let streamText: string;
              let wasCompressed = false;
              try {
                const inflated = pako.inflate(streamBytes);
                streamText = new TextDecoder("latin1").decode(inflated);
                wasCompressed = true;
              } catch {
                streamText = new TextDecoder("latin1").decode(streamBytes);
              }

              const modified = removeTextFromStream(streamText, allEdits);
              if (modified === streamText) continue;

              const modifiedBytes = new Uint8Array(Array.from(modified, c => c.charCodeAt(0)));
              let finalBytes: Uint8Array;
              if (wasCompressed) {
                finalBytes = pako.deflate(modifiedBytes);
              } else {
                finalBytes = modifiedBytes;
              }

              const dict = streamObj.dict;
              dict.set(PDFName.of("Length"), outPdf.context.obj(finalBytes.length));
              if (wasCompressed) {
                dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
              } else {
                dict.delete(PDFName.of("Filter"));
              }
              const newStream = PDFRawStream.of(dict, finalBytes);
              outPdf.context.assign(ref, newStream);
            }
          }
        } catch (err) {
          console.warn(`[PDF Editor] Content stream edit failed for page ${pageNum}, using overlay fallback:`, err);
        }
      }

      // Draw replacement text for text edits that changed (not just deleted)
      const { StandardFonts } = pdfLibModule;
      const { rgb } = pdfLibModule;

      for (const edit of textEdits) {
        if (edit.ocrBased) continue; // OCR edits rendered via overlay, not content stream
        if (edit.deleted) continue;
        const fontChanged = edit.originalFamily && edit.detectedFamily !== edit.originalFamily;
        if (edit.newStr === edit.originalStr && !fontChanged) continue;
        if (!edit.newStr) continue;

        try {
          const fontKey = mapToStandardFont(edit.detectedFamily, edit.bold, edit.italic);
          const font = await outPdf.embedFont(StandardFonts[fontKey] || StandardFonts.Helvetica);

          let r = 0, g = 0, b = 0;
          if (edit.color.startsWith("#") && edit.color.length === 7) {
            r = parseInt(edit.color.slice(1, 3), 16) / 255;
            g = parseInt(edit.color.slice(3, 5), 16) / 255;
            b = parseInt(edit.color.slice(5, 7), 16) / 255;
          }

          page.drawText(edit.newStr, {
            x: edit.pdfX,
            y: edit.pdfY,
            size: edit.fontSizePt,
            font,
            color: rgb(r, g, b),
          });
        } catch (err) {
          console.warn(`[PDF Editor] Failed to draw replacement text for "${edit.newStr}":`, err);
        }
      }
    }
  }

  /* ── Download annotated PDF ── */
  /** Check if pageOrder differs from the default primary-only sequence */
  function isPageOrderChanged(): boolean {
    if (pageOrder.length !== pdfDoc.numPages) return true;
    for (let i = 0; i < pageOrder.length; i++) {
      const e = pageOrder[i];
      if (e.source !== "primary" || e.primaryPageNum !== i + 1) return true;
    }
    return false;
  }

  downloadBtn.addEventListener("click", async () => {
    if (!pdfBytes || !pdfDoc) return;
    downloadBtn.classList.add("disabled");
    const dlLabel = downloadBtn.querySelector("span");
    if (dlLabel) dlLabel.textContent = "Exporting...";

    try {
      saveCurrentAnnotations();

      // Check if there are any text edits or redactions
      let hasTextEdits = false;
      for (const [, edits] of pageTextEdits) {
        if (edits.some(e => e.deleted || e.newStr !== e.originalStr || (e.originalFamily && e.detectedFamily !== e.originalFamily))) {
          hasTextEdits = true;
          break;
        }
      }

      const hasRedactions = pagesWithRedactions.size > 0;
      const hasMergePages = pageOrder.some(e => e.source === "merge");
      const orderChanged = isPageOrderChanged();

      // Capture all annotated pages as PNGs (excluding text-edit objects)
      const { overlays, flatRedacted } = await capturePageAnnotations();

      if (overlays.size === 0 && flatRedacted.size === 0 && !hasTextEdits && !hasMergePages && !orderChanged) {
        // No annotations, text edits, redactions, or reordering — just download the original
        const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = pdfFileName.replace(/\.pdf$/i, "") + "-edited.pdf";
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      }

      const pdfLibModule = await import("pdf-lib");
      const { PDFDocument, PDFName } = pdfLibModule;
      const outPdf = await PDFDocument.load(pdfBytes);

      // Apply text edits to content streams (non-redaction edits only)
      if (hasTextEdits) {
        await applyTextEdits(outPdf, pdfLibModule, false);
      }

      // For redacted primary pages: replace entire page content with flat image
      // (Primary page ids equal their 1-indexed page numbers)
      for (const [pageId, dataUrl] of flatRedacted) {
        if (pageId >= 100000) continue; // merge page — handled later
        const pngBytes = Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0));
        const pngImage = await outPdf.embedPng(pngBytes);

        const pdfPage = outPdf.getPages()[pageId - 1];
        const { width, height } = pdfPage.getSize();

        const pageNode = pdfPage.node;
        pageNode.set(PDFName.of("Contents"), outPdf.context.obj([]));
        pageNode.delete(PDFName.of("Annots"));
        pdfPage.drawImage(pngImage, { x: 0, y: 0, width, height });
      }

      // Strip all PDF metadata when redactions are present
      const hasAnyRedactions = [...pagesWithRedactions].some(id => id < 100000);
      if (hasAnyRedactions) {
        outPdf.setTitle("");
        outPdf.setSubject("");
        outPdf.setAuthor("");
        outPdf.setKeywords([]);
        outPdf.setCreator("");
        outPdf.setProducer("");
        try {
          const catalog = outPdf.context.lookup(outPdf.context.trailerInfo.Root) as any;
          if (catalog?.delete) catalog.delete(PDFName.of("Metadata"));
        } catch { /* non-critical */ }
      }

      // Composite PNG overlays for non-redacted annotated primary pages
      for (const [pageId, dataUrl] of overlays) {
        if (pageId >= 100000) continue; // merge page — handled later
        const pngBytes = Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0));
        const pngImage = await outPdf.embedPng(pngBytes);

        const pdfPage = outPdf.getPages()[pageId - 1];
        const { width, height } = pdfPage.getSize();
        pdfPage.drawImage(pngImage, { x: 0, y: 0, width, height });
      }

      const editedPrimaryBytes: Uint8Array = await outPdf.save();

      // Build final PDF following pageOrder
      if (hasMergePages || orderChanged) {
        const finalDoc = await PDFDocument.create();
        const editedPrimary = await PDFDocument.load(editedPrimaryBytes);

        // Pre-load merge file PDFDocuments for pdf-lib
        const mergeLibDocs: any[] = [];
        for (const mf of pdfMergeFiles) {
          mergeLibDocs.push(await PDFDocument.load(mf.bytes));
        }

        for (const entry of pageOrder) {
          if (entry.source === "primary") {
            const [copied] = await finalDoc.copyPages(editedPrimary, [entry.primaryPageNum! - 1]);
            finalDoc.addPage(copied);
          } else {
            try {
              const mDoc = mergeLibDocs[entry.mergeFileIndex!];
              const [copied] = await finalDoc.copyPages(mDoc, [entry.mergePageNum! - 1]);
              finalDoc.addPage(copied);

              // Apply annotations/redactions to this merge page
              const mergeOverlay = overlays.get(entry.id);
              const mergeFlat = flatRedacted.get(entry.id);
              if (mergeFlat || mergeOverlay) {
                const pageIdx = finalDoc.getPageCount() - 1;
                const page = finalDoc.getPages()[pageIdx];
                const { width, height } = page.getSize();
                const dataUrl = mergeFlat || mergeOverlay!;
                const pngBytes = Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0));
                const pngImage = await finalDoc.embedPng(pngBytes);

                if (mergeFlat) {
                  // Redacted: wipe content and replace with flat image
                  const pageNode = page.node;
                  pageNode.set(PDFName.of("Contents"), finalDoc.context.obj([]));
                  pageNode.delete(PDFName.of("Annots"));
                }
                page.drawImage(pngImage, { x: 0, y: 0, width, height });
              }
            } catch (err) {
              console.warn(`[PDF Editor] Failed to copy merge page:`, err);
            }
          }
        }

        const finalOutput = await finalDoc.save();
        const blob = new Blob([finalOutput.buffer as ArrayBuffer], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = pdfFileName.replace(/\.pdf$/i, "") + "-edited.pdf";
        a.click();
        URL.revokeObjectURL(a.href);
      } else {
        const blob = new Blob([editedPrimaryBytes.buffer as ArrayBuffer], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = pdfFileName.replace(/\.pdf$/i, "") + "-edited.pdf";
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (err: any) {
      console.error("[PDF Editor] Export error:", err);
      alert(`Export failed: ${err?.message || "Unknown error"}`);
    } finally {
      downloadBtn.classList.remove("disabled");
      const dlLabel = downloadBtn.querySelector("span");
      if (dlLabel) dlLabel.textContent = "Download";
    }
  });
}
