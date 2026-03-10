// ── ColorGradingPanel ─────────────────────────────────────────────────────────
// Renders the inspector panel content for a selected clip.
// Features:
//   • Categorized "Add Effect" popover menu (Color, Transform, Stylize)
//   • Per-effect collapsible sections with properly-bounded sliders
//   • Drag-and-drop reorder via grip handles
//   • Eye-icon enable/disable toggle per effect card
//   • Right-click context menu: Delete / Duplicate
//   • Card summary line showing key param at a glance
//   • ColorCorrect: grouped Basic / 3-Way sections
//   • LUT: .cube file import button + opacity slider
//   • onChange callback fires after every mutation so caller can update engine
//   • onWarning callback fires on 6+ effect warning

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
  createCropEffect,
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

const CROP_PARAMS: Record<string, ParamMeta> = {
  left:   { label: 'Left',   min: 0, max: 1, step: 0.001 },
  right:  { label: 'Right',  min: 0, max: 1, step: 0.001 },
  top:    { label: 'Top',    min: 0, max: 1, step: 0.001 },
  bottom: { label: 'Bottom', min: 0, max: 1, step: 0.001 },
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
  crop:         'Crop',
};

// ── Eye icon SVGs ─────────────────────────────────────────────────────────────

const EYE_OPEN_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;

const EYE_CLOSED_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

// ── Module-level drag state ───────────────────────────────────────────────────

let dragSourceIndex = -1;

// ── Context menu ──────────────────────────────────────────────────────────────

function showContextMenu(
  x: number,
  y: number,
  items: { label: string; action: () => void }[],
): void {
  // Remove any existing context menu
  document.querySelector('.cgp-context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'cgp-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;

  for (const item of items) {
    const itemEl = document.createElement('div');
    itemEl.className = 'cgp-context-item';
    itemEl.textContent = item.label;
    itemEl.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(itemEl);
  }

  document.body.appendChild(menu);

  // Dismiss on click-outside (capturing phase)
  const dismiss = (e: PointerEvent | KeyboardEvent) => {
    if ('key' in e && e.key !== 'Escape') return;
    menu.remove();
    document.removeEventListener('pointerdown', dismiss as EventListener, true);
    document.removeEventListener('keydown', dismiss as EventListener);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', dismiss as EventListener, { capture: true, once: true });
    document.addEventListener('keydown', dismiss as EventListener, { once: true });
  }, 0);
}

// ── Card summary helper ───────────────────────────────────────────────────────

function buildCardSummary(effect: Effect): string {
  switch (effect.kind) {
    case 'blur': {
      const p = effect.params as BlurParams;
      return `${p.radius}px`;
    }
    case 'sharpen': {
      const p = effect.params as SharpenParams;
      return `${p.amount.toFixed(2)}`;
    }
    case 'vignette': {
      const p = effect.params as VignetteParams;
      return `str:${p.strength.toFixed(2)}`;
    }
    case 'colorCorrect': {
      const p = effect.params as ColorCorrectParams;
      const allParams: Record<string, number> = p as unknown as Record<string, number>;
      const defaults: Record<string, number> = {
        brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0,
        liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1,
        gainR: 1, gainG: 1, gainB: 1,
      };
      let adjusted = 0;
      for (const [k, def] of Object.entries(defaults)) {
        if (Math.abs((allParams[k] ?? def) - def) > 0.001) adjusted++;
      }
      return adjusted > 0 ? `${adjusted} adjusted` : 'default';
    }
    case 'lut': {
      const p = effect.params as LutParams;
      return p.size > 0 ? `${p.size}³` : 'No LUT';
    }
    case 'transform': {
      const p = effect.params as TransformParams;
      if (p.x !== 0 || p.y !== 0) return `x:${p.x} y:${p.y}`;
      if (p.scaleX !== 1 || p.scaleY !== 1) return `scale:${p.scaleX.toFixed(2)}`;
      if (p.rotation !== 0) return `rot:${p.rotation}°`;
      return 'default';
    }
    case 'crop': {
      return 'cropped';
    }
    default:
      return '';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export class ColorGradingPanel {
  private container: HTMLElement;
  private onChange: PanelChangeCallback;
  private onWarning?: (msg: string) => void;
  private _clip: Clip | null = null;
  private _trackKind: 'video' | 'audio' = 'video';

  constructor(
    container: HTMLElement,
    onChange: PanelChangeCallback,
    onWarning?: (msg: string) => void,
  ) {
    this.container = container;
    this.onChange  = onChange;
    this.onWarning = onWarning;
  }

  /** Render the panel for the given clip (or show empty state). */
  render(clip: Clip | null, trackKind: 'video' | 'audio' = 'video'): void {
    this._clip = clip;
    this._trackKind = trackKind;
    this.container.innerHTML = '';

    if (!clip) {
      const p = document.createElement('p');
      p.className = 'cgp-empty';
      p.textContent = 'Select a clip to view and edit its effects.';
      this.container.appendChild(p);
      return;
    }

    // ── Clip Properties card ─────────────────────────────────────────────────
    this.container.appendChild(this.buildPropertiesCard(clip, trackKind));

    // ── "Add Effect" button (categorized popover) ────────────────────────────
    const addRow = document.createElement('div');
    addRow.className = 'cgp-add-row';

    const addBtn = document.createElement('button');
    addBtn.className = 'cgp-add-btn';
    addBtn.textContent = '+ Add Effect';
    addBtn.addEventListener('click', () => {
      if (!this._clip) return;
      this.showAddMenu(addBtn, this._clip);
    });

    addRow.appendChild(addBtn);
    this.container.appendChild(addRow);

    // ── Effect list ──────────────────────────────────────────────────────────
    if (clip.effects.length === 0) {
      const p = document.createElement('p');
      p.className = 'cgp-empty';
      p.textContent = 'No effects. Use "+ Add Effect" above.';
      this.container.appendChild(p);
      return;
    }

    for (let i = 0; i < clip.effects.length; i++) {
      this.container.appendChild(this.buildEffectCard(clip, i));
    }
  }

  // ── Private: categorized add menu ─────────────────────────────────────────

  private showAddMenu(anchorBtn: HTMLButtonElement, clip: Clip): void {
    // Remove existing add menu
    document.querySelector('.cgp-add-menu')?.remove();

    const categories: { label: string; effects: string[] }[] = [
      { label: 'Color',     effects: ['colorCorrect', 'lut'] },
      { label: 'Transform', effects: ['transform', 'crop'] },
      { label: 'Stylize',   effects: ['blur', 'sharpen', 'vignette'] },
    ];

    const menu = document.createElement('div');
    menu.className = 'cgp-add-menu';

    for (const cat of categories) {
      const catLabel = document.createElement('div');
      catLabel.className = 'cgp-add-category';
      catLabel.textContent = cat.label;
      menu.appendChild(catLabel);

      for (const kind of cat.effects) {
        const btn = document.createElement('button');
        btn.textContent = EFFECT_LABELS[kind] ?? kind;
        btn.addEventListener('click', () => {
          menu.remove();
          this.addEffect(clip, kind);
        });
        menu.appendChild(btn);
      }
    }

    // Position below the anchor button
    const rect = anchorBtn.getBoundingClientRect();
    const container = anchorBtn.closest('.editor-inspector, [class*="inspector"]') as HTMLElement | null;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.left = `${rect.left}px`;
      menu.style.top  = `${rect.bottom + 4}px`;
    } else {
      menu.style.position = 'fixed';
      menu.style.left = `${rect.left}px`;
      menu.style.top  = `${rect.bottom + 4}px`;
    }

    document.body.appendChild(menu);

    // Dismiss on click-outside
    setTimeout(() => {
      document.addEventListener('pointerdown', (e) => {
        if (!menu.contains(e.target as Node)) menu.remove();
      }, { capture: true, once: true });
    }, 0);
  }

  // ── Private: add effect to clip ───────────────────────────────────────────

  private addEffect(clip: Clip, kind: string): void {
    let effect: Effect;
    switch (kind) {
      case 'colorCorrect': effect = createColorCorrectEffect(); break;
      case 'blur':         effect = createBlurEffect();         break;
      case 'sharpen':      effect = createSharpenEffect();      break;
      case 'vignette':     effect = createVignetteEffect();     break;
      case 'transform':    effect = createTransformEffect();    break;
      case 'crop':         effect = createCropEffect();         break;
      case 'lut':
        effect = {
          id:      crypto.randomUUID(),
          kind:    'lut',
          enabled: true,
          params:  { lutData: new Float32Array(0), size: 0, opacity: 1.0 } satisfies LutParams,
        };
        break;
      default: return;
    }
    clip.effects.push(effect);
    if (clip.effects.length >= 6) {
      this.onWarning?.('Performance may degrade with many effects');
    }
    this.onChange(clip);
    this.render(clip, this._trackKind);
  }

  // ── Private: build clip properties card ──────────────────────────────────

  private buildPropertiesCard(clip: Clip, trackKind: 'video' | 'audio' = 'video'): HTMLElement {
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

    // Audio gain slider — only show for audio clips (video clips have a linked audio clip)
    if (trackKind === 'audio') {
      body.appendChild(
        makeSliderRow(
          clip as unknown as Record<string, unknown>,
          'audioGain',
          { label: 'Audio Gain', min: 0.0, max: 2.0, step: 0.01 },
          onPropChange,
        )
      );
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

  // ── Private: build one effect card ────────────────────────────────────────

  private buildEffectCard(clip: Clip, index: number): HTMLElement {
    const effect = clip.effects[index];

    const card = document.createElement('div');
    card.className = 'cgp-card';

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'cgp-card-header';

    // Drag handle
    const dragHandle = document.createElement('div');
    dragHandle.className = 'cgp-drag-handle';
    dragHandle.draggable = true;
    dragHandle.textContent = '⋮⋮';
    dragHandle.title = 'Drag to reorder';

    dragHandle.addEventListener('dragstart', (e) => {
      dragSourceIndex = index;
      e.dataTransfer!.effectAllowed = 'move';
      card.classList.add('cgp-dragging');
    });
    dragHandle.addEventListener('dragend', () => {
      card.classList.remove('cgp-dragging');
    });

    // Eye toggle button
    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'cgp-eye-btn';
    eyeBtn.title = 'Enable / disable effect';

    const updateEyeIcon = (enabled: boolean) => {
      eyeBtn.innerHTML = enabled ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    };
    updateEyeIcon(effect.enabled);

    eyeBtn.addEventListener('click', () => {
      effect.enabled = !effect.enabled;
      updateEyeIcon(effect.enabled);
      body.style.opacity = effect.enabled ? '' : '0.4';
      this.onChange(clip);
    });

    // Title
    const title = document.createElement('span');
    title.className = 'cgp-card-title';
    title.textContent = EFFECT_LABELS[effect.kind] ?? effect.kind;

    // Card summary
    const summary = document.createElement('span');
    summary.className = 'cgp-card-summary';
    summary.textContent = buildCardSummary(effect);

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
      this.render(clip, this._trackKind);
    });

    header.append(dragHandle, eyeBtn, title, summary, collapseBtn, removeBtn);

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
      case 'crop':
        body.appendChild(buildGenericSection(effect, CROP_PARAMS, onParamChange));
        break;
    }

    // Collapse logic
    let collapsed = false;
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      collapseBtn.textContent = collapsed ? '▸' : '▾';
    });

    // ── Drag-over / drop on card ─────────────────────────────────────────────
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      card.classList.add('cgp-drag-over');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('cgp-drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('cgp-drag-over');
      if (dragSourceIndex === index || dragSourceIndex === -1) return;
      // Reorder: remove from source, insert at target
      const [moved] = clip.effects.splice(dragSourceIndex, 1);
      clip.effects.splice(index, 0, moved);
      dragSourceIndex = -1;
      this.onChange(clip);
      this.render(clip, this._trackKind);
    });

    // ── Right-click context menu ─────────────────────────────────────────────
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Delete',
          action: () => {
            clip.effects.splice(index, 1);
            this.onChange(clip);
            this.render(clip, this._trackKind);
          },
        },
        {
          label: 'Duplicate',
          action: () => {
            const duplicate: Effect = {
              id:      crypto.randomUUID(),
              kind:    effect.kind,
              enabled: effect.enabled,
              params:  structuredClone(effect.params),
            };
            clip.effects.splice(index + 1, 0, duplicate);
            this.onChange(clip);
            this.render(clip, this._trackKind);
          },
        },
      ]);
    });

    card.append(header, body);
    return card;
  }
}
