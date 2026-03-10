// ── ColorGradingPanel ─────────────────────────────────────────────────────────
// Renders the inspector panel content for a selected clip.
// Features:
//   • "Add Effect" dropdown for all effect types
//   • Per-effect collapsible sections with properly-bounded sliders
//   • ColorCorrect: grouped Basic / 3-Way sections
//   • LUT: .cube file import button + opacity slider
//   • Remove-effect button per section
//   • onChange callback fires after every mutation so caller can update engine

import type {
  Clip,
  Effect,
  ColorCorrectParams,
  BlurParams,
  SharpenParams,
  VignetteParams,
  TransformParams,
  LutParams,
} from './types.ts';
import {
  createColorCorrectEffect,
  createBlurEffect,
  createSharpenEffect,
  createVignetteEffect,
  createTransformEffect,
} from './types.ts';
import { loadCubeLutFile } from './LutParser.ts';

export type PanelChangeCallback = (clip: Clip) => void;

// ── Param metadata ────────────────────────────────────────────────────────────

interface ParamMeta {
  label: string;
  min: number;
  max: number;
  step: number;
}

const COLOR_CORRECT_BASIC: Record<string, ParamMeta> = {
  brightness:  { label: 'Brightness',  min: -1,   max: 1,   step: 0.01 },
  contrast:    { label: 'Contrast',    min: -1,   max: 1,   step: 0.01 },
  saturation:  { label: 'Saturation',  min: -1,   max: 1,   step: 0.01 },
  hue:         { label: 'Hue',         min: -180, max: 180, step: 1    },
  temperature: { label: 'Temperature', min: -1,   max: 1,   step: 0.01 },
  tint:        { label: 'Tint',        min: -1,   max: 1,   step: 0.01 },
};

const COLOR_CORRECT_LIFT: Record<string, ParamMeta> = {
  liftR: { label: 'Lift R', min: -1, max: 1, step: 0.01 },
  liftG: { label: 'Lift G', min: -1, max: 1, step: 0.01 },
  liftB: { label: 'Lift B', min: -1, max: 1, step: 0.01 },
};

const COLOR_CORRECT_GAMMA: Record<string, ParamMeta> = {
  gammaR: { label: 'Gamma R', min: 0.1, max: 4, step: 0.01 },
  gammaG: { label: 'Gamma G', min: 0.1, max: 4, step: 0.01 },
  gammaB: { label: 'Gamma B', min: 0.1, max: 4, step: 0.01 },
};

const COLOR_CORRECT_GAIN: Record<string, ParamMeta> = {
  gainR: { label: 'Gain R', min: 0, max: 4, step: 0.01 },
  gainG: { label: 'Gain G', min: 0, max: 4, step: 0.01 },
  gainB: { label: 'Gain B', min: 0, max: 4, step: 0.01 },
};

const BLUR_PARAMS: Record<string, ParamMeta> = {
  radius: { label: 'Radius', min: 0, max: 50, step: 0.5 },
};

const SHARPEN_PARAMS: Record<string, ParamMeta> = {
  amount: { label: 'Amount', min: 0, max: 2, step: 0.01 },
};

const VIGNETTE_PARAMS: Record<string, ParamMeta> = {
  strength:  { label: 'Strength',  min: 0, max: 1, step: 0.01 },
  midpoint:  { label: 'Midpoint',  min: 0, max: 1, step: 0.01 },
  roundness: { label: 'Roundness', min: 0, max: 1, step: 0.01 },
  feather:   { label: 'Feather',   min: 0, max: 1, step: 0.01 },
};

const TRANSFORM_PARAMS: Record<string, ParamMeta> = {
  x:        { label: 'X Offset',  min: -3840, max: 3840, step: 1    },
  y:        { label: 'Y Offset',  min: -2160, max: 2160, step: 1    },
  scaleX:   { label: 'Scale X',   min: 0.01,  max: 4,    step: 0.01 },
  scaleY:   { label: 'Scale Y',   min: 0.01,  max: 4,    step: 0.01 },
  rotation: { label: 'Rotation',  min: -180,  max: 180,  step: 0.5  },
  anchorX:  { label: 'Anchor X',  min: 0,     max: 1,    step: 0.01 },
  anchorY:  { label: 'Anchor Y',  min: 0,     max: 1,    step: 0.01 },
};

// ── Helper builders ───────────────────────────────────────────────────────────

function makeSliderRow(
  params: Record<string, unknown>,
  key: string,
  meta: ParamMeta,
  onChange: () => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cgp-row';

  const lbl = document.createElement('span');
  lbl.className = 'cgp-label';
  lbl.textContent = meta.label;

  const slider = document.createElement('input');
  slider.type  = 'range';
  slider.className = 'cgp-slider';
  slider.min   = String(meta.min);
  slider.max   = String(meta.max);
  slider.step  = String(meta.step);
  slider.value = String(params[key] ?? 0);

  const valEl = document.createElement('span');
  valEl.className = 'cgp-value';
  valEl.textContent = Number(params[key] ?? 0).toFixed(meta.step < 1 ? 2 : 0);

  slider.addEventListener('input', () => {
    const n = parseFloat(slider.value);
    params[key] = n;
    valEl.textContent = n.toFixed(meta.step < 1 ? 2 : 0);
    onChange();
  });

  row.append(lbl, slider, valEl);
  return row;
}

function makeSubheading(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'cgp-subheading';
  h.textContent = text;
  return h;
}

// ── Effect section builders ───────────────────────────────────────────────────

function buildColorCorrectSection(
  effect: Effect,
  onChange: () => void,
): HTMLElement {
  const p = effect.params as ColorCorrectParams;
  const frag = document.createDocumentFragment();

  frag.appendChild(makeSubheading('Basic'));
  for (const [k, m] of Object.entries(COLOR_CORRECT_BASIC)) {
    frag.appendChild(makeSliderRow(p as unknown as Record<string, unknown>, k, m, onChange));
  }

  frag.appendChild(makeSubheading('Lift (Shadows)'));
  for (const [k, m] of Object.entries(COLOR_CORRECT_LIFT)) {
    frag.appendChild(makeSliderRow(p as unknown as Record<string, unknown>, k, m, onChange));
  }

  frag.appendChild(makeSubheading('Gamma (Midtones)'));
  for (const [k, m] of Object.entries(COLOR_CORRECT_GAMMA)) {
    frag.appendChild(makeSliderRow(p as unknown as Record<string, unknown>, k, m, onChange));
  }

  frag.appendChild(makeSubheading('Gain (Highlights)'));
  for (const [k, m] of Object.entries(COLOR_CORRECT_GAIN)) {
    frag.appendChild(makeSliderRow(p as unknown as Record<string, unknown>, k, m, onChange));
  }

  const wrapper = document.createElement('div');
  wrapper.appendChild(frag);
  return wrapper;
}

function buildLutSection(
  effect: Effect,
  onChange: () => void,
): HTMLElement {
  const p = effect.params as LutParams;
  const wrapper = document.createElement('div');

  // File import row
  const importRow = document.createElement('div');
  importRow.className = 'cgp-row';

  const fileBtn = document.createElement('button');
  fileBtn.className = 'cgp-lut-btn';
  fileBtn.textContent = p.size > 0 ? `LUT loaded (${p.size}³)` : 'Import .cube file…';

  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'file';
  hiddenInput.accept = '.cube';
  hiddenInput.style.display = 'none';

  hiddenInput.addEventListener('change', async () => {
    const file = hiddenInput.files?.[0];
    if (!file) return;
    try {
      const parsed = await loadCubeLutFile(file);
      p.lutData = parsed.lutData;
      p.size    = parsed.size;
      fileBtn.textContent = `${parsed.title || file.name} (${parsed.size}³)`;
      onChange();
    } catch (err) {
      fileBtn.textContent = `Error: ${(err as Error).message}`;
    }
  });

  fileBtn.addEventListener('click', () => hiddenInput.click());
  importRow.append(fileBtn, hiddenInput);
  wrapper.appendChild(importRow);

  // Opacity slider
  wrapper.appendChild(
    makeSliderRow(
      p as unknown as Record<string, unknown>,
      'opacity',
      { label: 'Opacity', min: 0, max: 1, step: 0.01 },
      onChange,
    )
  );

  return wrapper;
}

function buildGenericSection(
  effect: Effect,
  meta: Record<string, ParamMeta>,
  onChange: () => void,
): HTMLElement {
  const wrapper = document.createElement('div');
  const p = effect.params as unknown as Record<string, unknown>;
  for (const [k, m] of Object.entries(meta)) {
    wrapper.appendChild(makeSliderRow(p, k, m, onChange));
  }
  return wrapper;
}

// ── Effect type label ─────────────────────────────────────────────────────────

const EFFECT_LABELS: Record<string, string> = {
  colorCorrect: 'Color Correction',
  lut:          '3D LUT',
  blur:         'Gaussian Blur',
  sharpen:      'Sharpen',
  vignette:     'Vignette',
  transform:    'Transform',
};

// ── Public API ────────────────────────────────────────────────────────────────

export class ColorGradingPanel {
  private container: HTMLElement;
  private onChange: PanelChangeCallback;
  private _clip: Clip | null = null;

  constructor(container: HTMLElement, onChange: PanelChangeCallback) {
    this.container = container;
    this.onChange  = onChange;
  }

  /** Render the panel for the given clip (or show empty state). */
  render(clip: Clip | null): void {
    this._clip = clip;
    this.container.innerHTML = '';

    if (!clip) {
      const p = document.createElement('p');
      p.className = 'cgp-empty';
      p.textContent = 'Select a clip to view and edit its effects.';
      this.container.appendChild(p);
      return;
    }

    // ── Clip Properties card ─────────────────────────────────────────────────
    this.container.appendChild(this.buildPropertiesCard(clip));

    // ── "Add Effect" section ─────────────────────────────────────────────────
    const addRow = document.createElement('div');
    addRow.className = 'cgp-add-row';

    const addLabel = document.createElement('span');
    addLabel.className = 'cgp-add-label';
    addLabel.textContent = 'Add effect:';

    const select = document.createElement('select');
    select.className = 'cgp-add-select';
    for (const [kind, label] of Object.entries(EFFECT_LABELS)) {
      const opt = document.createElement('option');
      opt.value = kind;
      opt.textContent = label;
      select.appendChild(opt);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'cgp-add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      if (!this._clip) return;
      let effect: Effect;
      switch (select.value) {
        case 'colorCorrect': effect = createColorCorrectEffect(); break;
        case 'blur':         effect = createBlurEffect();         break;
        case 'sharpen':      effect = createSharpenEffect();      break;
        case 'vignette':     effect = createVignetteEffect();     break;
        case 'transform':    effect = createTransformEffect();    break;
        case 'lut':
          effect = {
            id: crypto.randomUUID(),
            kind: 'lut',
            enabled: true,
            params: { lutData: new Float32Array(0), size: 0, opacity: 1.0 } satisfies LutParams,
          };
          break;
        default: return;
      }
      this._clip.effects.push(effect);
      this.onChange(this._clip);
      this.render(this._clip);
    });

    addRow.append(addLabel, select, addBtn);
    this.container.appendChild(addRow);

    // ── Effect list ──────────────────────────────────────────────────────────
    if (clip.effects.length === 0) {
      const p = document.createElement('p');
      p.className = 'cgp-empty';
      p.textContent = 'No effects. Use "Add effect" above.';
      this.container.appendChild(p);
      return;
    }

    for (let i = 0; i < clip.effects.length; i++) {
      this.container.appendChild(this.buildEffectCard(clip, i));
    }
  }

  // ── Private: build clip properties card ──────────────────────────────────

  private buildPropertiesCard(clip: Clip): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cgp-card cgp-props-card';

    const header = document.createElement('div');
    header.className = 'cgp-card-header';

    const title = document.createElement('span');
    title.className = 'cgp-card-title';
    title.textContent = 'Clip Properties';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'cgp-collapse-btn';
    collapseBtn.textContent = '▾';
    collapseBtn.title = 'Collapse / expand';

    header.append(title, collapseBtn);

    const body = document.createElement('div');
    body.className = 'cgp-card-body';

    // Source filename (read-only)
    const srcRow = document.createElement('div');
    srcRow.className = 'cgp-row';
    const srcLbl = document.createElement('span');
    srcLbl.className = 'cgp-label';
    srcLbl.textContent = 'Source';
    const srcVal = document.createElement('span');
    srcVal.className = 'cgp-value cgp-value-text';
    srcVal.textContent = clip.sourceFile?.name ?? '—';
    srcVal.title = clip.sourceFile?.name ?? '';
    srcRow.append(srcLbl, srcVal);
    body.appendChild(srcRow);

    // Speed slider
    const onPropChange = () => this.onChange(clip);
    body.appendChild(
      makeSliderRow(
        clip as unknown as Record<string, unknown>,
        'speed',
        { label: 'Speed', min: 0.1, max: 4.0, step: 0.01 },
        onPropChange,
      )
    );

    // Audio gain slider
    body.appendChild(
      makeSliderRow(
        clip as unknown as Record<string, unknown>,
        'audioGain',
        { label: 'Audio Gain', min: 0.0, max: 2.0, step: 0.01 },
        onPropChange,
      )
    );

    // Collapse logic
    let collapsed = false;
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      collapseBtn.textContent = collapsed ? '▸' : '▾';
    });

    card.append(header, body);
    return card;
  }

  // ── Private: build one effect card ────────────────────────────────────────

  private buildEffectCard(clip: Clip, index: number): HTMLElement {
    const effect = clip.effects[index];

    const card = document.createElement('div');
    card.className = 'cgp-card';

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'cgp-card-header';

    // Enable toggle
    const toggle = document.createElement('input');
    toggle.type    = 'checkbox';
    toggle.className = 'cgp-toggle';
    toggle.checked = effect.enabled;
    toggle.title   = 'Enable / disable effect';
    toggle.addEventListener('change', () => {
      effect.enabled = toggle.checked;
      body.style.opacity = toggle.checked ? '' : '0.4';
      this.onChange(clip);
    });

    const title = document.createElement('span');
    title.className = 'cgp-card-title';
    title.textContent = EFFECT_LABELS[effect.kind] ?? effect.kind;

    // Collapse toggle
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'cgp-collapse-btn';
    collapseBtn.textContent = '▾';
    collapseBtn.title = 'Collapse / expand';

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'cgp-remove-btn';
    removeBtn.title = 'Remove effect';
    removeBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    removeBtn.addEventListener('click', () => {
      clip.effects.splice(index, 1);
      this.onChange(clip);
      this.render(clip);
    });

    header.append(toggle, title, collapseBtn, removeBtn);

    // ── Body ────────────────────────────────────────────────────────────────
    const body = document.createElement('div');
    body.className = 'cgp-card-body';
    if (!effect.enabled) body.style.opacity = '0.4';

    const onParamChange = () => this.onChange(clip);

    switch (effect.kind) {
      case 'colorCorrect':
        body.appendChild(buildColorCorrectSection(effect, onParamChange));
        break;
      case 'lut':
        body.appendChild(buildLutSection(effect, onParamChange));
        break;
      case 'blur':
        body.appendChild(buildGenericSection(effect, BLUR_PARAMS, onParamChange));
        break;
      case 'sharpen':
        body.appendChild(buildGenericSection(effect, SHARPEN_PARAMS, onParamChange));
        break;
      case 'vignette':
        body.appendChild(buildGenericSection(effect, VIGNETTE_PARAMS, onParamChange));
        break;
      case 'transform':
        body.appendChild(buildGenericSection(effect, TRANSFORM_PARAMS, onParamChange));
        break;
    }

    // Collapse logic
    let collapsed = false;
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      collapseBtn.textContent = collapsed ? '▸' : '▾';
    });

    card.append(header, body);
    return card;
  }
}
