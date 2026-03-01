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
 * Show the first-visit caching prompt using the app's existing popup system.
 */
export function showCachePrompt(): void {
  const pref = getCachePref();
  if (pref !== null) return; // already decided

  const html = `
    <h2>Cache AI Models Locally?</h2>
    <p style="font-size:0.9rem;color:var(--text-muted);margin:8px 0 4px;text-align:left;">
      This site uses AI models and libraries (text-to-speech, speech-to-text,
      summarization, OCR, etc.) that can be <strong>75 MB &ndash; 1.5 GB</strong> each.
    </p>
    <p style="font-size:0.9rem;color:var(--text-muted);margin:4px 0 16px;text-align:left;">
      If you choose <strong>Yes</strong>, downloaded models are saved in your
      <strong>browser&rsquo;s Cache Storage</strong> so they load instantly on
      future visits instead of re-downloading every time.
      <br><br>
      You can change this later in <strong>Settings &rarr; General</strong>.
    </p>
    <div style="display:flex;gap:10px;justify-content:center;">
      <button id="cache-prompt-yes" style="flex:1;max-width:160px;">Yes, cache locally</button>
      <button id="cache-prompt-no"
        style="flex:1;max-width:160px;background:var(--surface-color);color:var(--text-main);border:1px solid var(--input-border);">
        No thanks
      </button>
    </div>
  `;

  (window as any).showPopup(html);

  const attach = () => {
    const yesBtn = document.getElementById("cache-prompt-yes");
    const noBtn = document.getElementById("cache-prompt-no");
    if (!yesBtn || !noBtn) { setTimeout(attach, 50); return; }

    yesBtn.addEventListener("click", () => {
      try { localStorage.setItem(LS_KEY, "yes"); } catch {}
      (window as any).hidePopup();
      requestPersistentStorage();
      applyHfCachePolicy();
    });

    noBtn.addEventListener("click", () => {
      try { localStorage.setItem(LS_KEY, "no"); } catch {}
      (window as any).hidePopup();
      applyHfCachePolicy();
    });
  };
  attach();
}
