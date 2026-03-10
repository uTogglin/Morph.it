// ── FontPicker.ts ─────────────────────────────────────────────────────────────
// Fontsource font discovery and loading utilities.
// Extracted and generalized from the pattern in pdf-editor-tool.ts lines 201–244.

export interface FontEntry {
  id: string;
  family: string;
  category: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const FONTSOURCE_API = 'https://api.fontsource.org/v1/fonts?subsets=latin';

export const FONTSOURCE_CDN = (id: string, weight: number, style: string): string =>
  `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${weight}-${style}.woff2`;

// ── Module-level cache ────────────────────────────────────────────────────────

/**
 * Tracks which font+weight+style combinations have already been loaded.
 * Key format: "family:weight:style" — e.g. "Inter:700:italic"
 */
export const loadedFonts: Set<string> = new Set();

/** Cache for the full Fontsource font list so we only fetch it once per session. */
let _fontListCache: FontEntry[] | null = null;

// ── fetchFontsourceList ───────────────────────────────────────────────────────

/**
 * Fetch the list of all Fontsource fonts available with the latin subset.
 * Result is cached in memory — subsequent calls return the same array without network I/O.
 */
export async function fetchFontsourceList(): Promise<FontEntry[]> {
  if (_fontListCache !== null) return _fontListCache;
  const resp = await fetch(FONTSOURCE_API);
  const data: any[] = await resp.json();
  _fontListCache = data.map(f => ({
    id: f.id,
    family: f.family,
    category: f.category || 'sans-serif',
  }));
  return _fontListCache;
}

// ── loadFontsourceFont ────────────────────────────────────────────────────────

/**
 * Load a Fontsource font into the browser's font engine (document.fonts).
 *
 * Skips loading if the family+weight+style combination is already cached.
 * Uses the jsDelivr CDN woff2 URL for the latin subset.
 *
 * @param fontId   Fontsource font ID (e.g. "inter", "open-sans")
 * @param family   CSS font-family name (e.g. "Inter", "Open Sans")
 * @param weight   Font weight (default 400)
 * @param style    Font style — 'normal' | 'italic' (default 'normal')
 */
export async function loadFontsourceFont(
  fontId: string,
  family: string,
  weight = 400,
  style = 'normal',
): Promise<void> {
  const cacheKey = `${family}:${weight}:${style}`;
  if (loadedFonts.has(cacheKey)) return;

  const url = FONTSOURCE_CDN(fontId, weight, style);
  const face = new FontFace(family, `url(${url})`, {
    weight: String(weight),
    style,
  });
  await face.load();
  document.fonts.add(face);
  loadedFonts.add(cacheKey);
}
