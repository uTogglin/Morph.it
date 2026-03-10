// ── AudioMixer ─────────────────────────────────────────────────────────────────
// Web Audio API multi-track mixer for the timeline editor.
//
// Architecture (per track):
//   MediaElementAudioSourceNode (per video element)
//     → GainNode (track volume) → StereoPannerNode → [5-band EQ chain]
//       → muteGain → masterGain → AudioContext.destination
//
// M5/M6 fix: mediaSources tracks { node, trackId } so connectVideoElement can
// disconnect from the old trackGain before connecting to a new one, and
// disconnectVideoElement only severs the one specific connection.

export interface TrackAudioConfig {
  volume: number;    // 0.0–2.0
  pan: number;       // -1.0–1.0
  muted: boolean;
  solo: boolean;
  // 5-band parametric EQ
  eq?: EQBand[];
}

export interface EQBand {
  freq: number;      // Hz: 60, 230, 910, 3600, 14000
  gain: number;      // dB: -12 to +12
}

interface TrackNodes {
  trackGain:  GainNode;
  panner:     StereoPannerNode;
  eqFilters:  BiquadFilterNode[];
  muteGain:   GainNode;   // 0 = muted, 1 = active
}

interface MediaSourceEntry {
  node:    MediaElementAudioSourceNode;
  trackId: string;
}

const DEFAULT_EQ_BANDS: EQBand[] = [
  { freq: 60,    gain: 0 },
  { freq: 230,   gain: 0 },
  { freq: 910,   gain: 0 },
  { freq: 3600,  gain: 0 },
  { freq: 14000, gain: 0 },
];

export class AudioMixer {
  private ctx: AudioContext;
  private masterGain: GainNode;
  private tracks = new Map<string, TrackNodes>();
  // M5/M6 fix: store { node, trackId } so we can disconnect from the right track
  private mediaSources = new Map<HTMLVideoElement, MediaSourceEntry>();

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.ctx.destination);
  }

  // ── Track management ───────────────────────────────────────────────────────

  /** Register a track. Must be called before connecting any sources to it. */
  addTrack(id: string, config: TrackAudioConfig): void {
    if (this.tracks.has(id)) return;

    const trackGain = this.ctx.createGain();
    trackGain.gain.value = config.volume;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = config.pan;

    const muteGain = this.ctx.createGain();
    muteGain.gain.value = config.muted ? 0 : 1;

    // Build EQ chain
    const bands = config.eq ?? DEFAULT_EQ_BANDS;
    const eqFilters = bands.map(band => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = band.freq;
      f.Q.value = 1.4;
      f.gain.value = band.gain;
      return f;
    });

    // Wire: trackGain → panner → eq[0] → … → muteGain → master
    trackGain.connect(panner);
    let prev: AudioNode = panner;
    for (const f of eqFilters) {
      prev.connect(f);
      prev = f;
    }
    prev.connect(muteGain);
    muteGain.connect(this.masterGain);

    this.tracks.set(id, { trackGain, panner, eqFilters, muteGain });
  }

  removeTrack(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    // Clean up any media sources that were routed to this track so their
    // MediaElementAudioSourceNode entries don't remain as stale orphans.
    for (const [videoEl, entry] of this.mediaSources) {
      if (entry.trackId === id) {
        entry.node.disconnect(t.trackGain);
        this.mediaSources.delete(videoEl);
      }
    }
    t.trackGain.disconnect();
    t.panner.disconnect();
    for (const f of t.eqFilters) f.disconnect();
    t.muteGain.disconnect();
    this.tracks.delete(id);
  }

  // ── Video element source (preview playback) ────────────────────────────────

  /**
   * Connect an HTMLVideoElement's audio to a track.
   * M5 fix: if the element is already connected to a *different* track, disconnect
   * it from the old trackGain before connecting to the new one.
   * The MediaElementAudioSourceNode is reused — creating a second one for the
   * same element throws InvalidStateError.
   */
  connectVideoElement(videoEl: HTMLVideoElement, trackId: string): void {
    const t = this.tracks.get(trackId);
    if (!t) return;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* ignore — will retry on next user gesture */ });
    }

    const existing = this.mediaSources.get(videoEl);
    if (existing) {
      if (existing.trackId === trackId) return; // already on the right track
      // M5 fix: disconnect from the old track's gain node specifically
      const oldTrack = this.tracks.get(existing.trackId);
      if (oldTrack) existing.node.disconnect(oldTrack.trackGain);
      existing.trackId = trackId;
      existing.node.connect(t.trackGain);
    } else {
      const node = this.ctx.createMediaElementSource(videoEl);
      node.connect(t.trackGain);
      this.mediaSources.set(videoEl, { node, trackId });
    }
  }

  /**
   * M6 fix: disconnect only from the specific trackGain the element was
   * connected to, then remove from the map.
   */
  disconnectVideoElement(videoEl: HTMLVideoElement): void {
    const entry = this.mediaSources.get(videoEl);
    if (!entry) return;
    const t = this.tracks.get(entry.trackId);
    if (t) entry.node.disconnect(t.trackGain);
    else    entry.node.disconnect(); // fallback if track was already removed
    this.mediaSources.delete(videoEl);
  }

  // ── Parameter control ──────────────────────────────────────────────────────

  setVolume(trackId: string, volume: number): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.trackGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01);
  }

  setPan(trackId: string, pan: number): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.01);
  }

  setMuted(trackId: string, muted: boolean): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.muteGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.005);
  }

  setEQ(trackId: string, bands: EQBand[]): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    for (let i = 0; i < Math.min(bands.length, t.eqFilters.length); i++) {
      t.eqFilters[i].frequency.value = bands[i].freq;
      t.eqFilters[i].gain.value      = bands[i].gain;
    }
  }

  setMasterVolume(vol: number): void {
    this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.01);
  }

  /**
   * Apply solo logic: only soloed tracks pass audio.
   * If no track is soloed, unmuted tracks pass normally.
   */
  applySolo(configs: Map<string, TrackAudioConfig>): void {
    const hasSolo = [...configs.values()].some(c => c.solo);
    for (const [id, t] of this.tracks) {
      const cfg = configs.get(id);
      if (!cfg) continue;
      const active = hasSolo ? cfg.solo : !cfg.muted;
      t.muteGain.gain.setTargetAtTime(active ? 1 : 0, this.ctx.currentTime, 0.005);
    }
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  get currentTime(): number { return this.ctx.currentTime; }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx.state === 'running') await this.ctx.suspend();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  dispose(): void {
    // Disconnect all media sources before removing tracks
    for (const entry of this.mediaSources.values()) {
      entry.node.disconnect();
    }
    this.mediaSources.clear();
    for (const id of [...this.tracks.keys()]) this.removeTrack(id);
    this.ctx.close().catch(() => { /* ignore */ });
  }
}
