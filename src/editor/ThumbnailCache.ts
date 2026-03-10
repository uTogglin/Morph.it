// ── ThumbnailCache ─────────────────────────────────────────────────────────────
// Lazily extracts a representative still frame from each video clip and caches
// it as an ImageBitmap for efficient repeated drawing in the timeline.
//
// Usage (from TimelineRenderer):
//   const cache = new ThumbnailCache();
//   // In drawClip():
//   const thumb = cache.getThumbnail(clip.id);
//   if (thumb) { /* draw */ }
//   else cache.request(clip.id, clip.sourceFile, redrawCallback);

/** Thumbnail dimensions (16:9 strip, fits nicely into a 60 px tall track). */
const THUMB_W = 160;
const THUMB_H = 90;

type ThumbState =
  | { status: 'pending' }
  | { status: 'ready'; bitmap: ImageBitmap }
  | { status: 'error' };

export class ThumbnailCache {
  private _cache = new Map<string, ThumbState>();

  /** Return the cached ImageBitmap, or null if not yet ready. */
  getThumbnail(clipId: string): ImageBitmap | null {
    const entry = this._cache.get(clipId);
    return entry?.status === 'ready' ? entry.bitmap : null;
  }

  /**
   * Start async thumbnail extraction if not already started.
   * `onReady` is called once the bitmap is available — use to trigger a redraw.
   */
  request(clipId: string, file: File, onReady: () => void): void {
    if (this._cache.has(clipId)) return;
    this._cache.set(clipId, { status: 'pending' });

    this._extract(file)
      .then(bitmap => {
        this._cache.set(clipId, { status: 'ready', bitmap });
        onReady();
      })
      .catch(() => {
        this._cache.set(clipId, { status: 'error' });
      });
  }

  /** Remove and close a cached thumbnail (e.g. when clip is deleted). */
  evict(clipId: string): void {
    const entry = this._cache.get(clipId);
    if (entry?.status === 'ready') entry.bitmap.close();
    this._cache.delete(clipId);
  }

  /** Clear all cached thumbnails. */
  clear(): void {
    for (const entry of this._cache.values()) {
      if (entry.status === 'ready') entry.bitmap.close();
    }
    this._cache.clear();
  }

  // ── Private: seek to a representative frame and capture ──────────────────────

  private _extract(file: File): Promise<ImageBitmap> {
    return new Promise<ImageBitmap>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v   = document.createElement('video');
      v.muted    = true;
      v.preload  = 'auto';
      v.playsInline = true;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        v.src = '';
        v.load();
      };

      v.onerror = () => { cleanup(); reject(new Error('ThumbnailCache: video load error')); };

      v.onloadedmetadata = () => {
        // Seek to 10 % of the clip, or 3 s, whichever is smaller, but at least 0
        v.currentTime = Math.max(0, Math.min(v.duration * 0.1, v.duration - 0.05, 3));
      };

      v.onseeked = () => {
        // Use rAF so the browser has a chance to paint the seeked frame before
        // we capture it — avoids blank frames on some Chromium builds.
        requestAnimationFrame(() => {
          try {
            const offscreen = new OffscreenCanvas(THUMB_W, THUMB_H);
            const ctx       = offscreen.getContext('2d')!;
            ctx.drawImage(v, 0, 0, THUMB_W, THUMB_H);
            cleanup();
            createImageBitmap(offscreen).then(resolve).catch(reject);
          } catch (e) {
            cleanup();
            reject(e);
          }
        });
      };

      v.src = url;
    });
  }
}
