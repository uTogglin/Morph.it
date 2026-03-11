// ── TextRenderer ───────────────────────────────────────────────────────────────
// Renders TextClip content to an ImageBitmap using OffscreenCanvas + Canvas2D.
// Used by PlaybackEngine to composite text overlays on top of video frames.

import type { TextClip } from './TextClip.ts';
import { evaluateTextProp } from './TextClip.ts';

export class TextRenderer {
  private offscreen: OffscreenCanvas;

  constructor(width: number, height: number) {
    this.offscreen = new OffscreenCanvas(width, height);
  }

  /**
   * Render a TextClip at a given clip-relative time.
   *
   * Keyframe-animated properties (x, y, scaleX, scaleY, rotation, opacity,
   * charReveal) are resolved via evaluateTextProp; clip defaults are used when
   * no track exists. charReveal (typewriter preset) slices clip.content to the
   * first Math.round(charReveal) characters before rendering.
   *
   * Returns an ImageBitmap (zero-copy from transferToImageBitmap).
   */
  render(clip: TextClip, clipRelativeT: number): ImageBitmap {
    const ctx = this.offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;

    // Clear the canvas
    ctx.clearRect(0, 0, this.offscreen.width, this.offscreen.height);

    // Resolve animated or static values
    const x       = evaluateTextProp(clip, 'x', clipRelativeT)       ?? clip.x;
    const y       = evaluateTextProp(clip, 'y', clipRelativeT)       ?? clip.y;
    const scaleX  = evaluateTextProp(clip, 'scaleX', clipRelativeT)  ?? clip.scaleX;
    const scaleY  = evaluateTextProp(clip, 'scaleY', clipRelativeT)  ?? clip.scaleY;
    const rotation = evaluateTextProp(clip, 'rotation', clipRelativeT) ?? clip.rotation;
    const opacity = evaluateTextProp(clip, 'opacity', clipRelativeT) ?? clip.style.opacity;
    const charReveal = evaluateTextProp(clip, 'charReveal', clipRelativeT);

    const { style } = clip;

    // Resolve font family — check if font is loaded, fall back to Arial
    let fontFamily = style.fontFamily;
    if (typeof document !== 'undefined' && document.fonts) {
      const fontSpec = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px "${fontFamily}"`;
      if (!document.fonts.check(fontSpec)) {
        fontFamily = 'Arial';
      }
    }

    // Build the font string
    const fontString = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px "${fontFamily}"`;

    // Apply transform: translate to position, rotate, scale
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.translate(x, y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scaleX, scaleY);

    // Apply text style
    ctx.font = fontString;
    ctx.fillStyle = style.color;
    ctx.textAlign = style.align;
    ctx.textBaseline = 'middle';

    // Apply typewriter character reveal if a charReveal track is active
    let displayContent = clip.content;
    if (charReveal !== null) {
      const charCount = Math.max(0, Math.round(charReveal));
      displayContent = clip.content.slice(0, charCount);
    }

    // Render each line — totalHeight uses full clip.content line count so
    // vertical layout does not shift as characters are progressively revealed.
    const lines = displayContent.split('\n');
    const lineHeight = style.fontSize * 1.2;
    const totalLines = clip.content.split('\n').length;
    const totalHeight = lineHeight * totalLines;
    const startY = -((totalHeight - lineHeight) / 2);

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, startY + i * lineHeight);
    }

    ctx.restore();

    return this.offscreen.transferToImageBitmap();
  }

  /** Replace the OffscreenCanvas with new dimensions. */
  resize(width: number, height: number): void {
    this.offscreen = new OffscreenCanvas(width, height);
  }
}
