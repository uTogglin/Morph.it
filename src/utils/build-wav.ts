/** Interleave multi-channel AudioBuffer into a single Float32Array */
export function interleaveAudioBuffer(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const out = new Float32Array(length * numberOfChannels);
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      out[i * numberOfChannels + ch] = buffer.getChannelData(ch)[i];
    }
  }
  return out;
}

/** Convert Float32 audio samples to 16-bit PCM bytes */
export function floatTo16BitPCM(float32: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** Build a complete WAV file from raw PCM sample bytes */
export function buildWav(
  samples: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number = 16,
): Uint8Array {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + samples.length);
  const view = new DataView(buffer);
  let p = 0;
  function writeString(s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  }
  writeString("RIFF");
  view.setUint32(p, 36 + samples.length, true); p += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(p, 16, true); p += 4;
  view.setUint16(p, 1, true); p += 2; // PCM format
  view.setUint16(p, channels, true); p += 2;
  view.setUint32(p, sampleRate, true); p += 4;
  view.setUint32(p, byteRate, true); p += 4;
  view.setUint16(p, blockAlign, true); p += 2;
  view.setUint16(p, bitsPerSample, true); p += 2;
  writeString("data");
  view.setUint32(p, samples.length, true); p += 4;
  const outU8 = new Uint8Array(buffer);
  outU8.set(samples, 44);
  return outU8;
}
