import { describe, expect, it } from 'vitest';
import { buildWavHeader, encodeSamples, headerSize, MAX_DATA_BYTES } from './wav';

const tag = (b: Uint8Array, o: number) => String.fromCharCode(...b.slice(o, o + 4));

describe('buildWavHeader', () => {
  it('writes a correct 32-bit float stereo header', () => {
    const h = buildWavHeader({ channels: 2, sampleRate: 48000, bitDepth: 'float32' }, 1000);
    const v = new DataView(h.buffer);
    expect(h.length).toBe(headerSize({ channels: 2, sampleRate: 48000, bitDepth: 'float32' }));
    expect(tag(h, 0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(h.length - 8 + 1000);
    expect(tag(h, 8)).toBe('WAVE');
    expect(tag(h, 12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(3); // IEEE float
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 8);
    expect(v.getUint16(32, true)).toBe(8);
    expect(v.getUint16(34, true)).toBe(32);
    expect(tag(h, 36)).toBe('fact');
    expect(v.getUint32(44, true)).toBe(125);
    expect(tag(h, 48)).toBe('data');
    expect(v.getUint32(52, true)).toBe(1000);
  });

  it('writes a correct 24-bit PCM stereo header (44 bytes)', () => {
    const h = buildWavHeader({ channels: 2, sampleRate: 48000, bitDepth: 'pcm24' }, 600);
    const v = new DataView(h.buffer);
    expect(h.length).toBe(44);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(32, true)).toBe(6);
    expect(v.getUint16(34, true)).toBe(24);
    expect(tag(h, 36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(600);
    expect(v.getUint32(4, true)).toBe(36 + 600);
  });

  it('uses WAVE_FORMAT_EXTENSIBLE for 3 channels', () => {
    const h = buildWavHeader({ channels: 3, sampleRate: 48000, bitDepth: 'float32' }, 120);
    const v = new DataView(h.buffer);
    expect(v.getUint16(20, true)).toBe(0xfffe);
    expect(v.getUint32(16, true)).toBe(40);
    expect(v.getUint16(22, true)).toBe(3);
    expect(v.getUint16(36, true)).toBe(22);
    expect(v.getUint16(44, true)).toBe(3); // sub-format float
    expect(tag(h, h.length - 8)).toBe('data');
    expect(v.getUint32(h.length - 4, true)).toBe(120);
  });

  it('rejects data over the 4 GB limit', () => {
    expect(() =>
      buildWavHeader({ channels: 2, sampleRate: 48000, bitDepth: 'float32' }, MAX_DATA_BYTES + 1),
    ).toThrow(RangeError);
  });
});

describe('encodeSamples', () => {
  it('float32 round-trips exactly', () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123456]);
    const bytes = encodeSamples(src, 'float32');
    expect(bytes.length).toBe(src.length * 4);
    const back = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    expect(Array.from(back)).toEqual(Array.from(src));
  });

  it('does not alias the input buffer', () => {
    const src = new Float32Array([0.25]);
    const bytes = encodeSamples(src, 'float32');
    src[0] = 0.9;
    expect(new Float32Array(bytes.buffer)[0]).toBe(0.25);
  });

  it('24-bit encodes full scale, zero and clipping', () => {
    const bytes = encodeSamples(new Float32Array([0, 1, -1, 2, -2, 0.5]), 'pcm24');
    expect(bytes.length).toBe(18);
    const s24 = (o: number) => {
      const n = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      return n & 0x800000 ? n - 0x1000000 : n;
    };
    expect(s24(0)).toBe(0);
    expect(s24(3)).toBe(8388607);
    expect(s24(6)).toBe(-8388608);
    expect(s24(9)).toBe(8388607); // clipped
    expect(s24(12)).toBe(-8388608); // clipped
    expect(s24(15)).toBe(Math.round(0.5 * 8388607));
  });
});
