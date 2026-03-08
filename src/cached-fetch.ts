/**
 * Cache API wrapper for WASM and large binary assets.
 * Controlled by a user preference — on first visit a prompt asks whether to
 * keep models cached locally.  The choice is stored in localStorage.
 *
 * Key: "convert-cache-models"  →  "yes" | "no"
 *
 * Caches managed:
 *   - "convert-assets-v1"   — our WASM / binary asset cache
 *   - "transformers-cache"  — @huggingface/transformers (Whisper, Kokoro, BART)
 */

const CACHE_NAME = "convert-assets-v1";
const HF_CACHE_NAME = "transformers-cache";
const LS_KEY = "convert-cache-models";

/** Read the user's caching preference (null = not yet decided). */
function getCachePref(): "yes" | "no" | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "yes" || v === "no") return v;
  } catch {}
  return null;
}

export { getCachePref };

/**
 * Fetch with optional Cache API persistence.
 * If the user opted in → check cache first, store on miss.
 * If the user opted out (or hasn't decided yet) → plain fetch.
 */
export async function cachedFetch(url: string): Promise<Response> {
  if (getCachePref() !== "yes") return fetch(url);
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      console.log(`[Cache] Hit: ${url}`);
      return cached;
    }
    const response = await fetch(url);
    if (response.ok) {
      await cache.put(url, response.clone());
      console.log(`[Cache] Stored: ${url}`);
    }
    return response;
  } catch {
    return fetch(url);
  }
}

/**
 * Request persistent storage so the browser won't evict cached models/WASM.
 * Only meaningful when caching is enabled.
 */
export async function requestPersistentStorage(): Promise<void> {
  if (getCachePref() !== "yes") return;
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted();
      if (!persisted) {
        const granted = await navigator.storage.persist();
        console.log(`[Cache] Persistent storage ${granted ? "granted" : "denied"}`);
      }
    }
  } catch {}
}

/**
 * Delete all cached assets — our WASM cache AND the HuggingFace transformers
 * model cache (Whisper, Kokoro TTS, BART summarizer).
 */
export async function clearModelCache(): Promise<void> {
  try { await caches.delete(CACHE_NAME); } catch {}
  try { await caches.delete(HF_CACHE_NAME); } catch {}
  console.log("[Cache] Cleared all model caches");
}

/**
 * Get cache statistics: total size in bytes and number of cached entries.
 */
export async function getCacheStats(): Promise<{ totalSize: number; fileCount: number }> {
  let totalSize = 0;
  let fileCount = 0;
  try {
    for (const name of [CACHE_NAME, HF_CACHE_NAME]) {
      const exists = await caches.has(name);
      if (!exists) continue;
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) {
        fileCount++;
        try {
          const resp = await cache.match(req);
          if (resp) {
            const blob = await resp.blob();
            totalSize += blob.size;
          }
        } catch {}
      }
    }
  } catch {}
  return { totalSize, fileCount };
}

/**
 * Clear all site data: caches, localStorage, sessionStorage, then reload.
 */
export async function clearAllSiteData(): Promise<void> {
  try { await caches.delete(CACHE_NAME); } catch {}
  try { await caches.delete(HF_CACHE_NAME); } catch {}
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  location.reload();
}

/**
 * Tell @huggingface/transformers whether to use its browser cache.
 * Called early — before any pipeline is created.
 */
export async function applyHfCachePolicy(): Promise<void> {
  const enabled = getCachePref() === "yes";
  try {
    const { env } = await import("@huggingface/transformers");
    env.useBrowserCache = enabled;
    console.log(`[Cache] HuggingFace browser cache ${enabled ? "enabled" : "disabled"}`);
  } catch {}
}

/**
 * Show the first-visit caching prompt as its own overlay (independent of the
 * shared #popup element so it won't be clobbered by the format-loading flow).
 */
export function showCachePrompt(): void {
  const pref = getCachePref();
  if (pref !== null) return; // already decided

  // Backdrop
  const bg = document.createElement("div");
  bg.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:300;";

  // Dialog box — mirrors #popup styling
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);" +
    "min-width:320px;max-width:90vw;max-height:85vh;overflow-y:auto;" +
    "background:var(--card-bg);border:1px solid var(--input-border);" +
    "padding:24px;border-radius:var(--radius);text-align:center;" +
    "box-shadow:var(--shadow-md);z-index:301;color:var(--text-main);";

  box.innerHTML = `
    <h2 style="margin-top:0;font-size:1.1rem;">Cache AI Models Locally?</h2>
    <p style="font-size:0.9rem;color:var(--text-muted);margin:8px 0 4px;text-align:left;">
      This site uses AI models and libraries (text-to-speech, speech-to-text,
      summarization, OCR, etc.) that can be <strong>75 MB &ndash; 1.5 GB</strong> each.
    </p>
    <p style="font-size:0.9rem;color:var(--text-muted);margin:4px 0 16px;text-align:left;">
      If you choose <strong>Yes</strong>, downloaded models are saved in your
      <strong>browser&rsquo;s Cache Storage</strong> so they load instantly on
      future visits instead of re-downloading every time.
      <br><br>
      You can toggle this off at any time in <strong>Settings &rarr; General</strong>
      to delete the cache and free up space.
    </p>
    <div style="display:flex;gap:10px;justify-content:center;">
      <button id="cache-prompt-yes"
        style="flex:1;max-width:160px;font-size:0.9rem;padding:8px 24px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:white;cursor:pointer;">
        Yes, cache locally
      </button>
      <button id="cache-prompt-no"
        style="flex:1;max-width:160px;font-size:0.9rem;padding:8px 24px;border:1px solid var(--input-border);border-radius:var(--radius-sm);background:var(--surface-color);color:var(--text-main);cursor:pointer;">
        No thanks
      </button>
    </div>
  `;

  document.body.appendChild(bg);
  document.body.appendChild(box);

  function dismiss() {
    bg.remove();
    box.remove();
  }

  box.querySelector("#cache-prompt-yes")!.addEventListener("click", () => {
    try { localStorage.setItem(LS_KEY, "yes"); } catch {}
    dismiss();
    requestPersistentStorage();
    applyHfCachePolicy();
  });

  box.querySelector("#cache-prompt-no")!.addEventListener("click", () => {
    try { localStorage.setItem(LS_KEY, "no"); } catch {}
    dismiss();
    applyHfCachePolicy();
  });
}
