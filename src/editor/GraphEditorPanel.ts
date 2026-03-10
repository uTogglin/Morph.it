// ── GraphEditorPanel ───────────────────────────────────────────────────────────
// SVG-based keyframe curve editor. Renders below the timeline as a bottom panel.
// Syncs time axis with TimelineController.state (scrollX, zoom, playheadTime).
// Supports:
//   • Property selector list on the left
//   • SVG curve rendering (cubic bezier between keyframes)
//   • Draggable bezier handles (free/independent, DaVinci-style)
//   • Draggable keyframe diamonds
//   • Resizable panel via top drag handle

import type { Clip, Keyframe, KeyframeTrack } from './types.ts';
import type { TimelineState } from './TimelineController.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_BG          = '#1e1e1e';
const GRID_COLOR        = 'rgba(255,255,255,0.1)';
const CURVE_COLOR       = '#4fc3f7';
const DIAMOND_COLOR     = '#f5a623';
const DIAMOND_SELECTED  = '#ffd54f';
const HANDLE_COLOR      = '#ffffff';
const HANDLE_LINE_COLOR = 'rgba(255,255,255,0.4)';
const PLAYHEAD_COLOR    = '#ff4444';
const PROPERTY_BG       = '#252525';
const PROPERTY_SEL_BG   = '#333';
const PROPERTY_TEXT     = '#ccc';
const TEXT_DIM          = '#666';

const DEFAULT_HEIGHT   = 200; // px
const MIN_HEIGHT       = 80;
const MAX_HEIGHT       = 600;
const PROPERTY_WIDTH   = 150; // px
const VALUE_PADDING    = 0.1; // 10% padding on value axis

// ── SVG namespace ─────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
}

// ── GraphEditorPanel ──────────────────────────────────────────────────────────

export class GraphEditorPanel {
  private container: HTMLDivElement;
  private resizeHandle: HTMLDivElement;
  private body: HTMLDivElement;
  private propertyList: HTMLDivElement;
  private svgEl: SVGSVGElement;

  private currentTrack: KeyframeTrack | null = null;
  private currentClip: Clip | null = null;
  private timelineState: TimelineState;
  private onChange: () => void;

  private _visible = false;
  private _height = DEFAULT_HEIGHT;
  private selectedKfIndex = -1;

  // ── Layer groups inside SVG ────────────────────────────────────────────────
  private gridGroup: SVGGElement;
  private curveGroup: SVGGElement;
  private handleLineGroup: SVGGElement;
  private handleGroup: SVGGElement;
  private diamondGroup: SVGGElement;
  private playheadEl: SVGLineElement;
  private emptyLabel: SVGTextElement;

  constructor(
    parentEl: HTMLElement,
    timelineState: TimelineState,
    onChange: () => void,
  ) {
    this.timelineState = timelineState;
    this.onChange = onChange;

    // ── Container ─────────────────────────────────────────────────────────
    this.container = document.createElement('div');
    this.container.className = 'graph-editor-panel';
    Object.assign(this.container.style, {
      position:   'relative',
      borderTop:  '1px solid #333',
      background: PANEL_BG,
      display:    'none',
      height:     `${this._height}px`,
      userSelect: 'none',
      WebkitUserSelect: 'none',
    });

    // ── Resize handle ──────────────────────────────────────────────────────
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'graph-editor-resize-handle';
    Object.assign(this.resizeHandle.style, {
      position:   'absolute',
      top:        '0',
      left:       '0',
      right:      '0',
      height:     '6px',
      cursor:     'ns-resize',
      zIndex:     '10',
    });
    this.container.appendChild(this.resizeHandle);

    // ── Body ───────────────────────────────────────────────────────────────
    this.body = document.createElement('div');
    this.body.className = 'graph-editor-body';
    Object.assign(this.body.style, {
      display:    'flex',
      height:     '100%',
      paddingTop: '6px', // account for resize handle
      boxSizing:  'border-box',
    });
    this.container.appendChild(this.body);

    // ── Property list ──────────────────────────────────────────────────────
    this.propertyList = document.createElement('div');
    this.propertyList.className = 'graph-editor-properties';
    Object.assign(this.propertyList.style, {
      width:      `${PROPERTY_WIDTH}px`,
      minWidth:   `${PROPERTY_WIDTH}px`,
      overflowY:  'auto',
      background: PROPERTY_BG,
      borderRight:'1px solid #333',
    });
    this.body.appendChild(this.propertyList);

    // ── SVG area ───────────────────────────────────────────────────────────
    this.svgEl = svgEl('svg');
    this.svgEl.setAttribute('class', 'graph-editor-curves');
    Object.assign(this.svgEl.style, {
      flex:     '1',
      display:  'block',
      height:   '100%',
    });
    this.body.appendChild(this.svgEl);

    // ── SVG layer groups ───────────────────────────────────────────────────
    this.gridGroup       = svgEl('g');
    this.curveGroup      = svgEl('g');
    this.handleLineGroup = svgEl('g');
    this.handleGroup     = svgEl('g');
    this.diamondGroup    = svgEl('g');
    this.playheadEl      = svgEl('line');
    this.emptyLabel      = svgEl('text');

    this.playheadEl.setAttribute('stroke',       PLAYHEAD_COLOR);
    this.playheadEl.setAttribute('stroke-width', '1.5');

    this.svgEl.appendChild(this.gridGroup);
    this.svgEl.appendChild(this.curveGroup);
    this.svgEl.appendChild(this.handleLineGroup);
    this.svgEl.appendChild(this.handleGroup);
    this.svgEl.appendChild(this.diamondGroup);
    this.svgEl.appendChild(this.playheadEl);
    this.svgEl.appendChild(this.emptyLabel);

    // ── Styles ─────────────────────────────────────────────────────────────
    this.injectStyles();

    // ── Resize handle interaction ──────────────────────────────────────────
    this.wireResizeHandle();

    parentEl.appendChild(this.container);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get visible(): boolean {
    return this._visible;
  }

  show(clip: Clip, trackProperty: string): void {
    this.currentClip = clip;
    this.selectedKfIndex = -1;

    // Find the track for the given property
    const track = clip.keyframeTracks.find(kt => kt.property === trackProperty) ?? null;
    this.currentTrack = track;

    this._visible = true;
    this.container.style.display = 'block';

    this.renderPropertyList(clip, trackProperty);
    this.renderSvg();
  }

  hide(): void {
    this._visible = false;
    this.container.style.display = 'none';
  }

  refresh(): void {
    if (!this._visible) return;
    this.renderSvg();
  }

  // ── Private: property list ─────────────────────────────────────────────────

  private renderPropertyList(clip: Clip, selectedProperty: string): void {
    this.propertyList.innerHTML = '';

    if (clip.keyframeTracks.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No keyframes';
      Object.assign(empty.style, { color: TEXT_DIM, fontSize: '11px', padding: '8px' });
      this.propertyList.appendChild(empty);
      return;
    }

    for (const track of clip.keyframeTracks) {
      const item = document.createElement('div');
      item.className = 'graph-editor-property-item';
      item.textContent = this.formatPropertyLabel(track.property);
      item.title = track.property;

      const isSelected = track.property === selectedProperty;
      Object.assign(item.style, {
        padding:    '6px 8px',
        fontSize:   '11px',
        cursor:     'pointer',
        color:      PROPERTY_TEXT,
        background: isSelected ? PROPERTY_SEL_BG : 'transparent',
        whiteSpace: 'nowrap',
        overflow:   'hidden',
        textOverflow: 'ellipsis',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      });

      item.addEventListener('click', () => {
        if (!this.currentClip) return;
        this.currentTrack = track;
        this.selectedKfIndex = -1;
        this.renderPropertyList(this.currentClip, track.property);
        this.renderSvg();
      });

      this.propertyList.appendChild(item);
    }
  }

  // ── Private: SVG rendering ────────────────────────────────────────────────

  private renderSvg(): void {
    // Clear all groups
    this.gridGroup.innerHTML       = '';
    this.curveGroup.innerHTML      = '';
    this.handleLineGroup.innerHTML = '';
    this.handleGroup.innerHTML     = '';
    this.diamondGroup.innerHTML    = '';

    const svgRect = this.svgEl.getBoundingClientRect();
    const w = svgRect.width  || this.svgEl.clientWidth  || 400;
    const h = svgRect.height || this.svgEl.clientHeight || (this._height - 6);

    if (!this.currentTrack || !this.currentClip || this.currentTrack.keyframes.length === 0) {
      this.renderEmpty(w, h);
      return;
    }

    this.playheadEl.style.display = '';
    this.emptyLabel.style.display = 'none';

    const kfs = this.currentTrack.keyframes;

    // ── Value axis: auto-scale ─────────────────────────────────────────────
    const { minV, maxV } = this.getValueRange(kfs, h);

    // ── Grid ──────────────────────────────────────────────────────────────
    this.drawGrid(w, h, minV, maxV);

    // ── Curves ────────────────────────────────────────────────────────────
    for (let i = 0; i < kfs.length - 1; i++) {
      this.drawCurveSegment(kfs[i], kfs[i + 1], w, h, minV, maxV);
    }

    // ── Keyframe diamonds and handles ─────────────────────────────────────
    for (let i = 0; i < kfs.length; i++) {
      this.drawKeyframeMarker(kfs, i, w, h, minV, maxV);
    }

    // ── Playhead ──────────────────────────────────────────────────────────
    const playheadX = this.timeToSvgX(this.timelineState.playheadTime, w);
    this.playheadEl.setAttribute('x1', String(playheadX));
    this.playheadEl.setAttribute('y1', '0');
    this.playheadEl.setAttribute('x2', String(playheadX));
    this.playheadEl.setAttribute('y2', String(h));
  }

  private renderEmpty(w: number, h: number): void {
    this.playheadEl.style.display = 'none';

    this.emptyLabel.style.display = '';
    this.emptyLabel.setAttribute('x', String(w / 2));
    this.emptyLabel.setAttribute('y', String(h / 2));
    this.emptyLabel.setAttribute('text-anchor', 'middle');
    this.emptyLabel.setAttribute('fill', TEXT_DIM);
    this.emptyLabel.setAttribute('font-size', '12');
    this.emptyLabel.textContent = 'No keyframes in selected track';

    // Still draw playhead
    const playheadX = this.timeToSvgX(this.timelineState.playheadTime, w);
    this.playheadEl.style.display = '';
    this.playheadEl.setAttribute('x1', String(playheadX));
    this.playheadEl.setAttribute('y1', '0');
    this.playheadEl.setAttribute('x2', String(playheadX));
    this.playheadEl.setAttribute('y2', String(h));
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────

  /** Timeline time → SVG X pixel, accounting for clip start, scroll, zoom. */
  private timeToSvgX(time: number, _w: number): number {
    const { scrollX, zoom } = this.timelineState;
    const absTime = this.currentClip
      ? this.currentClip.timelineStart + time
      : time;
    return (absTime - scrollX) * zoom;
  }

  /** Keyframe t (clip-relative) → SVG X pixel. */
  private kfTimeToSvgX(kfT: number, _w: number): number {
    const { scrollX, zoom } = this.timelineState;
    const absTime = (this.currentClip?.timelineStart ?? 0) + kfT;
    return (absTime - scrollX) * zoom;
  }

  /** SVG X pixel → keyframe t (clip-relative). */
  private svgXToKfTime(x: number): number {
    const { scrollX, zoom } = this.timelineState;
    const absTime = x / zoom + scrollX;
    return absTime - (this.currentClip?.timelineStart ?? 0);
  }

  /** Value → SVG Y pixel (inverted: higher value = smaller Y). */
  private valueToSvgY(value: number, h: number, minV: number, maxV: number): number {
    const range = maxV - minV || 1;
    return h - ((value - minV) / range) * h;
  }

  /** SVG Y pixel → value. */
  private svgYToValue(y: number, h: number, minV: number, maxV: number): number {
    const range = maxV - minV || 1;
    return minV + ((h - y) / h) * range;
  }

  /** Compute the padded value range for the Y axis. */
  private getValueRange(kfs: Keyframe[], h: number): { minV: number; maxV: number } {
    let minV = Infinity;
    let maxV = -Infinity;
    for (const kf of kfs) {
      if (kf.value < minV) minV = kf.value;
      if (kf.value > maxV) maxV = kf.value;
    }
    if (minV === maxV) {
      minV -= 0.5;
      maxV += 0.5;
    }
    const range = maxV - minV;
    minV -= range * VALUE_PADDING;
    maxV += range * VALUE_PADDING;
    void h;
    return { minV, maxV };
  }

  // ── Grid drawing ──────────────────────────────────────────────────────────

  private drawGrid(w: number, h: number, minV: number, maxV: number): void {
    // Horizontal value lines (roughly 5 lines)
    const valueRange = maxV - minV;
    const rawStep = valueRange / 5;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = Math.ceil(rawStep / magnitude) * magnitude;

    const startV = Math.ceil(minV / step) * step;
    for (let v = startV; v <= maxV + step * 0.001; v += step) {
      const y = this.valueToSvgY(v, h, minV, maxV);
      const line = svgEl('line');
      line.setAttribute('x1', '0');
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(w));
      line.setAttribute('y2', String(y));
      line.setAttribute('stroke', GRID_COLOR);
      line.setAttribute('stroke-width', '1');
      this.gridGroup.appendChild(line);

      // Value label
      const label = svgEl('text');
      label.setAttribute('x', '4');
      label.setAttribute('y', String(Math.max(12, y - 2)));
      label.setAttribute('fill', TEXT_DIM);
      label.setAttribute('font-size', '10');
      label.textContent = v.toFixed(Math.abs(step) < 1 ? 2 : 1);
      this.gridGroup.appendChild(label);
    }

    // Vertical time lines — use same interval logic as timeline ruler
    const { scrollX, zoom } = this.timelineState;
    const viewStart = scrollX;
    const viewEnd   = scrollX + w / zoom;
    const timeRange = viewEnd - viewStart;
    const rawTimeStep = timeRange / 8;
    const timeMag  = Math.pow(10, Math.floor(Math.log10(rawTimeStep)));
    const timeStep = Math.ceil(rawTimeStep / timeMag) * timeMag;
    const startT   = Math.ceil(viewStart / timeStep) * timeStep;

    for (let t = startT; t <= viewEnd; t += timeStep) {
      const x = (t - scrollX) * zoom;
      const line = svgEl('line');
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(h));
      line.setAttribute('stroke', GRID_COLOR);
      line.setAttribute('stroke-width', '1');
      this.gridGroup.appendChild(line);
    }
  }

  // ── Curve segment ─────────────────────────────────────────────────────────

  private drawCurveSegment(
    kf0: Keyframe,
    kf1: Keyframe,
    w: number,
    h: number,
    minV: number,
    maxV: number,
  ): void {
    const x0 = this.kfTimeToSvgX(kf0.t, w);
    const y0 = this.valueToSvgY(kf0.value, h, minV, maxV);
    const x1 = this.kfTimeToSvgX(kf1.t, w);
    const y1 = this.valueToSvgY(kf1.value, h, minV, maxV);

    let d: string;

    if (kf0.interpolation === 'hold') {
      // Step: hold value until next keyframe
      d = `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1}`;
    } else if (kf0.interpolation === 'linear') {
      d = `M ${x0} ${y0} L ${x1} ${y1}`;
    } else {
      // Bezier: compute control points from handleOut / handleIn offsets
      // handleOut of kf0 is [dt, dv] offset → absolute position in time/value space
      const dt = kf1.t - kf0.t; // time span for this segment

      // Control point 1: kf0 position + handleOut offset
      // handleOut[0] is time offset (clamped to [0,1] range → in seconds)
      const cp1t = kf0.t + kf0.handleOut[0] * dt;
      const cp1v = kf0.value + kf0.handleOut[1];
      const cp1x = this.kfTimeToSvgX(cp1t, w);
      const cp1y = this.valueToSvgY(cp1v, h, minV, maxV);

      // Control point 2: kf1 position + handleIn offset (handleIn is offset from kf1)
      const cp2t = kf1.t + kf1.handleIn[0] * dt;
      const cp2v = kf1.value + kf1.handleIn[1];
      const cp2x = this.kfTimeToSvgX(cp2t, w);
      const cp2y = this.valueToSvgY(cp2v, h, minV, maxV);

      d = `M ${x0} ${y0} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${x1} ${y1}`;
    }

    const path = svgEl('path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', CURVE_COLOR);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    this.curveGroup.appendChild(path);
  }

  // ── Keyframe marker (diamond + handles) ───────────────────────────────────

  private drawKeyframeMarker(
    kfs: Keyframe[],
    index: number,
    w: number,
    h: number,
    minV: number,
    maxV: number,
  ): void {
    const kf = kfs[index];
    const x = this.kfTimeToSvgX(kf.t, w);
    const y = this.valueToSvgY(kf.value, h, minV, maxV);

    const isSelected = index === this.selectedKfIndex;
    const size = isSelected ? 7 : 5;
    const fill = isSelected ? DIAMOND_SELECTED : DIAMOND_COLOR;

    // Bezier handles (only for bezier interpolation)
    if (kf.interpolation === 'bezier') {
      // Determine segment durations for scaling handle offsets
      const prevKf = index > 0 ? kfs[index - 1] : null;
      const nextKf = index < kfs.length - 1 ? kfs[index + 1] : null;

      // handleOut (right handle)
      if (nextKf !== null) {
        const dt = nextKf.t - kf.t;
        const hOutT = kf.t + kf.handleOut[0] * dt;
        const hOutV = kf.value + kf.handleOut[1];
        const hx = this.kfTimeToSvgX(hOutT, w);
        const hy = this.valueToSvgY(hOutV, h, minV, maxV);

        // Handle line
        const line = svgEl('line');
        line.setAttribute('x1', String(x));  line.setAttribute('y1', String(y));
        line.setAttribute('x2', String(hx)); line.setAttribute('y2', String(hy));
        line.setAttribute('stroke', HANDLE_LINE_COLOR);
        line.setAttribute('stroke-width', '1');
        this.handleLineGroup.appendChild(line);

        // Handle circle
        const circle = svgEl('circle');
        circle.setAttribute('cx', String(hx));
        circle.setAttribute('cy', String(hy));
        circle.setAttribute('r', '5');
        circle.setAttribute('fill', HANDLE_COLOR);
        circle.setAttribute('cursor', 'grab');
        circle.dataset.kfIndex = String(index);
        circle.dataset.handle  = 'out';
        this.wireHandleDrag(circle, index, 'out', kfs, w, h, minV, maxV);
        this.handleGroup.appendChild(circle);
      }

      // handleIn (left handle)
      if (prevKf !== null) {
        const dt = kf.t - prevKf.t;
        const hInT = kf.t + kf.handleIn[0] * dt;
        const hInV = kf.value + kf.handleIn[1];
        const hx = this.kfTimeToSvgX(hInT, w);
        const hy = this.valueToSvgY(hInV, h, minV, maxV);

        // Handle line
        const line = svgEl('line');
        line.setAttribute('x1', String(x));  line.setAttribute('y1', String(y));
        line.setAttribute('x2', String(hx)); line.setAttribute('y2', String(hy));
        line.setAttribute('stroke', HANDLE_LINE_COLOR);
        line.setAttribute('stroke-width', '1');
        this.handleLineGroup.appendChild(line);

        // Handle circle
        const circle = svgEl('circle');
        circle.setAttribute('cx', String(hx));
        circle.setAttribute('cy', String(hy));
        circle.setAttribute('r', '5');
        circle.setAttribute('fill', HANDLE_COLOR);
        circle.setAttribute('cursor', 'grab');
        circle.dataset.kfIndex = String(index);
        circle.dataset.handle  = 'in';
        this.wireHandleDrag(circle, index, 'in', kfs, w, h, minV, maxV);
        this.handleGroup.appendChild(circle);
      }
    }

    // Diamond polygon
    const diamond = svgEl('polygon');
    const pts = [
      `${x},${y - size}`,
      `${x + size},${y}`,
      `${x},${y + size}`,
      `${x - size},${y}`,
    ].join(' ');
    diamond.setAttribute('points', pts);
    diamond.setAttribute('fill', fill);
    diamond.setAttribute('cursor', 'grab');
    diamond.dataset.kfIndex = String(index);
    this.wireKeyframeDrag(diamond, index, kfs, w, h, minV, maxV);
    this.diamondGroup.appendChild(diamond);
  }

  // ── Pointer-capture drag: bezier handle ───────────────────────────────────

  private wireHandleDrag(
    circle: SVGCircleElement,
    kfIndex: number,
    handle: 'in' | 'out',
    kfs: Keyframe[],
    w: number,
    h: number,
    minV: number,
    maxV: number,
  ): void {
    circle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      circle.setPointerCapture(e.pointerId);

      const kf = kfs[kfIndex];
      const prevKf = handle === 'in'  && kfIndex > 0 ? kfs[kfIndex - 1] : null;
      const nextKf = handle === 'out' && kfIndex < kfs.length - 1 ? kfs[kfIndex + 1] : null;
      const refKf  = handle === 'in' ? prevKf : nextKf;

      const onMove = (ev: PointerEvent) => {
        const svgPoint = this.clientToSvg(ev.clientX, ev.clientY);
        if (!svgPoint) return;

        const newT = this.svgXToKfTime(svgPoint.x);
        const newV = this.svgYToValue(svgPoint.y, h, minV, maxV);

        if (handle === 'out' && refKf) {
          // dt of this segment
          const segDt = refKf.t - kf.t;
          const rawDt = newT - kf.t;
          // Normalize and clamp time component to [0, 1] (Pitfall 6 from research)
          const normDt = segDt !== 0 ? rawDt / segDt : 0;
          kf.handleOut = [Math.max(0, Math.min(1, normDt)), newV - kf.value];
        } else if (handle === 'in' && refKf) {
          const segDt = kf.t - refKf.t;
          const rawDt = newT - kf.t;
          const normDt = segDt !== 0 ? rawDt / segDt : 0;
          // handleIn offset is typically negative dt (pointing left)
          kf.handleIn = [Math.max(-1, Math.min(0, normDt)), newV - kf.value];
        }

        this.renderSvg();
      };

      const onUp = () => {
        circle.removeEventListener('pointermove', onMove);
        circle.removeEventListener('pointerup', onUp);
        circle.removeEventListener('pointercancel', onUp);
        this.onChange();
      };

      circle.addEventListener('pointermove', onMove);
      circle.addEventListener('pointerup',   onUp);
      circle.addEventListener('pointercancel', onUp);
    });
  }

  // ── Pointer-capture drag: keyframe diamond ────────────────────────────────

  private wireKeyframeDrag(
    diamond: SVGPolygonElement,
    kfIndex: number,
    kfs: Keyframe[],
    w: number,
    h: number,
    minV: number,
    maxV: number,
  ): void {
    diamond.addEventListener('pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      diamond.setPointerCapture(e.pointerId);

      this.selectedKfIndex = kfIndex;
      this.renderSvg();

      const onMove = (ev: PointerEvent) => {
        const svgPoint = this.clientToSvg(ev.clientX, ev.clientY);
        if (!svgPoint) return;

        const newT = this.svgXToKfTime(svgPoint.x);
        const newV = this.svgYToValue(svgPoint.y, h, minV, maxV);

        // Clamp time so keyframe cannot pass its neighbors
        const prevT = kfIndex > 0 ? kfs[kfIndex - 1].t : -Infinity;
        const nextT = kfIndex < kfs.length - 1 ? kfs[kfIndex + 1].t : Infinity;
        const clampedT = Math.max(prevT + 0.001, Math.min(nextT - 0.001, newT));

        kfs[kfIndex].t     = clampedT;
        kfs[kfIndex].value = newV;

        this.renderSvg();
      };

      const onUp = () => {
        diamond.removeEventListener('pointermove', onMove);
        diamond.removeEventListener('pointerup', onUp);
        diamond.removeEventListener('pointercancel', onUp);
        // Re-sort keyframes by t to maintain invariant
        if (this.currentTrack) {
          this.currentTrack.keyframes.sort((a, b) => a.t - b.t);
        }
        this.onChange();
        this.renderSvg();
      };

      diamond.addEventListener('pointermove', onMove);
      diamond.addEventListener('pointerup',   onUp);
      diamond.addEventListener('pointercancel', onUp);
    });
  }

  // ── Resize handle interaction ─────────────────────────────────────────────

  private wireResizeHandle(): void {
    this.resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      this.resizeHandle.setPointerCapture(e.pointerId);

      const startY      = e.clientY;
      const startHeight = this._height;

      const onMove = (ev: PointerEvent) => {
        // Dragging UP reduces height (panel shrinks), dragging DOWN increases it
        const delta = startY - ev.clientY;
        const newH  = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta));
        this._height = newH;
        this.container.style.height = `${newH}px`;
        this.renderSvg();
      };

      const onUp = () => {
        this.resizeHandle.removeEventListener('pointermove', onMove);
        this.resizeHandle.removeEventListener('pointerup', onUp);
        this.resizeHandle.removeEventListener('pointercancel', onUp);
      };

      this.resizeHandle.addEventListener('pointermove', onMove);
      this.resizeHandle.addEventListener('pointerup',   onUp);
      this.resizeHandle.addEventListener('pointercancel', onUp);
    });
  }

  // ── Coordinate conversion: client → SVG local ─────────────────────────────

  private clientToSvg(clientX: number, clientY: number): { x: number; y: number } | null {
    const ctm = this.svgEl.getScreenCTM();
    if (!ctm) return null;
    const inv = ctm.inverse();
    const pt  = this.svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const transformed = pt.matrixTransform(inv);
    return { x: transformed.x, y: transformed.y };
  }

  // ── Label formatter ───────────────────────────────────────────────────────

  private formatPropertyLabel(property: string): string {
    // property is "<effectId>.<fieldName>" — show only fieldName
    const dot = property.lastIndexOf('.');
    if (dot !== -1) return property.slice(dot + 1);
    return property;
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  private injectStyles(): void {
    const styleId = 'graph-editor-panel-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .graph-editor-panel {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .graph-editor-resize-handle:hover {
        background: rgba(255,255,255,0.1);
      }
      .graph-editor-property-item:hover {
        background: ${PROPERTY_SEL_BG} !important;
      }
    `;
    document.head.appendChild(style);
  }
}
