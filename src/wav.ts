export type BitDepth = 'float32' | 'pcm24' | 'pcm16';

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitDepth: BitDepth;
}

/** Max data bytes per file; WAV sizes are uint32. Leaves headroom for the header. */
export const MAX_DATA_BYTES = 0xffffffff - 4096;

const GUID_TAIL = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export function bytesPerSample(depth: BitDepth): number {
  return depth === 'float32' ? 4 : depth === 'pcm24' ? 3 : 2;
}

/** >2 channels uses WAVE_FORMAT_EXTENSIBLE; float always carries a 'fact' chunk. */
export function headerSize(fmt: WavFormat): number {
  const ext = fmt.channels > 2;
  const isFloat = fmt.bitDepth === 'float32';
  return 12 + 8 + (ext ? 40 : 16) + (isFloat ? 12 : 0) + 8;
}

export function buildWavHeader(fmt: WavFormat, dataBytes: number): Uint8Array {
  if (dataBytes > MAX_DATA_BYTES) throw new RangeError('WAV data exceeds 4 GB limit');
  const ext = fmt.channels > 2;
  const isFloat = fmt.bitDepth === 'float32';
  const bps = bytesPerSample(fmt.bitDepth);
  const blockAlign = fmt.channels * bps;
  const size = headerSize(fmt);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  let o = 0;
  str(o, 'RIFF'); v.setUint32(o + 4, size - 8 + dataBytes, true); str(o + 8, 'WAVE'); o += 12;
  str(o, 'fmt '); v.setUint32(o + 4, ext ? 40 : 16, true); o += 8;
  v.setUint16(o, ext ? 0xfffe : isFloat ? 3 : 1, true);
  v.setUint16(o + 2, fmt.channels, true);
  v.setUint32(o + 4, fmt.sampleRate, true);
  v.setUint32(o + 8, fmt.sampleRate * blockAlign, true);
  v.setUint16(o + 12, blockAlign, true);
  v.setUint16(o + 14, bps * 8, true);
  o += 16;
  if (ext) {
    v.setUint16(o, 22, true); // cbSize
    v.setUint16(o + 2, bps * 8, true); // valid bits
    v.setUint32(o + 4, fmt.channels === 3 ? 0x7 : 0, true); // FL | FR | FC
    v.setUint16(o + 8, isFloat ? 3 : 1, true); // sub-format
    out.set(GUID_TAIL, o + 10);
    o += 24;
  }
  if (isFloat) {
    str(o, 'fact'); v.setUint32(o + 4, 4, true);
    v.setUint32(o + 8, Math.floor(dataBytes / blockAlign), true);
    o += 12;
  }
  str(o, 'data'); v.setUint32(o + 4, dataBytes, true);
  return out;
}

/** Convert interleaved Float32 samples to little-endian bytes for the chosen depth. */
export function encodeSamples(samples: Float32Array, depth: BitDepth): Uint8Array {
  if (depth === 'float32') {
    // Copy so the caller's buffer can be reused; platform is little-endian in practice.
    return new Uint8Array(samples.slice().buffer);
  }
  if (depth === 'pcm16') {
    const out16 = new Uint8Array(samples.length * 2);
    for (let i = 0, o = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      const n = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
      out16[o] = n & 0xff;
      out16[o + 1] = (n >> 8) & 0xff;
    }
    return out16;
  }
  const out = new Uint8Array(samples.length * 3);
  for (let i = 0, o = 0; i < samples.length; i++, o += 3) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
    out[o] = n & 0xff;
    out[o + 1] = (n >> 8) & 0xff;
    out[o + 2] = (n >> 16) & 0xff;
  }
  return out;
}

export interface WavInfo extends WavFormat {
  dataOffset: number;
  dataBytes: number;
  blockAlign: number;
}

/** Read the format and data location from the first bytes of a WAV we wrote (16/24-bit PCM or 32-bit float). */
export function parseWavHeader(b: Uint8Array): WavInfo | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(...Array.from(b.subarray(o, o + 4)));
  if (b.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 24 <= b.length) {
      fmt = { channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data') {
      const bitDepth: BitDepth | null = fmt?.bits === 32 ? 'float32' : fmt?.bits === 24 ? 'pcm24' : fmt?.bits === 16 ? 'pcm16' : null;
      if (!fmt || !bitDepth || !fmt.channels) return null;
      return {
        channels: fmt.channels,
        sampleRate: fmt.sampleRate,
        bitDepth,
        dataOffset: o + 8,
        dataBytes: size,
        blockAlign: fmt.channels * bytesPerSample(bitDepth),
      };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}
