// ── TextEditOverlay ────────────────────────────────────────────────────────────
// Fabric.js IText overlay for in-place text editing on the preview canvas.
// Positioned absolutely over previewCanvas; pointer-events toggled based on state.

import type { TextClip } from './TextClip.ts';
// fabric is bundled in package.json — import by package name.
// Using dynamic import so the bundle remains code-split friendly.

// ── TextEditOverlay ───────────────────────────────────────────────────────────

export class TextEditOverlay {
  private previewCanvas: HTMLCanvasElement;
  private overlayEl: HTMLCanvasElement;
  private fabricCanvas: import('fabric').Canvas | null = null;
  private _isEditing = false;
  private _itext: import('fabric').IText | null = null;

  constructor(previewCanvas: HTMLCanvasElement) {
    this.previewCanvas = previewCanvas;

    // Create overlay canvas element
    const overlay = document.createElement('canvas');
    overlay.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;z-index:10';
    this.overlayEl = overlay;

    // Insert as next sibling after previewCanvas so it floats above
    const parent = previewCanvas.parentElement;
    if (parent) {
      // Ensure parent has relative/absolute positioning so absolute child works
      const pStyle = getComputedStyle(parent);
      if (pStyle.position === 'static') {
        parent.style.position = 'relative';
      }
      if (previewCanvas.nextSibling) {
        parent.insertBefore(overlay, previewCanvas.nextSibling);
      } else {
        parent.appendChild(overlay);
      }
    } else {
      // Fallback: append to body
      document.body.appendChild(overlay);
    }
  }

  // ── startEdit ─────────────────────────────────────────────────────────────

  async startEdit(clip: TextClip, onCommit: (newContent: string) => void): Promise<void> {
    if (this._isEditing) this.stopEdit();

    // Resize overlay to match preview canvas
    const rect = this.previewCanvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;

    this.overlayEl.width  = this.previewCanvas.width;
    this.overlayEl.height = this.previewCanvas.height;
    this.overlayEl.style.width  = rect.width  + 'px';
    this.overlayEl.style.height = rect.height + 'px';
    this.overlayEl.style.top    = '0px';
    this.overlayEl.style.left   = '0px';
    this.overlayEl.style.pointerEvents = 'all';

    // Scale factor: overlay canvas px vs preview canvas CSS px
    const scaleX = this.previewCanvas.width  / rect.width;
    const scaleY = this.previewCanvas.height / rect.height;

    // Create fabric.Canvas lazily
    const { Canvas: FabricCanvas, IText } = await import('fabric');

    if (this.fabricCanvas) {
      this.fabricCanvas.dispose();
      this.fabricCanvas = null;
    }

    this.fabricCanvas = new FabricCanvas(this.overlayEl, {
      selection: false,
      backgroundColor: 'transparent',
    });
    this.fabricCanvas.setDimensions(
      { width: this.previewCanvas.width, height: this.previewCanvas.height },
      { backstoreOnly: true },
    );
    this.fabricCanvas.setDimensions(
      { width: rect.width, height: rect.height },
      { cssOnly: true },
    );

    // Create IText at clip position (clip x/y are in canvas-space px)
    const itext = new IText(clip.content, {
      left:       clip.x,
      top:        clip.y,
      fontFamily: clip.style.fontFamily,
      fontSize:   clip.style.fontSize,
      fontWeight: String(clip.style.fontWeight),
      fontStyle:  clip.style.fontStyle,
      fill:       clip.style.color,
      opacity:    clip.style.opacity,
      textAlign:  clip.style.align,
      selectable: true,
      editable:   true,
      originX:    'center',
      originY:    'center',
    });

    this.fabricCanvas.add(itext);
    this.fabricCanvas.renderAll();

    itext.enterEditing();
    itext.selectAll();
    this.fabricCanvas.setActiveObject(itext);
    this.fabricCanvas.renderAll();

    this._itext    = itext;
    this._isEditing = true;

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;
      const newText = itext.text ?? clip.content;
      this.stopEdit();
      onCommit(newText);
    };

    itext.on('editing:exited', commit);

    // Also commit on canvas click outside the IText
    this.fabricCanvas.on('mouse:down', (e) => {
      if (e.target !== itext && this._isEditing) {
        commit();
      }
    });
  }

  // ── stopEdit ──────────────────────────────────────────────────────────────

  stopEdit(): void {
    this._isEditing = false;
    if (this._itext) {
      try { this._itext.exitEditing(); } catch (_) { /* ignore */ }
      this._itext = null;
    }
    if (this.fabricCanvas) {
      this.fabricCanvas.clear();
      this.fabricCanvas.renderAll();
    }
    this.overlayEl.style.pointerEvents = 'none';
  }

  // ── isEditing getter ──────────────────────────────────────────────────────

  get isEditing(): boolean {
    return this._isEditing;
  }

  // ── dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.stopEdit();
    if (this.fabricCanvas) {
      this.fabricCanvas.dispose();
      this.fabricCanvas = null;
    }
    this.overlayEl.remove();
  }
}
