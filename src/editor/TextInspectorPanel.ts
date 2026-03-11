// ── TextInspectorPanel ─────────────────────────────────────────────────────────
// Inspector panel UI for a selected TextClip.
// Provides: font picker, size, color, opacity, alignment, position, and preset controls.

import type { TextClip } from './TextClip.ts';
import { TEXT_PRESETS, applyTextPreset, type TextPreset } from './TextPresets.ts';
import { fetchFontsourceList, loadFontsourceFont, type FontEntry } from './FontPicker.ts';

// ── Styles ────────────────────────────────────────────────────────────────────

const LABEL_STYLE =
  'display:block;font-size:11px;color:#aaa;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em';

const SECTION_STYLE =
  'margin-bottom:12px';

const INPUT_STYLE =
  'width:100%;box-sizing:border-box;background:#2a2a2a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-size:13px';

const SELECT_STYLE = INPUT_STYLE;

const NUMBER_STYLE =
  'width:100%;box-sizing:border-box;background:#2a2a2a;border:1px solid #444;color:#eee;padding:4px 6px;border-radius:4px;font-size:13px';

const BTN_STYLE =
  'flex:1;background:#2a2a2a;border:1px solid #444;color:#eee;padding:4px;border-radius:4px;cursor:pointer;font-size:13px';

const BTN_ACTIVE_STYLE =
  'flex:1;background:#4a90d9;border:1px solid #4a90d9;color:#fff;padding:4px;border-radius:4px;cursor:pointer;font-size:13px';

const ROW_STYLE =
  'display:flex;gap:6px';

// ── TextInspectorPanel ────────────────────────────────────────────────────────

export class TextInspectorPanel {
  private container: HTMLElement;
  private onChange: (clip: TextClip) => void;
  private projectWidth: number;

  // Track font list load state
  private fontListLoaded = false;
  private fontEntries: FontEntry[] = [];

  // Weak refs to current inputs for update()
  private inputs: {
    fontInput?:   HTMLInputElement;
    weightSel?:   HTMLSelectElement;
    styleSel?:    HTMLSelectElement;
    sizeSel?:     HTMLInputElement;
    colorInput?:  HTMLInputElement;
    opacityInput?: HTMLInputElement;
    xInput?:      HTMLInputElement;
    yInput?:      HTMLInputElement;
    alignBtns?:   HTMLButtonElement[];
    presetSel?:   HTMLSelectElement;
  } = {};

  constructor(
    container: HTMLElement,
    onChange: (clip: TextClip) => void,
    projectWidth = 1920,
  ) {
    this.container   = container;
    this.onChange    = onChange;
    this.projectWidth = projectWidth;
  }

  // ── show ──────────────────────────────────────────────────────────────────

  show(clip: TextClip): void {
    this.container.innerHTML = '';
    this.inputs = {};

    const panel = document.createElement('div');
    panel.style.cssText = 'padding:12px;color:#eee;font-family:sans-serif';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:bold;color:#ccc;margin-bottom:14px;border-bottom:1px solid #333;padding-bottom:8px';
    title.textContent = 'Text Clip';
    panel.appendChild(title);

    // Content (editable textarea)
    panel.appendChild(this._section('Content', (() => {
      const textarea = document.createElement('textarea');
      textarea.style.cssText =
        INPUT_STYLE + ';resize:vertical;min-height:40px;max-height:80px;font-size:13px;white-space:pre-wrap';
      textarea.value = clip.content || '';
      textarea.placeholder = 'Enter text...';
      textarea.rows = 2;
      textarea.addEventListener('input', () => {
        clip.content = textarea.value;
        this.onChange(clip);
      });
      return textarea;
    })()));

    // Font family + datalist
    panel.appendChild(this._section('Font Family', (() => {
      const fontInput = document.createElement('input');
      fontInput.type = 'text';
      fontInput.value = clip.style.fontFamily;
      fontInput.style.cssText = INPUT_STYLE;
      fontInput.setAttribute('list', '__tip-font-datalist__');

      const datalist = document.createElement('datalist');
      datalist.id = '__tip-font-datalist__';
      fontInput.appendChild(datalist);

      // Load font list lazily on first show
      if (!this.fontListLoaded) {
        this.fontListLoaded = true;
        fetchFontsourceList().then(entries => {
          this.fontEntries = entries;
          datalist.innerHTML = '';
          for (const fe of entries.slice(0, 500)) {
            const opt = document.createElement('option');
            opt.value = fe.family;
            datalist.appendChild(opt);
          }
        }).catch(() => {/* network error — degrade gracefully */});
      } else {
        for (const fe of this.fontEntries.slice(0, 500)) {
          const opt = document.createElement('option');
          opt.value = fe.family;
          datalist.appendChild(opt);
        }
      }

      const wrapper = document.createDocumentFragment();
      wrapper.appendChild(fontInput);
      wrapper.appendChild(datalist);

      fontInput.addEventListener('change', () => {
        const family = fontInput.value.trim();
        if (!family) return;
        // Find fontId from entries list (lowercase family match)
        const entry = this.fontEntries.find(
          fe => fe.family.toLowerCase() === family.toLowerCase(),
        );
        const fontId = entry?.id ?? family.toLowerCase().replace(/\s+/g, '-');
        const weight = clip.style.fontWeight;
        const style  = clip.style.fontStyle;
        loadFontsourceFont(fontId, family, weight, style).catch(() => {/* best-effort */});
        clip.style.fontFamily = family;
        this.onChange(clip);
      });

      this.inputs.fontInput = fontInput;

      const div = document.createElement('div');
      div.appendChild(fontInput);
      div.appendChild(datalist);
      return div;
    })()));

    // Font weight + style in a row
    panel.appendChild(this._section('Weight / Style', (() => {
      const weightSel = document.createElement('select');
      weightSel.style.cssText = SELECT_STYLE + ';width:48%;margin-right:4%';
      for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        const opt = document.createElement('option');
        opt.value = String(w);
        opt.textContent = String(w);
        if (clip.style.fontWeight === w) opt.selected = true;
        weightSel.appendChild(opt);
      }
      weightSel.addEventListener('change', () => {
        clip.style.fontWeight = Number(weightSel.value);
        this.onChange(clip);
      });

      const styleSel = document.createElement('select');
      styleSel.style.cssText = SELECT_STYLE + ';width:48%';
      for (const s of ['normal', 'italic'] as const) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (clip.style.fontStyle === s) opt.selected = true;
        styleSel.appendChild(opt);
      }
      styleSel.addEventListener('change', () => {
        clip.style.fontStyle = styleSel.value as 'normal' | 'italic';
        this.onChange(clip);
      });

      this.inputs.weightSel = weightSel;
      this.inputs.styleSel  = styleSel;

      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;
      row.appendChild(weightSel);
      row.appendChild(styleSel);
      return row;
    })()));

    // Font size
    panel.appendChild(this._section('Font Size (px)', (() => {
      const sizeInput = document.createElement('input');
      sizeInput.type = 'number';
      sizeInput.min  = '8';
      sizeInput.max  = '200';
      sizeInput.step = '1';
      sizeInput.value = String(clip.style.fontSize);
      sizeInput.style.cssText = NUMBER_STYLE;
      sizeInput.addEventListener('input', () => {
        const v = Number(sizeInput.value);
        if (v >= 8 && v <= 200) {
          clip.style.fontSize = v;
          this.onChange(clip);
        }
      });
      this.inputs.sizeSel = sizeInput;
      return sizeInput;
    })()));

    // Color
    panel.appendChild(this._section('Color', (() => {
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = clip.style.color;
      colorInput.style.cssText = 'width:100%;height:32px;border:none;background:transparent;cursor:pointer';
      colorInput.addEventListener('input', () => {
        clip.style.color = colorInput.value;
        this.onChange(clip);
      });
      this.inputs.colorInput = colorInput;
      return colorInput;
    })()));

    // Opacity
    panel.appendChild(this._section('Opacity', (() => {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE + ';align-items:center';

      const opacityInput = document.createElement('input');
      opacityInput.type  = 'range';
      opacityInput.min   = '0';
      opacityInput.max   = '1';
      opacityInput.step  = '0.01';
      opacityInput.value = String(clip.style.opacity);
      opacityInput.style.cssText = 'flex:1';

      const opacityLabel = document.createElement('span');
      opacityLabel.style.cssText = 'font-size:12px;color:#aaa;min-width:36px;text-align:right';
      opacityLabel.textContent = Math.round(clip.style.opacity * 100) + '%';

      opacityInput.addEventListener('input', () => {
        const v = Number(opacityInput.value);
        clip.style.opacity = v;
        opacityLabel.textContent = Math.round(v * 100) + '%';
        this.onChange(clip);
      });

      this.inputs.opacityInput = opacityInput;
      row.appendChild(opacityInput);
      row.appendChild(opacityLabel);
      return row;
    })()));

    // Alignment
    panel.appendChild(this._section('Alignment', (() => {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;

      const alignBtns: HTMLButtonElement[] = [];
      for (const align of ['left', 'center', 'right'] as const) {
        const btn = document.createElement('button');
        btn.textContent = align.charAt(0).toUpperCase() + align.slice(1);
        btn.style.cssText = clip.style.align === align ? BTN_ACTIVE_STYLE : BTN_STYLE;
        btn.addEventListener('click', () => {
          clip.style.align = align;
          for (const b of alignBtns) b.style.cssText = BTN_STYLE;
          btn.style.cssText = BTN_ACTIVE_STYLE;
          this.onChange(clip);
        });
        alignBtns.push(btn);
        row.appendChild(btn);
      }
      this.inputs.alignBtns = alignBtns;
      return row;
    })()));

    // Position X / Y
    panel.appendChild(this._section('Position (X / Y)', (() => {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;

      const xInput = document.createElement('input');
      xInput.type  = 'number';
      xInput.value = String(Math.round(clip.x));
      xInput.style.cssText = NUMBER_STYLE + ';width:48%;margin-right:4%';
      xInput.placeholder = 'X';
      xInput.addEventListener('input', () => {
        clip.x = Number(xInput.value);
        this.onChange(clip);
      });

      const yInput = document.createElement('input');
      yInput.type  = 'number';
      yInput.value = String(Math.round(clip.y));
      yInput.style.cssText = NUMBER_STYLE + ';width:48%';
      yInput.placeholder = 'Y';
      yInput.addEventListener('input', () => {
        clip.y = Number(yInput.value);
        this.onChange(clip);
      });

      this.inputs.xInput = xInput;
      this.inputs.yInput = yInput;
      row.appendChild(xInput);
      row.appendChild(yInput);
      return row;
    })()));

    // Preset
    panel.appendChild(this._section('Animation Preset', (() => {
      const presetSel = document.createElement('select');
      presetSel.style.cssText = SELECT_STYLE;

      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'None';
      presetSel.appendChild(noneOpt);

      for (const preset of TEXT_PRESETS) {
        const opt = document.createElement('option');
        opt.value = preset;
        opt.textContent = preset;
        presetSel.appendChild(opt);
      }

      presetSel.addEventListener('change', () => {
        const val = presetSel.value as TextPreset | '';
        if (val === '') {
          // Clear preset-owned tracks (opacity, x, charReveal)
          const PRESET_PROPS = new Set(['opacity', 'x', 'charReveal']);
          clip.keyframeTracks = clip.keyframeTracks.filter(
            t => !PRESET_PROPS.has(t.property),
          );
        } else {
          applyTextPreset(clip, val, this.projectWidth);
        }
        this.onChange(clip);
      });

      this.inputs.presetSel = presetSel;
      return presetSel;
    })()));

    this.container.appendChild(panel);
  }

  // ── hide ──────────────────────────────────────────────────────────────────

  hide(): void {
    this.container.innerHTML = '';
    this.inputs = {};
  }

  // ── update ────────────────────────────────────────────────────────────────

  update(clip: TextClip): void {
    const { fontInput, weightSel, styleSel, sizeSel, colorInput, opacityInput, xInput, yInput, alignBtns, presetSel } = this.inputs;
    if (fontInput)    fontInput.value    = clip.style.fontFamily;
    if (weightSel)    weightSel.value    = String(clip.style.fontWeight);
    if (styleSel)     styleSel.value     = clip.style.fontStyle;
    if (sizeSel)      sizeSel.value      = String(clip.style.fontSize);
    if (colorInput)   colorInput.value   = clip.style.color;
    if (opacityInput) opacityInput.value = String(clip.style.opacity);
    if (xInput)       xInput.value       = String(Math.round(clip.x));
    if (yInput)       yInput.value       = String(Math.round(clip.y));
    if (alignBtns) {
      for (const btn of alignBtns) {
        const align = btn.textContent?.toLowerCase() as 'left' | 'center' | 'right';
        btn.style.cssText = clip.style.align === align ? BTN_ACTIVE_STYLE : BTN_STYLE;
      }
    }
    void presetSel; // preset sel doesn't need external update
  }

  // ── _section helper ───────────────────────────────────────────────────────

  private _section(labelText: string, content: HTMLElement | DocumentFragment): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText = SECTION_STYLE;

    const label = document.createElement('label');
    label.style.cssText = LABEL_STYLE;
    label.textContent = labelText;

    section.appendChild(label);
    section.appendChild(content);
    return section;
  }
}
