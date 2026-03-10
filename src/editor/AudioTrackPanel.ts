import type { Track } from './types.ts';
import type { AudioMixer, EQBand } from './AudioMixer.ts';
import type { TrackAudioConfig } from './AudioMixer.ts';

export type AudioPanelChangeCallback = (trackId: string) => void;

const DEFAULT_EQ_FREQS = [60, 230, 910, 3600, 14000];

export class AudioTrackPanel {
  private container: HTMLElement;
  private mixer: AudioMixer;
  private onChange: AudioPanelChangeCallback;
  private eqState = new Map<string, EQBand[]>();

  constructor(container: HTMLElement, mixer: AudioMixer, onChange: AudioPanelChangeCallback) {
    this.container = container;
    this.mixer = mixer;
    this.onChange = onChange;
  }

  render(track: Track | null): void {
    this.container.innerHTML = '';

    if (!track || track.kind !== 'audio') {
      const p = document.createElement('p');
      p.className = 'atp-empty';
      p.textContent = 'Select an audio clip to view track settings.';
      this.container.appendChild(p);
      return;
    }

    if (!this.eqState.has(track.id)) {
      this.eqState.set(track.id, DEFAULT_EQ_FREQS.map(freq => ({ freq, gain: 0 })));
    }
    const bands = this.eqState.get(track.id)!;

    const panel = document.createElement('div');
    panel.className = 'atp-panel';

    const header = document.createElement('h3');
    header.className = 'atp-header';
    header.textContent = track.name;
    panel.appendChild(header);

    panel.appendChild(this.makeSlider('Volume', 'atp-volume', 0, 2, 0.01, track.volume, val => {
      track.volume = val;
      this.mixer.setVolume(track.id, val);
      this.onChange(track.id);
    }));

    panel.appendChild(this.makeSlider('Pan', 'atp-pan', -1, 1, 0.01, track.pan, val => {
      track.pan = val;
      this.mixer.setPan(track.id, val);
      this.onChange(track.id);
    }));

    const btnRow = document.createElement('div');
    btnRow.className = 'atp-btn-row';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'atp-btn atp-mute' + (track.muted ? ' atp-active' : '');
    muteBtn.textContent = 'Mute';
    muteBtn.addEventListener('click', () => {
      track.muted = !track.muted;
      muteBtn.classList.toggle('atp-active', track.muted);
      this.mixer.setMuted(track.id, track.muted);
      this.onChange(track.id);
    });

    const soloBtn = document.createElement('button');
    soloBtn.className = 'atp-btn atp-solo' + (track.solo ? ' atp-active' : '');
    soloBtn.textContent = 'Solo';
    soloBtn.addEventListener('click', () => {
      track.solo = !track.solo;
      soloBtn.classList.toggle('atp-active', track.solo);
      const configs = new Map<string, TrackAudioConfig>();
      configs.set(track.id, { volume: track.volume, pan: track.pan, muted: track.muted, solo: track.solo });
      this.mixer.applySolo(configs);
      this.onChange(track.id);
    });

    btnRow.appendChild(muteBtn);
    btnRow.appendChild(soloBtn);
    panel.appendChild(btnRow);

    const eqHeading = document.createElement('h4');
    eqHeading.className = 'atp-eq-heading';
    eqHeading.textContent = 'EQ';
    panel.appendChild(eqHeading);

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const idx = i;
      panel.appendChild(this.makeSlider(`${band.freq} Hz`, 'atp-eq-band', -12, 12, 0.1, band.gain, val => {
        bands[idx].gain = val;
        this.mixer.setEQ(track.id, bands);
        this.onChange(track.id);
      }));
    }

    this.container.appendChild(panel);
  }

  private makeSlider(
    label: string,
    cls: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (val: number) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'atp-row ' + cls;

    const lbl = document.createElement('label');
    lbl.className = 'atp-label';
    lbl.textContent = label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'atp-slider';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);

    const display = document.createElement('span');
    display.className = 'atp-value';
    display.textContent = String(value);

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      display.textContent = String(val);
      onInput(val);
    });

    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(display);
    return row;
  }
}
