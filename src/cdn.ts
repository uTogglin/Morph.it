/**
 * CDN URL map + fallback fetch utility.
 *
 * For each WASM/static asset, 3 mirrors are tried in order:
 *   1. jsDelivr (primary CDN)
 *   2. unpkg or raw.githubusercontent (secondary)
 *   3. Local /wasm/ (emergency fallback)
 *
 * This keeps GitHub Pages bandwidth for just HTML/CSS/JS (~5-8 MB/user)
 * instead of serving ~112 MB of WASM per user.
 */

import { cachedFetch } from "./cached-fetch.ts";

type AssetKey =
  | "ffmpegCore"
  | "magickWasm"
  | "sevenZip"
  | "refloWasm"
  | "fluidsynth"
  | "jsSynthesizer"
  | "pandocWasm"
  | "libopenmptWasm"
  | "libopenmptJs"
  | "soundfont";

const CDN_MAP: Record<AssetKey, string[]> = {
  ffmpegCore: [
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js",
    "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js",
    "/wasm/ffmpeg-core.js",
  ],
  magickWasm: [
    "https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.37/dist/magick.wasm",
    "https://unpkg.com/@imagemagick/magick-wasm@0.0.37/dist/magick.wasm",
    "/wasm/magick.wasm",
  ],
  sevenZip: [
    "https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.wasm",
    "https://unpkg.com/7z-wasm@1.2.0/7zz.wasm",
    "/wasm/7zz.wasm",
  ],
  refloWasm: [
    "https://cdn.jsdelivr.net/npm/@flo-audio/reflo@0.1.2/reflo_bg.wasm",
    "https://unpkg.com/@flo-audio/reflo@0.1.2/reflo_bg.wasm",
    "/wasm/reflo_bg.wasm",
  ],
  fluidsynth: [
    "https://cdn.jsdelivr.net/npm/js-synthesizer@1.11.0/externals/libfluidsynth-2.4.6.js",
    "https://unpkg.com/js-synthesizer@1.11.0/externals/libfluidsynth-2.4.6.js",
    "/wasm/libfluidsynth-2.4.6.js",
  ],
  jsSynthesizer: [
    "https://cdn.jsdelivr.net/npm/js-synthesizer@1.11.0/dist/js-synthesizer.js",
    "https://unpkg.com/js-synthesizer@1.11.0/dist/js-synthesizer.js",
    "/wasm/js-synthesizer.js",
  ],
  pandocWasm: [
    // jsDelivr has a 50 MB file limit for GitHub repos; skip it
    "https://raw.githubusercontent.com/uTogglin/convert.it/master/src/handlers/pandoc/pandoc.wasm",
    "/wasm/pandoc.wasm",
  ],
  libopenmptWasm: [
    "https://cdn.jsdelivr.net/gh/uTogglin/convert.it@master/src/handlers/libopenmpt/libopenmpt.wasm",
    "https://raw.githubusercontent.com/uTogglin/convert.it/master/src/handlers/libopenmpt/libopenmpt.wasm",
    "/wasm/libopenmpt.wasm",
  ],
  libopenmptJs: [
    "https://cdn.jsdelivr.net/gh/uTogglin/convert.it@master/src/handlers/libopenmpt/libopenmpt.js",
    "https://raw.githubusercontent.com/uTogglin/convert.it/master/src/handlers/libopenmpt/libopenmpt.js",
    "/wasm/libopenmpt.js",
  ],
  soundfont: [
    "https://cdn.jsdelivr.net/gh/uTogglin/convert.it@master/src/handlers/midi/TimGM6mb.sf2",
    "https://raw.githubusercontent.com/uTogglin/convert.it/master/src/handlers/midi/TimGM6mb.sf2",
    "/wasm/TimGM6mb.sf2",
  ],
};

/**
 * Fetch an asset, trying each CDN mirror in order.
 * Integrates with the existing cachedFetch() for Cache API persistence.
 */
export async function cdnFetch(key: AssetKey): Promise<Response> {
  const urls = CDN_MAP[key];
  for (let i = 0; i < urls.length; i++) {
    try {
      const response = await cachedFetch(urls[i]);
      if (response.ok) return response;
    } catch {
      // try next mirror
    }
  }
  throw new Error(`All CDN mirrors failed for "${key}"`);
}

/**
 * Resolve the first working URL string for an asset.
 * Useful when a library needs a URL rather than a Response (e.g. FFmpeg coreURL).
 *
 * Tries a HEAD request against each mirror; falls back to local path if all fail.
 */
export async function cdnUrl(key: AssetKey): Promise<string> {
  const urls = CDN_MAP[key];
  for (let i = 0; i < urls.length - 1; i++) {
    try {
      const response = await fetch(urls[i], { method: "HEAD" });
      if (response.ok) return urls[i];
    } catch {
      // try next mirror
    }
  }
  // Always return the local fallback as last resort
  return urls[urls.length - 1];
}

/**
 * Pre-resolved URL cache for synchronous access.
 * Call cdnUrlPreload() during init to warm this map.
 */
const resolvedUrls = new Map<AssetKey, string>();

/**
 * Get a pre-resolved URL synchronously. Returns the cached result
 * from a prior cdnUrl() call, or the local fallback if not yet resolved.
 */
export function cdnUrlSync(key: AssetKey): string {
  return resolvedUrls.get(key) ?? CDN_MAP[key][CDN_MAP[key].length - 1];
}

/**
 * Pre-resolve a URL and cache it for synchronous access via cdnUrlSync().
 */
export async function cdnUrlPreload(key: AssetKey): Promise<string> {
  const url = await cdnUrl(key);
  resolvedUrls.set(key, url);
  return url;
}

/**
 * Load a script tag with CDN fallback.
 * Tries each mirror URL as the script src until one loads successfully.
 */
export async function cdnScript(key: AssetKey): Promise<void> {
  const urls = CDN_MAP[key];
  for (let i = 0; i < urls.length; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = urls[i];
        script.onload = () => resolve();
        script.onerror = () => {
          script.remove();
          reject(new Error(`Failed to load ${urls[i]}`));
        };
        document.head.appendChild(script);
      });
      return; // success
    } catch {
      // try next mirror
    }
  }
  throw new Error(`All CDN mirrors failed for script "${key}"`);
}
