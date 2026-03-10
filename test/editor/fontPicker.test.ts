// Unit tests for FontPicker.ts — font discovery and caching logic.
// Bun has no DOM/network — we test exported function existence, URL constants,
// and caching behaviour via module-level mock injection.
// TDD RED phase: all tests fail because src/editor/FontPicker.ts does not exist.

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build the expected jsDelivr CDN URL for a given font/weight/style. */
function expectedCdnUrl(id: string, weight: number, style: string): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${weight}-${style}.woff2`;
}

// ── Import the module under test ───────────────────────────────────────────────
// This import will fail in RED phase (module does not exist).
import {
  fetchFontsourceList,
  loadFontsourceFont,
} from '../../src/editor/FontPicker.ts';

// ── fetchFontsourceList — function existence ──────────────────────────────────

describe('fetchFontsourceList — API contract', () => {
  test('fetchFontsourceList is an async function', () => {
    expect(typeof fetchFontsourceList).toBe('function');
    // calling it returns a Promise (we don't actually await to avoid network)
    const result = fetchFontsourceList();
    expect(result).toBeInstanceOf(Promise);
    // clean up the pending promise to avoid unhandled-rejection noise
    result.catch(() => {});
  });

  test('FontEntry shape: returned promise resolves to an array (mocked fetch)', async () => {
    // Stub global fetch so we can test the mapping logic without network.
    const originalFetch = global.fetch;
    global.fetch = mock(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve([
            { id: 'roboto', family: 'Roboto', category: 'sans-serif' },
            { id: 'lato',   family: 'Lato',   category: 'sans-serif' },
            { id: 'merriweather', family: 'Merriweather' /* no category */ },
          ]),
      } as unknown as Response),
    );

    try {
      const list = await fetchFontsourceList();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(3);
      expect(list[0]).toHaveProperty('id', 'roboto');
      expect(list[0]).toHaveProperty('family', 'Roboto');
      expect(list[0]).toHaveProperty('category');
      // Missing category falls back to 'sans-serif'
      expect(list[2].category).toBe('sans-serif');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ── loadFontsourceFont — function existence ───────────────────────────────────

describe('loadFontsourceFont — function existence', () => {
  test('loadFontsourceFont is an async function', () => {
    expect(typeof loadFontsourceFont).toBe('function');
  });
});

// ── CDN URL construction ──────────────────────────────────────────────────────

describe('loadFontsourceFont — CDN URL construction', () => {
  test('constructs correct CDN URL for weight=700, style=italic', async () => {
    // We intercept FontFace to capture the URL argument instead of making a real network call.
    const capturedUrls: string[] = [];

    // Bun has no FontFace — set up a global mock.
    const originalFontFace = (global as any).FontFace;
    const originalDocumentFonts = (global as any).document;

    (global as any).FontFace = class MockFontFace {
      constructor(_family: string, src: string, _opts: object) {
        // src looks like "url(https://...)" — extract the URL
        const match = src.match(/url\(([^)]+)\)/);
        if (match) capturedUrls.push(match[1]);
      }
      load() { return Promise.resolve(this); }
    };
    (global as any).document = {
      fonts: { add: () => {}, has: () => false },
    };

    try {
      // Use a unique family name so the loadedFonts cache from other tests doesn't interfere.
      await loadFontsourceFont('my-font', 'TestFamily-Bold-Italic', 700, 'italic');
      expect(capturedUrls.length).toBeGreaterThan(0);
      expect(capturedUrls[0]).toBe(expectedCdnUrl('my-font', 700, 'italic'));
    } finally {
      (global as any).FontFace = originalFontFace;
      (global as any).document = originalDocumentFonts;
    }
  });

  test('constructs correct CDN URL for default weight=400, style=normal', async () => {
    const capturedUrls: string[] = [];
    const originalFontFace = (global as any).FontFace;
    const originalDocument = (global as any).document;

    (global as any).FontFace = class MockFontFace {
      constructor(_family: string, src: string, _opts: object) {
        const match = src.match(/url\(([^)]+)\)/);
        if (match) capturedUrls.push(match[1]);
      }
      load() { return Promise.resolve(this); }
    };
    (global as any).document = {
      fonts: { add: () => {}, has: () => false },
    };

    try {
      await loadFontsourceFont('open-sans', 'TestFamily-Normal-Default');
      expect(capturedUrls.length).toBeGreaterThan(0);
      expect(capturedUrls[0]).toBe(expectedCdnUrl('open-sans', 400, 'normal'));
    } finally {
      (global as any).FontFace = originalFontFace;
      (global as any).document = originalDocument;
    }
  });
});

// ── Caching — no duplicate FontFace loads ─────────────────────────────────────

describe('loadFontsourceFont — caching', () => {
  test('calling loadFontsourceFont twice with same family+weight+style only creates one FontFace', async () => {
    let fontFaceCount = 0;
    const originalFontFace = (global as any).FontFace;
    const originalDocument = (global as any).document;

    (global as any).FontFace = class MockFontFace {
      constructor(_family: string, _src: string, _opts: object) {
        fontFaceCount++;
      }
      load() { return Promise.resolve(this); }
    };
    (global as any).document = {
      fonts: { add: () => {}, has: () => false },
    };

    try {
      // Use a unique family name to bypass any cache from previous tests.
      await loadFontsourceFont('inter', 'CacheTestFamily-Unique-A', 400, 'normal');
      await loadFontsourceFont('inter', 'CacheTestFamily-Unique-A', 400, 'normal');
      expect(fontFaceCount).toBe(1);
    } finally {
      (global as any).FontFace = originalFontFace;
      (global as any).document = originalDocument;
    }
  });

  test('different weight+style combinations each create one FontFace', async () => {
    let fontFaceCount = 0;
    const originalFontFace = (global as any).FontFace;
    const originalDocument = (global as any).document;

    (global as any).FontFace = class MockFontFace {
      constructor(_family: string, _src: string, _opts: object) {
        fontFaceCount++;
      }
      load() { return Promise.resolve(this); }
    };
    (global as any).document = {
      fonts: { add: () => {}, has: () => false },
    };

    try {
      await loadFontsourceFont('lato', 'CacheTestFamily-Unique-B', 400, 'normal');
      await loadFontsourceFont('lato', 'CacheTestFamily-Unique-B', 700, 'normal');
      await loadFontsourceFont('lato', 'CacheTestFamily-Unique-B', 400, 'italic');
      // Three distinct weight+style combos → 3 FontFace instances
      expect(fontFaceCount).toBe(3);
    } finally {
      (global as any).FontFace = originalFontFace;
      (global as any).document = originalDocument;
    }
  });
});
