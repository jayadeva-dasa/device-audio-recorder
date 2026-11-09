import { Mp3Encoder } from '@breezystack/lamejs';
import { decodeSamples, parseWavHeader, type WavInfo } from './wav';

const FRAMES_PER_BLOCK = 1152 * 64;
const toInt16 = (f: Float32Array): Int16Array => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767);
  return out;
};
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Split interleaved samples into left/right (mono -> right undefined). 3-ch (sysL, sysR, mic) mixes the mic into both. */
function split(data: Float32Array, channels: number): [Float32Array, Float32Array | undefined] {
  const n = Math.floor(data.length / channels);
  const l = new Float32Array(n);
  if (channels === 1) return [data.subarray(0, n), undefined];
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = channels > 2 ? data[i * channels + 2] : 0;
    l[i] = data[i * channels] + m;
    r[i] = data[i * channels + 1] + m;
  }
  return [l, r];
}

/** Encode already-decoded channel data (used by the compare sample). */
export function encodeMp3Channels(left: Float32Array, right: Float32Array | undefined, sampleRate: number, kbps: number): Blob {
  const enc = new Mp3Encoder(right ? 2 : 1, sampleRate, kbps);
  const parts: BlobPart[] = [];
  for (let i = 0; i < left.length; i += FRAMES_PER_BLOCK) {
    const l = toInt16(left.subarray(i, i + FRAMES_PER_BLOCK));
    const out = right ? enc.encodeBuffer(l, toInt16(right.subarray(i, i + FRAMES_PER_BLOCK))) : enc.encodeBuffer(l);
    if (out.length) parts.push(out as BlobPart);
  }
  parts.push(enc.flush() as BlobPart);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** Convert a WAV blob (as recorded by this app) to MP3 without loading it all into memory. */
export async function wavToMp3(wav: Blob, kbps: number, onProgress?: (fraction: number) => void): Promise<Blob> {
  const info: WavInfo | null = parseWavHeader(new Uint8Array(await wav.slice(0, 4096).arrayBuffer()));
  if (!info) throw new Error('Not a WAV file this app can convert.');
  const outCh = info.channels === 1 ? 1 : 2;
  const enc = new Mp3Encoder(outCh, info.sampleRate, kbps);
  const total = Math.floor(Math.min(info.dataBytes, wav.size - info.dataOffset) / info.blockAlign);
  const parts: BlobPart[] = [];
  for (let f = 0; f < total; f += FRAMES_PER_BLOCK) {
    const n = Math.min(FRAMES_PER_BLOCK, total - f);
    const start = info.dataOffset + f * info.blockAlign;
    const buf = await wav.slice(start, start + n * info.blockAlign).arrayBuffer();
    const [l, r] = split(decodeSamples(buf, info.bitDepth), info.channels);
    const out = r ? enc.encodeBuffer(toInt16(l), toInt16(r)) : enc.encodeBuffer(toInt16(l));
    if (out.length) parts.push(out as BlobPart);
    onProgress?.((f + n) / total);
    await yieldToUi();
  }
  parts.push(enc.flush() as BlobPart);
  return new Blob(parts, { type: 'audio/mpeg' });
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  const u = URL.createObjectURL(blob);
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}
