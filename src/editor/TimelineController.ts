import type { Project, Clip } from './types.ts';
import { clipTimelineDuration } from './types.ts';

// ── Layout constants ──────────────────────────────────────────────────────────

export const TRACK_HEADER_WIDTH = 160; // px
export const RULER_HEIGHT = 30;        // px
export const TRACK_HEIGHT = 60;        // px
const HANDLE_WIDTH = 6;                // px — width of trim handles
const SNAP_THRESHOLD_PX = 8;          // px — snap distance in screen pixels

// ── State ─────────────────────────────────────────────────────────────────────

export interface TimelineState {
  zoom: number;           // pixels per second (e.g. 100 = 100px per second)
  scrollX: number;        // horizontal scroll offset in seconds
  scrollY: number;        // vertical scroll offset in pixels
  selectedClipIds: Set<string>;
  playheadTime: number;   // current playhead position in seconds
}

// ── Hit-test result types ─────────────────────────────────────────────────────

type HitKind =
  | { kind: 'ruler' }
  | { kind: 'clipBody';        clip: Clip; trackIndex: number }
  | { kind: 'clipLeftHandle';  clip: Clip; trackIndex: number }
  | { kind: 'clipRightHandle'; clip: Clip; trackIndex: number }
  | { kind: 'emptyTrack';      trackIndex: number }
  | { kind: 'trackHeader';     trackIndex: number }
  | { kind: 'none' };

// ── Drag state ────────────────────────────────────────────────────────────────

type DragMode =
  | { mode: 'seek' }
  | { mode: 'moveClip';       clip: Clip; trackIndex: number; originTimelineStart: number; originPx: number }
  | { mode: 'trimLeft';       clip: Clip; originSourceStart: number; originTimelineStart: number; originPx: number }
  | { mode: 'trimRight';      clip: Clip; originSourceEnd: number; originPx: number }
  | { mode: 'scrollCanvas';   originScrollX: number; originScrollY: number; originPx: number; originPy: number };

// ── Callbacks ─────────────────────────────────────────────────────────────────

export interface TimelineCallbacks {
  onSeek?: (time: number) => void;
  onClipMoved?: (clipId: string, newTimelineStart: number) => void;
  onClipTrimmed?: (clipId: string, newSourceStart: number, newSourceEnd: number, newTimelineStart: number) => void;
  onSelectionChanged?: (selectedIds: Set<string>) => void;
  /** Fired when the zoom level changes (pixels per second). */
  onZoomChange?: (pixelsPerSecond: number) => void;
  /** Fired just before a clip move or trim drag begins — use to take an undo snapshot. */
  onBeforeChange?: () => void;
  onChange?: () => void;
}

// ── Controller ────────────────────────────────────────────────────────────────

export class TimelineController {
  private canvas: HTMLCanvasElement;
  private project: Project | null = null;
  private callbacks: TimelineCallbacks;

  readonly state: TimelineState = {
    zoom: 100,
    scrollX: 0,
    scrollY: 0,
    selectedClipIds: new Set(),
    playheadTime: 0,
  };

  private drag: DragMode | null = null;
  private pointerLocked = false;
  private accumulatedDx = 0;
  private accumulatedDy = 0;

  // Bound listener references for cleanup
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerMove: (e: PointerEvent) => void;
  private readonly _onPointerUp:   (e: PointerEvent) => void;
  private readonly _onWheel:       (e: WheelEvent)   => void;
  private readonly _onPointerLockChange: () => void;

  constructor(canvas: HTMLCanvasElement, callbacks: TimelineCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;

    this._onPointerDown       = this.handlePointerDown.bind(this);
    this._onPointerMove       = this.handlePointerMove.bind(this);
    this._onPointerUp         = this.handlePointerUp.bind(this);
    this._onWheel             = this.handleWheel.bind(this);
    this._onPointerLockChange = this.handlePointerLockChange.bind(this);

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup',   this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setProject(project: Project): void {
    this.project = project;
  }

  setPlayhead(time: number): void {
    this.state.playheadTime = Math.max(0, time);
    this.callbacks.onChange?.();
  }

  setZoom(zoom: number): void {
    this.state.zoom = Math.max(10, Math.min(2000, zoom));
    this.callbacks.onChange?.();
  }

  setScroll(scrollX: number, scrollY: number): void {
    this.state.scrollX = Math.max(0, scrollX);
    this.state.scrollY = Math.max(0, scrollY);
    this.callbacks.onChange?.();
  }

  selectClips(ids: Set<string>): void {
    this.state.selectedClipIds = new Set(ids);
    this.callbacks.onSelectionChanged?.(new Set(ids));
    this.callbacks.onChange?.();
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup',   this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  // ── Coordinate conversion ───────────────────────────────────────────────────

  /** Convert canvas-space pixel X to a timeline time in seconds. */
  timeAt(pixelX: number): number {
    const contentX = pixelX - TRACK_HEADER_WIDTH;
    return contentX / this.state.zoom + this.state.scrollX;
  }

  /** Convert a timeline time in seconds to canvas-space pixel X. */
  xAt(time: number): number {
    return (time - this.state.scrollX) * this.state.zoom + TRACK_HEADER_WIDTH;
  }

  /** Convert canvas-space pixel Y (below ruler) to a track index. */
  trackIndexAt(pixelY: number): number {
    const contentY = pixelY - RULER_HEIGHT + this.state.scrollY;
    return Math.floor(contentY / TRACK_HEIGHT);
  }

  /** Top pixel Y for a given track index in canvas space. */
  yForTrack(trackIndex: number): number {
    return RULER_HEIGHT + trackIndex * TRACK_HEIGHT - this.state.scrollY;
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  hitTest(px: number, py: number): HitKind {
    if (!this.project) return { kind: 'none' };

    // Track header panel
    if (px < TRACK_HEADER_WIDTH) {
      if (py < RULER_HEIGHT) return { kind: 'none' };
      const ti = this.trackIndexAt(py);
      if (ti >= 0 && ti < this.project.tracks.length) {
        return { kind: 'trackHeader', trackIndex: ti };
      }
      return { kind: 'none' };
    }

    // Time ruler
    if (py < RULER_HEIGHT) {
      return { kind: 'ruler' };
    }

    // Track lanes
    const trackIndex = this.trackIndexAt(py);
    if (trackIndex < 0 || trackIndex >= this.project.tracks.length) {
      return { kind: 'none' };
    }

    const track = this.project.tracks[trackIndex];
    const time  = this.timeAt(px);

    // Check clips from last to first (top-most drawn last wins)
    for (let i = track.clips.length - 1; i >= 0; i--) {
      const clip     = track.clips[i];
      const clipEnd  = clip.timelineStart + clipTimelineDuration(clip);
      const x1       = this.xAt(clip.timelineStart);
      const x2       = this.xAt(clipEnd);

      if (time < clip.timelineStart || time > clipEnd) continue;

      const handlePxL = HANDLE_WIDTH / this.state.zoom; // handle width in seconds
      void handlePxL;

      // Left handle: first HANDLE_WIDTH pixels of the clip rect
      if (px <= x1 + HANDLE_WIDTH) {
        return { kind: 'clipLeftHandle', clip, trackIndex };
      }
      // Right handle: last HANDLE_WIDTH pixels of the clip rect
      if (px >= x2 - HANDLE_WIDTH) {
        return { kind: 'clipRightHandle', clip, trackIndex };
      }
      return { kind: 'clipBody', clip, trackIndex };
    }

    return { kind: 'emptyTrack', trackIndex };
  }

  // ── Snapping ────────────────────────────────────────────────────────────────

  /**
   * Given a raw time, snap it to nearby clip edges or the playhead if within
   * SNAP_THRESHOLD_PX screen pixels. Returns the snapped time.
   */
  snap(time: number, excludeClipId?: string): number {
    if (!this.project) return time;

    const thresholdSeconds = SNAP_THRESHOLD_PX / this.state.zoom;
    let best = time;
    let bestDist = thresholdSeconds;

    const check = (candidate: number) => {
      const d = Math.abs(candidate - time);
      if (d < bestDist) { bestDist = d; best = candidate; }
    };

    // Snap to playhead
    check(this.state.playheadTime);

    // Snap to clip edges
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (clip.id === excludeClipId) continue;
        check(clip.timelineStart);
        check(clip.timelineStart + clipTimelineDuration(clip));
      }
    }

    return best;
  }

  // ── Pointer event handlers ──────────────────────────────────────────────────

  private getCanvasPos(e: PointerEvent): { px: number; py: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    // Canvas logical coords (unscaled)
    return {
      px: (e.clientX - rect.left),
      py: (e.clientY - rect.top),
    };
    void dpr;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.project) return;
    if (e.button !== 0) return; // left button only

    this.canvas.setPointerCapture(e.pointerId);

    const { px, py } = this.getCanvasPos(e);
    const hit = this.hitTest(px, py);
    this.accumulatedDx = 0;
    this.accumulatedDy = 0;

    switch (hit.kind) {
      case 'ruler': {
        const t = Math.max(0, this.timeAt(px));
        this.state.playheadTime = t;
        this.callbacks.onSeek?.(t);
        this.callbacks.onChange?.();
        this.drag = { mode: 'seek' };
        this.tryPointerLock();
        break;
      }

      case 'clipBody': {
        this.callbacks.onBeforeChange?.();
        // Toggle/set selection
        if (e.shiftKey) {
          const next = new Set(this.state.selectedClipIds);
          if (next.has(hit.clip.id)) next.delete(hit.clip.id);
          else next.add(hit.clip.id);
          this.state.selectedClipIds = next;
        } else {
          if (!this.state.selectedClipIds.has(hit.clip.id)) {
            this.state.selectedClipIds = new Set([hit.clip.id]);
          }
        }
        this.callbacks.onSelectionChanged?.(new Set(this.state.selectedClipIds));
        this.callbacks.onChange?.();
        this.drag = {
          mode: 'moveClip',
          clip: hit.clip,
          trackIndex: hit.trackIndex,
          originTimelineStart: hit.clip.timelineStart,
          originPx: px,
        };
        this.tryPointerLock();
        break;
      }

      case 'clipLeftHandle': {
        this.callbacks.onBeforeChange?.();
        this.drag = {
          mode: 'trimLeft',
          clip: hit.clip,
          originSourceStart: hit.clip.sourceStart,
          originTimelineStart: hit.clip.timelineStart,
          originPx: px,
        };
        this.tryPointerLock();
        break;
      }

      case 'clipRightHandle': {
        this.callbacks.onBeforeChange?.();
        this.drag = {
          mode: 'trimRight',
          clip: hit.clip,
          originSourceEnd: hit.clip.sourceEnd,
          originPx: px,
        };
        this.tryPointerLock();
        break;
      }

      case 'emptyTrack':
      case 'none': {
        if (!e.shiftKey) {
          this.state.selectedClipIds = new Set();
          this.callbacks.onSelectionChanged?.(new Set());
        }
        this.drag = {
          mode: 'scrollCanvas',
          originScrollX: this.state.scrollX,
          originScrollY: this.state.scrollY,
          originPx: px,
          originPy: py,
        };
        this.callbacks.onChange?.();
        break;
      }

      case 'trackHeader':
        // No drag initiated from header for now
        break;
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.drag || !this.project) return;

    // With pointer lock, use movementX/Y; otherwise use canvas-space position
    let dx: number;
    let dy: number;

    if (this.pointerLocked) {
      this.accumulatedDx += e.movementX;
      this.accumulatedDy += e.movementY;
      dx = this.accumulatedDx;
      dy = this.accumulatedDy;
    } else {
      const { px, py } = this.getCanvasPos(e);
      dx = px - (this.drag.mode === 'scrollCanvas' ? this.drag.originPx : (this.drag as { originPx: number }).originPx);
      dy = py - (this.drag.mode === 'scrollCanvas' ? this.drag.originPy : 0);
    }

    switch (this.drag.mode) {
      case 'seek': {
        const { px } = this.getCanvasPos(e);
        const t = Math.max(0, this.timeAt(this.pointerLocked ? TRACK_HEADER_WIDTH + this.accumulatedDx : px));
        this.state.playheadTime = t;
        this.callbacks.onSeek?.(t);
        this.callbacks.onChange?.();
        break;
      }

      case 'moveClip': {
        const deltaSec  = dx / this.state.zoom;
        let newStart    = this.drag.originTimelineStart + deltaSec;
        newStart        = Math.max(0, newStart);
        newStart        = this.snap(newStart, this.drag.clip.id);
        this.drag.clip.timelineStart = newStart;
        this.callbacks.onChange?.();
        break;
      }

      case 'trimLeft': {
        const deltaSec        = dx / this.state.zoom;
        const origSrcStart    = this.drag.originSourceStart;
        const origTlStart     = this.drag.originTimelineStart;
        let newSrcStart       = origSrcStart + deltaSec * this.drag.clip.speed;
        let newTlStart        = origTlStart  + deltaSec;

        // Clamp: cannot trim past the source end (min 0.1s clip)
        const minDur = 0.1;
        const maxSrcStart = this.drag.clip.sourceEnd - minDur * this.drag.clip.speed;
        newSrcStart = Math.max(0, Math.min(newSrcStart, maxSrcStart));
        // Keep timelineStart from going negative
        newTlStart  = Math.max(0, newTlStart);
        // Recalc consistent delta
        const actualDelta  = newSrcStart - origSrcStart;
        newTlStart         = origTlStart + actualDelta / this.drag.clip.speed;

        newTlStart  = this.snap(newTlStart, this.drag.clip.id);
        const snappedDelta = newTlStart - origTlStart;
        newSrcStart = origSrcStart + snappedDelta * this.drag.clip.speed;
        newSrcStart = Math.max(0, Math.min(newSrcStart, maxSrcStart));

        this.drag.clip.sourceStart   = newSrcStart;
        this.drag.clip.timelineStart = newTlStart;
        this.callbacks.onChange?.();
        break;
      }

      case 'trimRight': {
        const deltaSec     = dx / this.state.zoom;
        let newSrcEnd      = this.drag.originSourceEnd + deltaSec * this.drag.clip.speed;
        const minDur       = 0.1;
        const minSrcEnd    = this.drag.clip.sourceStart + minDur * this.drag.clip.speed;
        newSrcEnd          = Math.max(newSrcEnd, minSrcEnd);

        // Snap the right edge (timeline position)
        const newTlEnd     = this.drag.clip.timelineStart + (newSrcEnd - this.drag.clip.sourceStart) / this.drag.clip.speed;
        const snappedTlEnd = this.snap(newTlEnd, this.drag.clip.id);
        const snappedDelta = snappedTlEnd - (this.drag.clip.timelineStart + (this.drag.originSourceEnd - this.drag.clip.sourceStart) / this.drag.clip.speed);
        newSrcEnd          = this.drag.originSourceEnd + snappedDelta * this.drag.clip.speed;
        newSrcEnd          = Math.max(newSrcEnd, minSrcEnd);

        this.drag.clip.sourceEnd = newSrcEnd;
        this.callbacks.onChange?.();
        break;
      }

      case 'scrollCanvas': {
        const dxSec = -dx / this.state.zoom;
        this.state.scrollX = Math.max(0, this.drag.originScrollX + dxSec);
        this.state.scrollY = Math.max(0, this.drag.originScrollY - dy);
        this.callbacks.onChange?.();
        break;
      }
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.drag) return;

    // Fire final "committed" callbacks
    switch (this.drag.mode) {
      case 'moveClip':
        this.callbacks.onClipMoved?.(this.drag.clip.id, this.drag.clip.timelineStart);
        break;

      case 'trimLeft':
        this.callbacks.onClipTrimmed?.(
          this.drag.clip.id,
          this.drag.clip.sourceStart,
          this.drag.clip.sourceEnd,
          this.drag.clip.timelineStart,
        );
        break;

      case 'trimRight':
        this.callbacks.onClipTrimmed?.(
          this.drag.clip.id,
          this.drag.clip.sourceStart,
          this.drag.clip.sourceEnd,
          this.drag.clip.timelineStart,
        );
        break;

      default:
        break;
    }

    if (this.pointerLocked && document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }

    this.drag = null;
    void e;
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    if (e.ctrlKey) {
      // Zoom: centered on cursor position
      const { px } = this.getCanvasPos(e as unknown as PointerEvent);
      const timeUnderCursor = this.timeAt(px);
      const zoomFactor      = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom         = Math.max(10, Math.min(2000, this.state.zoom * zoomFactor));
      // Adjust scrollX so the time under the cursor stays fixed
      this.state.zoom    = newZoom;
      this.state.scrollX = timeUnderCursor - (px - TRACK_HEADER_WIDTH) / newZoom;
      this.state.scrollX = Math.max(0, this.state.scrollX);
      this.callbacks.onZoomChange?.(newZoom);
    } else if (e.shiftKey) {
      // Horizontal scroll
      const deltaSeconds     = e.deltaY / this.state.zoom;
      this.state.scrollX     = Math.max(0, this.state.scrollX + deltaSeconds);
    } else {
      // Vertical scroll
      this.state.scrollY = Math.max(0, this.state.scrollY + e.deltaY);
    }

    this.callbacks.onChange?.();
  }

  // ── Pointer lock helpers ────────────────────────────────────────────────────

  private tryPointerLock(): void {
    if (this.canvas.requestPointerLock) {
      try {
        this.canvas.requestPointerLock();
      } catch {
        // Pointer lock not available or denied — fall back gracefully
      }
    }
  }

  private handlePointerLockChange(): void {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) {
      this.accumulatedDx = 0;
      this.accumulatedDy = 0;
    }
  }
}
