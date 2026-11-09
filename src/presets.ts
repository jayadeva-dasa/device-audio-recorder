import type { BitDepth } from './wav';
import { bytesPerSample } from './wav';

export interface Preset {
  id: string;
  name: string;
  /** Plain-language description shown in the UI. */
  desc: string;
  bitDepth: BitDepth;
  sampleRate: number;
  channels: 1 | 2;
}

export const PRESETS: Preset[] = [
  { id: 'studio', name: 'Studio', desc: '32-bit float · 48 kHz · stereo', bitDepth: 'float32', sampleRate: 48000, channels: 2 },
  { id: 'high', name: 'High', desc: '24-bit · 48 kHz · stereo', bitDepth: 'pcm24', sampleRate: 48000, channels: 2 },
  { id: 'cd', name: 'CD', desc: '16-bit · 44.1 kHz · stereo', bitDepth: 'pcm16', sampleRate: 44100, channels: 2 },
  { id: 'small', name: 'Small', desc: '16-bit · 22 kHz · stereo', bitDepth: 'pcm16', sampleRate: 22050, channels: 2 },
  { id: 'voice', name: 'Voice', desc: '16-bit · 16 kHz · mono', bitDepth: 'pcm16', sampleRate: 16000, channels: 1 },
];

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

export function bytesPerMinute(p: Preset): number {
  return p.sampleRate * p.channels * bytesPerSample(p.bitDepth) * 60;
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1e3)) + ' KB';
}

/** Average interleaved stereo (L,R,L,R…) into mono. */
export function downmix(stereo: Float32Array): Float32Array {
  const out = new Float32Array(stereo.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (stereo[2 * i] + stereo[2 * i + 1]) / 2;
  return out;
}

/** Round samples to the precision the given bit depth can hold (what saving then reloading would give). */
export function quantize(samples: Float32Array, depth: BitDepth): Float32Array {
  if (depth === 'float32') return samples;
  const scale = depth === 'pcm24' ? 0x7fffff : 0x7fff;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * scale) / scale;
  }
  return out;
}
