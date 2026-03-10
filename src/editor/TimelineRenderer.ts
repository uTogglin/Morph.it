import type { Project, Track, Clip, AdjustmentClip } from './types.ts';
import { clipTimelineDuration } from './types.ts';
import {
  TRACK_HEADER_WIDTH,
  RULER_HEIGHT,
  TRACK_HEIGHT,
} from './TimelineController.ts';
import type { TimelineState } from './TimelineController.ts';
import type { WaveformCache }   from './WaveformCache.ts';
import type { ThumbnailCache } from './ThumbnailCache.ts';

// ── Colours ───────────────────────────────────────────────────────────────────

const COLOR_BG_HEADER        = '#1a1a1a';
const COLOR_BG_HEADER_BORDER = '#2a2a2a';
const COLOR_RULER_BG         = '#111111';
const COLOR_RULER_TICK_MAJOR = '#888888';
const COLOR_RULER_TICK_MINOR = '#444444';
const COLOR_RULER_LABEL      = '#aaaaaa';
const COLOR_TRACK_EVEN       = '#1e1e1e';
const COLOR_TRACK_ODD        = '#1a1a1a';
const COLOR_TRACK_BORDER     = '#2a2a2a';
const COLOR_GRID_LINE        = 'rgba(255,255,255,0.04)';
const COLOR_PLAYHEAD         = '#ffffff';
const COLOR_PLAYHEAD_TRI     = '#ffffff';
const COLOR_CLIP_VIDEO       = '#2a9d8f';
const COLOR_CLIP_AUDIO       = '#e76f51';
const COLOR_CLIP_SELECTED_BORDER = '#ffffff';
const COLOR_CLIP_LABEL       = '#ffffff';
const COLOR_CLIP_HANDLE      = 'rgba(255,255,255,0.25)';
const COLOR_WAVEFORM         = 'rgba(255,255,255,0.55)';
const COLOR_MUTE_CIRCLE      = '#e76f51';
const COLOR_SOLO_CIRCLE      = '#f4d03f';
const COLOR_VOLUME_BAR_BG    = '#333333';
const COLOR_VOLUME_BAR_FILL  = '#4caf50';
const COLOR_SCROLL_INDICATOR = 'rgba(255,255,255,0.2)';
const COLOR_CLIP_ADJUSTMENT  = 'rgba(168,85,247,0.7)';   // purple for adjustment clips
const COLOR_TRACK_ADJUSTMENT = 'rgba(168,85,247,0.08)';  // subtle purple tint for adj track row

const CLIP_CORNER_RADIUS = 4;
const HANDLE_WIDTH       = 6; // must match TimelineController

// ── Ruler tick interval logic ─────────────────────────────────────────────────

function chooseMajorInterval(zoom: number): number {
  const targetPx = 100;
  const rawSec   = targetPx / zoom;
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const n of nice) {
    if (n >= rawSec) return n;
  }
  return 3600;
}

function formatTime(seconds: number, majorInterval: number): string {
  if (majorInterval < 1) return seconds.toFixed(1) + 's';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0 && majorInterval < 60) return `${s}s`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class TimelineRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;
  private ro: ResizeObserver;

  // Internally-owned state that can be synced from the controller
  private _project: Project | null = null;
  private _waveforms:   WaveformCache   | null = null;
  private _thumbnails:  ThumbnailCache  | null = null;
  private _state: TimelineState = {
    zoom: 100,
    scrollX: 0,
    scrollY: 0,
    selectedClipIds: new Set(),
    playheadTime: 0,
  };

  /**
   * @param canvas       The main timeline canvas (track lanes).
   * @param _rulerCanvas Optional separate ruler canvas — ignored if provided; the
   *                     ruler is drawn on the main canvas's top band for simplicity.
   * @param opts         Initial options (pixelsPerSecond zoom).
   */
  constructor(
    canvas: HTMLCanvasElement,
    _rulerCanvas?: HTMLCanvasElement | null,
    opts?: { pixelsPerSecond?: number },
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('TimelineRenderer: cannot get 2D context from canvas.');
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;

    if (opts?.pixelsPerSecond) this._state.zoom = opts.pixelsPerSecond;

    this.ro = new ResizeObserver(() => this.syncSize());
    this.ro.observe(canvas);
    this.syncSize();
  }

  // ── Public state API ────────────────────────────────────────────────────────

  setProject(project: Project): void {
    this._project = project;
  }

  setPixelsPerSecond(pps: number): void {
    this._state.zoom = Math.max(10, Math.min(2000, pps));
  }

  /** Attach a WaveformCache so audio clips can display waveforms. */
  setWaveformCache(cache: WaveformCache): void {
    this._waveforms = cache;
  }

  /** Attach a ThumbnailCache so video clips display frame thumbnails. */
  setThumbnailCache(cache: ThumbnailCache): void {
    this._thumbnails = cache;
  }

  /**
   * Sync scroll, zoom, and selection state from the TimelineController.
   * Call this inside the controller's onChange callback before render().
   */
  syncState(state: TimelineState): void {
    this._state.zoom             = state.zoom;
    this._state.scrollX          = state.scrollX;
    this._state.scrollY          = state.scrollY;
    this._state.selectedClipIds  = state.selectedClipIds;
    // playheadTime is set by render(time)
  }

  /**
   * Re-render at the given playhead time.
   * Call on every frame update and after any state change.
   */
  render(time: number): void {
    if (!this._project) return;
    this._state.playheadTime = time;
    this._doRender(this._project, this._state);
  }

  dispose(): void {
    this.ro.disconnect();
  }

  // ── Internal render ─────────────────────────────────────────────────────────

  private syncSize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const w  = this.canvas.clientWidth;
    const h  = this.canvas.clientHeight;
    if (
      this.canvas.width  !== Math.round(w * this.dpr) ||
      this.canvas.height !== Math.round(h * this.dpr)
    ) {
      this.canvas.width  = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
    }
  }

  private _doRender(project: Project, state: TimelineState): void {
    const { ctx, dpr } = this;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;

    this.syncSize();

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.beginPath();
    ctx.rect(0, 0, cssW, cssH);
    ctx.clip();

    this.drawTrackHeaders(project, state, cssW, cssH);
    this.drawRuler(project, state, cssW);
    this.drawTrackLanes(project, state, cssW, cssH);
    this.drawPlayhead(state, cssH);
    this.drawScrollIndicators(project, state, cssW, cssH);

    ctx.restore();
  }

  // ── Track header panel ──────────────────────────────────────────────────────

  private drawTrackHeaders(project: Project, state: TimelineState, _cssW: number, cssH: number): void {
    const { ctx } = this;

    ctx.fillStyle = COLOR_BG_HEADER;
    ctx.fillRect(0, 0, TRACK_HEADER_WIDTH, cssH);

    ctx.fillStyle = COLOR_RULER_BG;
    ctx.fillRect(0, 0, TRACK_HEADER_WIDTH, RULER_HEIGHT);

    ctx.fillStyle = COLOR_BG_HEADER_BORDER;
    ctx.fillRect(TRACK_HEADER_WIDTH - 1, 0, 1, cssH);

    // Draw link brackets connecting adjacent paired tracks
    for (let i = 0; i < project.tracks.length - 1; i++) {
      const t1 = project.tracks[i];
      const t2 = project.tracks[i + 1];
      if (t1.linkedTrackId !== t2.id && t2.linkedTrackId !== t1.id) continue;
      const y1 = RULER_HEIGHT + i * TRACK_HEIGHT - state.scrollY;
      const y2 = y1 + TRACK_HEIGHT * 2;
      if (y2 < RULER_HEIGHT || y1 > cssH) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.moveTo(4, y1 + 6);
      ctx.lineTo(4, y2 - 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, y1 + 6);
      ctx.lineTo(8, y1 + 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, y2 - 6);
      ctx.lineTo(8, y2 - 6);
      ctx.stroke();
    }

    for (let i = 0; i < project.tracks.length; i++) {
      const track = project.tracks[i];
      const y     = RULER_HEIGHT + i * TRACK_HEIGHT - state.scrollY;

      if (y + TRACK_HEIGHT < RULER_HEIGHT || y > cssH) continue;

      ctx.fillStyle = COLOR_TRACK_BORDER;
      ctx.fillRect(0, y + TRACK_HEIGHT - 1, TRACK_HEADER_WIDTH, 1);

      ctx.fillStyle    = COLOR_RULER_LABEL;
      ctx.font         = '12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      // Indent linked audio track labels slightly
      const labelX       = track.linkedTrackId && track.kind === 'audio' ? 14 : 8;
      const maxNameWidth = TRACK_HEADER_WIDTH - 56 - (labelX - 8);
      ctx.fillText(this.truncateText(ctx, track.name, maxNameWidth), labelX, y + TRACK_HEIGHT * 0.35);

      // Mute / Solo indicators
      const iconY = y + TRACK_HEIGHT * 0.68;
      const muteX = TRACK_HEADER_WIDTH - 36;
      const soloX = TRACK_HEADER_WIDTH - 18;
      const r     = 5;

      ctx.beginPath();
      ctx.arc(muteX, iconY, r, 0, Math.PI * 2);
      ctx.fillStyle = track.muted ? COLOR_MUTE_CIRCLE : '#444';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(soloX, iconY, r, 0, Math.PI * 2);
      ctx.fillStyle = track.solo ? COLOR_SOLO_CIRCLE : '#444';
      ctx.fill();

      // Volume bar
      const barX  = 8;
      const barW  = TRACK_HEADER_WIDTH - 52;
      const barH  = 4;
      const barY  = y + TRACK_HEIGHT - 12;
      const fillW = Math.min(1, track.volume / 2) * barW;

      ctx.fillStyle = COLOR_VOLUME_BAR_BG;
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = COLOR_VOLUME_BAR_FILL;
      ctx.fillRect(barX, barY, fillW, barH);
    }
  }

  // ── Time ruler ──────────────────────────────────────────────────────────────

  private drawRuler(project: Project, state: TimelineState, cssW: number): void {
    const { ctx } = this;

    ctx.fillStyle = COLOR_RULER_BG;
    ctx.fillRect(TRACK_HEADER_WIDTH, 0, cssW - TRACK_HEADER_WIDTH, RULER_HEIGHT);

    const majorInterval = chooseMajorInterval(state.zoom);
    const minorInterval = majorInterval / 5;

    const tStart = state.scrollX;
    const tEnd   = state.scrollX + (cssW - TRACK_HEADER_WIDTH) / state.zoom;

    ctx.strokeStyle = COLOR_RULER_TICK_MINOR;
    ctx.lineWidth   = 1;
    const minorStart = Math.floor(tStart / minorInterval) * minorInterval;
    for (let t = minorStart; t <= tEnd + minorInterval; t += minorInterval) {
      const x = this.xAt(t, state) + 0.5;
      if (x < TRACK_HEADER_WIDTH) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 6);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
    }

    ctx.strokeStyle  = COLOR_RULER_TICK_MAJOR;
    ctx.lineWidth    = 1;
    ctx.fillStyle    = COLOR_RULER_LABEL;
    ctx.font         = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';

    const majorStart = Math.floor(tStart / majorInterval) * majorInterval;
    for (let t = majorStart; t <= tEnd + majorInterval; t += majorInterval) {
      const x = this.xAt(t, state) + 0.5;
      if (x < TRACK_HEADER_WIDTH) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 12);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();

      ctx.fillStyle = COLOR_RULER_LABEL;
      ctx.fillText(formatTime(t, majorInterval), x + 3, 4);
    }

    ctx.fillStyle = COLOR_TRACK_BORDER;
    ctx.fillRect(TRACK_HEADER_WIDTH, RULER_HEIGHT - 1, cssW - TRACK_HEADER_WIDTH, 1);

    // Playhead triangle on ruler
    const phX = this.xAt(state.playheadTime, state);
    if (phX >= TRACK_HEADER_WIDTH && phX <= cssW) {
      ctx.fillStyle = COLOR_PLAYHEAD_TRI;
      ctx.beginPath();
      ctx.moveTo(phX, 2);
      ctx.lineTo(phX + 6, RULER_HEIGHT - 4);
      ctx.lineTo(phX - 6, RULER_HEIGHT - 4);
      ctx.closePath();
      ctx.fill();
    }

    void project;
  }

  // ── Track lanes ─────────────────────────────────────────────────────────────

  private drawTrackLanes(project: Project, state: TimelineState, cssW: number, cssH: number): void {
    const { ctx } = this;

    ctx.save();
    ctx.beginPath();
    ctx.rect(TRACK_HEADER_WIDTH, RULER_HEIGHT, cssW - TRACK_HEADER_WIDTH, cssH - RULER_HEIGHT);
    ctx.clip();

    for (let i = 0; i < project.tracks.length; i++) {
      const y = RULER_HEIGHT + i * TRACK_HEIGHT - state.scrollY;
      if (y + TRACK_HEIGHT < RULER_HEIGHT || y > cssH) continue;

      ctx.fillStyle = i % 2 === 0 ? COLOR_TRACK_EVEN : COLOR_TRACK_ODD;
      ctx.fillRect(TRACK_HEADER_WIDTH, y, cssW - TRACK_HEADER_WIDTH, TRACK_HEIGHT);

      // Adjustment tracks get a subtle purple tint overlaid on the base row color
      if (project.tracks[i].kind === 'adjustment') {
        ctx.fillStyle = COLOR_TRACK_ADJUSTMENT;
        ctx.fillRect(TRACK_HEADER_WIDTH, y, cssW - TRACK_HEADER_WIDTH, TRACK_HEIGHT);
      }

      ctx.fillStyle = COLOR_TRACK_BORDER;
      ctx.fillRect(TRACK_HEADER_WIDTH, y + TRACK_HEIGHT - 1, cssW - TRACK_HEADER_WIDTH, 1);
    }

    // Vertical grid lines
    const majorInterval = chooseMajorInterval(state.zoom);
    const tStart        = state.scrollX;
    const tEnd          = state.scrollX + (cssW - TRACK_HEADER_WIDTH) / state.zoom;
    const majorStart    = Math.floor(tStart / majorInterval) * majorInterval;

    ctx.strokeStyle = COLOR_GRID_LINE;
    ctx.lineWidth   = 1;
    for (let t = majorStart; t <= tEnd + majorInterval; t += majorInterval) {
      const x = this.xAt(t, state) + 0.5;
      if (x < TRACK_HEADER_WIDTH) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }

    // Draw clips
    for (let ti = 0; ti < project.tracks.length; ti++) {
      const track  = project.tracks[ti];
      const trackY = RULER_HEIGHT + ti * TRACK_HEIGHT - state.scrollY;
      if (trackY + TRACK_HEIGHT < RULER_HEIGHT || trackY > cssH) continue;

      for (const clip of track.clips) {
        this.drawClip(clip, track, trackY, state, cssW);
      }

      // Render adjustment clips with distinct purple styling
      if (track.kind === 'adjustment') {
        for (const adjClip of track.adjustmentClips ?? []) {
          this.drawAdjustmentClip(adjClip, trackY, state, cssW);
        }
      }
    }

    ctx.restore();
  }

  private drawClip(
    clip: Clip,
    track: Track,
    trackY: number,
    state: TimelineState,
    cssW: number,
  ): void {
    const { ctx } = this;

    const clipDur  = clipTimelineDuration(clip);
    const x1       = this.xAt(clip.timelineStart, state);
    const x2       = this.xAt(clip.timelineStart + clipDur, state);
    const w        = x2 - x1;
    const h        = TRACK_HEIGHT - 2;
    const y        = trackY + 1;

    if (x2 < TRACK_HEADER_WIDTH || x1 > cssW || w < 1) return;

    const baseColor  = track.kind === 'video' ? COLOR_CLIP_VIDEO : COLOR_CLIP_AUDIO;
    const isSelected = state.selectedClipIds.has(clip.id);

    // Clip body
    ctx.fillStyle = baseColor;
    this.fillRoundRect(x1, y, w, h, CLIP_CORNER_RADIUS);

    // Depth gradient
    const grad = ctx.createLinearGradient(x1, y, x1, y + h);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = grad;
    this.fillRoundRect(x1, y, w, h, CLIP_CORNER_RADIUS);

    // Thumbnails for video clips
    if (track.kind === 'video' && this._thumbnails) {
      this.drawThumbnails(clip, x1, y, w, h);
    }

    // Waveform for audio clips
    if (track.kind === 'audio' && this._waveforms) {
      this.drawWaveform(clip, x1, y, w, h, state);
    }

    // Border
    ctx.strokeStyle = isSelected ? COLOR_CLIP_SELECTED_BORDER : 'rgba(0,0,0,0.4)';
    ctx.lineWidth   = isSelected ? 2 : 1;
    this.strokeRoundRect(x1, y, w, h, CLIP_CORNER_RADIUS);

    // Trim handles
    if (w > HANDLE_WIDTH * 2.5) {
      ctx.fillStyle = COLOR_CLIP_HANDLE;
      this.fillRoundRect(x1, y, HANDLE_WIDTH, h, CLIP_CORNER_RADIUS, 'left');
      this.fillRoundRect(x2 - HANDLE_WIDTH, y, HANDLE_WIDTH, h, CLIP_CORNER_RADIUS, 'right');
    }

    // Label
    if (w > 20) {
      const labelX = x1 + HANDLE_WIDTH + 4;
      const labelW = w - HANDLE_WIDTH * 2 - 8;
      const label  = clip.sourceFile?.name ?? clip.id;

      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(x1 + HANDLE_WIDTH, TRACK_HEADER_WIDTH), y + 1, labelW, h - 2);
      ctx.clip();

      ctx.fillStyle    = COLOR_CLIP_LABEL;
      ctx.font         = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      ctx.fillText(this.truncateText(ctx, label, labelW), labelX, y + h / 2);

      ctx.restore();
    }
  }

  // ── Adjustment clip drawing ──────────────────────────────────────────────────

  private drawAdjustmentClip(
    adjClip: AdjustmentClip,
    trackY: number,
    state: TimelineState,
    cssW: number,
  ): void {
    const { ctx } = this;

    const x1 = this.xAt(adjClip.timelineStart, state);
    const x2 = this.xAt(adjClip.timelineStart + adjClip.duration, state);
    const w  = x2 - x1;
    const h  = TRACK_HEIGHT - 2;
    const y  = trackY + 1;

    if (x2 < TRACK_HEADER_WIDTH || x1 > cssW || w < 1) return;

    // Clip body — solid purple base
    ctx.fillStyle = COLOR_CLIP_ADJUSTMENT;
    this.fillRoundRect(x1, y, w, h, CLIP_CORNER_RADIUS);

    // Diagonal stripe pattern to visually distinguish from video/audio clips
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(x1, TRACK_HEADER_WIDTH), y, Math.min(x2, cssW) - Math.max(x1, TRACK_HEADER_WIDTH), h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    const stripeSpacing = 10;
    for (let sx = x1 - h; sx < x2 + h; sx += stripeSpacing) {
      ctx.beginPath();
      ctx.moveTo(sx, y);
      ctx.lineTo(sx + h, y + h);
      ctx.stroke();
    }
    ctx.restore();

    // Border
    ctx.strokeStyle = 'rgba(168,85,247,0.9)';
    ctx.lineWidth   = 1;
    this.strokeRoundRect(x1, y, w, h, CLIP_CORNER_RADIUS);

    // "ADJ" label
    if (w > 24) {
      const labelX = x1 + HANDLE_WIDTH + 4;
      const labelW = w - HANDLE_WIDTH * 2 - 8;

      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(x1 + HANDLE_WIDTH, TRACK_HEADER_WIDTH), y + 1, labelW, h - 2);
      ctx.clip();

      ctx.fillStyle    = COLOR_CLIP_LABEL;
      ctx.font         = 'bold 11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      const label = adjClip.effects.length > 0 ? `ADJ (${adjClip.effects.length})` : 'ADJ';
      ctx.fillText(this.truncateText(ctx, label, labelW), labelX, y + h / 2);

      ctx.restore();
    }
  }

  // ── Thumbnail drawing ────────────────────────────────────────────────────────

  private drawThumbnails(
    clip: Clip,
    clipX: number,
    clipY: number,
    clipW: number,
    clipH: number,
  ): void {
    if (!this._thumbnails) return;

    const thumb = this._thumbnails.getThumbnail(clip.id);
    if (!thumb) {
      this._thumbnails.request(clip.id, clip.sourceFile, () => {
        if (this._project) this._doRender(this._project, this._state);
      });
      return;
    }

    const { ctx } = this;
    // Scale the thumbnail to track height, keeping aspect ratio
    const thumbH = clipH;
    const thumbW = Math.round(thumb.width * (thumbH / thumb.height));
    if (thumbW <= 0) return;

    // Clip to the inner area (excluding trim handles)
    const innerX = Math.max(clipX + HANDLE_WIDTH, TRACK_HEADER_WIDTH);
    const innerW = clipX + clipW - HANDLE_WIDTH - innerX;
    if (innerW <= 0) return;

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.rect(innerX, clipY, innerW, clipH);
    ctx.clip();

    // Tile the thumbnail across the clip
    for (let tx = clipX + HANDLE_WIDTH; tx < clipX + clipW - HANDLE_WIDTH; tx += thumbW) {
      ctx.drawImage(thumb, tx, clipY, thumbW, thumbH);
    }

    ctx.restore();
  }

  // ── Waveform drawing ─────────────────────────────────────────────────────────

  private drawWaveform(
    clip: Clip,
    clipX: number,
    clipY: number,
    clipW: number,
    clipH: number,
    state: TimelineState,
  ): void {
    if (!this._waveforms) return;

    const peaks = this._waveforms.getPeaks(clip.id);
    if (!peaks || peaks.length === 0) {
      // Trigger async decode — next render will have the data
      this._waveforms.requestDecode(clip.id, clip.sourceFile, () => {
        if (this._project) this._doRender(this._project, this._state);
      });
      return;
    }

    const { ctx } = this;
    const mid     = clipY + clipH / 2;
    const amp     = (clipH / 2) * 0.8; // 80% of half-height

    // Map visible pixel columns to peak indices
    const visX1  = Math.max(clipX, TRACK_HEADER_WIDTH);
    const visX2  = clipX + clipW;
    const peakCount = peaks.length;

    // How many seconds the full peaks array covers = clip source duration
    const srcDur = clip.sourceEnd - clip.sourceStart;
    // Pixels per second at current zoom
    const pps    = state.zoom;

    ctx.save();
    ctx.beginPath();
    ctx.rect(visX1, clipY, visX2 - visX1, clipH);
    ctx.clip();

    ctx.strokeStyle = COLOR_WAVEFORM;
    ctx.lineWidth   = 1;
    ctx.beginPath();

    for (let px = Math.floor(visX1); px < visX2; px++) {
      // Timeline time for this pixel
      const tTimeline = (px - clipX) / pps;
      // Clamp to clip bounds
      if (tTimeline < 0 || tTimeline > srcDur) continue;
      // Map to peak index
      const peakIdx = Math.min(Math.floor((tTimeline / srcDur) * peakCount), peakCount - 1);
      const peak    = peaks[peakIdx];
      const dy      = peak * amp;
      const x       = px + 0.5;

      ctx.moveTo(x, mid - dy);
      ctx.lineTo(x, mid + dy);
    }

    ctx.stroke();
    ctx.restore();
  }

  // ── Playhead ─────────────────────────────────────────────────────────────────

  private drawPlayhead(state: TimelineState, cssH: number): void {
    const { ctx } = this;
    const x = this.xAt(state.playheadTime, state);

    if (x < TRACK_HEADER_WIDTH) return;

    ctx.strokeStyle = COLOR_PLAYHEAD;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_HEIGHT);
    ctx.lineTo(x + 0.5, cssH);
    ctx.stroke();
  }

  // ── Scroll indicators ────────────────────────────────────────────────────────

  private drawScrollIndicators(project: Project, state: TimelineState, cssW: number, cssH: number): void {
    const { ctx } = this;

    const contentW = cssW - TRACK_HEADER_WIDTH;
    const contentH = cssH - RULER_HEIGHT;
    if (contentW <= 0 || contentH <= 0) return;

    const totalSec  = Math.max(project.duration, state.scrollX + contentW / state.zoom);
    const totalPxW  = totalSec * state.zoom;
    const totalPxH  = project.tracks.length * TRACK_HEIGHT;
    const minThumb  = 20;

    if (totalPxW > contentW) {
      const ratio       = contentW / totalPxW;
      const thumbW      = Math.max(minThumb, contentW * ratio);
      const scrollRatio = (state.scrollX * state.zoom) / (totalPxW - contentW);
      const thumbX      = TRACK_HEADER_WIDTH + scrollRatio * (contentW - thumbW);
      ctx.fillStyle = COLOR_SCROLL_INDICATOR;
      this.fillRoundRect(thumbX, cssH - 10, thumbW, 8, 4);
    }

    if (totalPxH > contentH) {
      const ratio       = contentH / totalPxH;
      const thumbH      = Math.max(minThumb, contentH * ratio);
      const scrollRatio = state.scrollY / (totalPxH - contentH);
      const thumbY      = RULER_HEIGHT + scrollRatio * (contentH - thumbH);
      ctx.fillStyle = COLOR_SCROLL_INDICATOR;
      this.fillRoundRect(cssW - 10, thumbY, 8, thumbH, 4);
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private xAt(time: number, state: TimelineState): number {
    return (time - state.scrollX) * state.zoom + TRACK_HEADER_WIDTH;
  }

  private fillRoundRect(
    x: number, y: number, w: number, h: number, r: number,
    side?: 'left' | 'right',
  ): void {
    const { ctx } = this;
    const rr = Math.min(r, w / 2, h / 2);
    const tl = (!side || side === 'left')  ? rr : 0;
    const tr = (!side || side === 'right') ? rr : 0;
    const bl = (!side || side === 'left')  ? rr : 0;
    const br = (!side || side === 'right') ? rr : 0;

    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    if (tr > 0) ctx.arcTo(x + w, y, x + w, y + tr, tr);
    else ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - br);
    if (br > 0) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    else ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + bl, y + h);
    if (bl > 0) ctx.arcTo(x, y + h, x, y + h - bl, bl);
    else ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + tl);
    if (tl > 0) ctx.arcTo(x, y, x + tl, y, tl);
    else ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  }

  private strokeRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
    ctx.stroke();
  }

  private truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (maxWidth <= 0) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ellipsis  = '…';
    const ellipsisW = ctx.measureText(ellipsis).width;
    if (ellipsisW >= maxWidth) return '';
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid)).width + ellipsisW <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + ellipsis;
  }
}
