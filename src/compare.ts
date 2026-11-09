import { bytesPerMinute, fmtBytes, PRESETS, quantize, type Preset } from './presets';

const RATE = 48000;
const SECONDS = 8;

/** Built-in sample: melody, bright hi-hats (show lost treble) and a long quiet fade (shows bit depth). */
export async function makeSample(): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(2, RATE * SECONDS, RATE);
  const notes = [261.6, 329.6, 392, 523.3, 392, 329.6, 261.6, 196];
  notes.forEach((f, i) => {
    const t = i * 0.5;
    const osc = off.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const lp = off.createBiquadFilter();
    lp.frequency.value = 3000;
    const g = off.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
    const pan = off.createStereoPanner();
    pan.pan.value = i % 2 ? 0.6 : -0.6;
    osc.connect(lp).connect(g).connect(pan).connect(off.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
  // Hi-hat noise bursts.
  const noise = off.createBuffer(1, RATE / 10, RATE);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / 1500);
  for (let t = 0; t < 4; t += 0.25) {
    const s = off.createBufferSource();
    s.buffer = noise;
    const hp = off.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 9000;
    const g = off.createGain();
    g.gain.value = 0.35;
    s.connect(hp).connect(g).connect(off.destination);
    s.start(t);
  }
  // Soft pad that fades to near-silence.
  const pad = off.createOscillator();
  pad.frequency.value = 220;
  const pg = off.createGain();
  pg.gain.setValueAtTime(0.0001, 4);
  pg.gain.exponentialRampToValueAtTime(0.15, 4.1);
  pg.gain.exponentialRampToValueAtTime(0.00005, SECONDS);
  pad.connect(pg).connect(off.destination);
  pad.start(4);
  return off.startRendering();
}

/** The sample as it would sound if recorded with this preset. */
export async function simulate(src: AudioBuffer, p: Preset): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(p.channels, Math.ceil(src.duration * p.sampleRate), p.sampleRate);
  const node = off.createBufferSource();
  node.buffer = src;
  node.connect(off.destination);
  node.start();
  const out = await off.startRendering();
  for (let c = 0; c < out.numberOfChannels; c++) {
    out.copyToChannel(quantize(out.getChannelData(c), p.bitDepth) as Float32Array<ArrayBuffer>, c);
  }
  return out;
}

export function initCompare(): void {
  const list = document.getElementById('cmp-list')!;
  let ctx: AudioContext | undefined;
  let sample: Promise<AudioBuffer> | undefined;
  const cache = new Map<string, AudioBuffer>();
  let playing: AudioBufferSourceNode | undefined;
  let active: { btn: HTMLButtonElement; label: string } | undefined;

  const stop = () => {
    if (playing) {
      playing.onended = null;
      try { playing.stop(); } catch { /* already stopped */ }
    }
    if (active) active.btn.textContent = active.label;
    playing = active = undefined;
  };

  async function play(btn: HTMLButtonElement, key: string, preset?: Preset): Promise<void> {
    const wasActive = active?.btn === btn;
    stop();
    if (wasActive) return;
    ctx ??= new AudioContext(); // created inside the click so it may run
    void ctx.resume();
    const label = btn.textContent ?? '';
    btn.textContent = 'Loading…';
    sample ??= makeSample();
    let buf = cache.get(key);
    if (!buf) {
      const src = await sample;
      buf = preset ? await simulate(src, preset) : src;
      cache.set(key, buf);
    }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.onended = stop;
    node.start();
    playing = node;
    active = { btn, label };
    btn.textContent = '■ Stop';
  }

  const row = (title: string, sub: string, key: string, preset?: Preset) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = title;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = sub;
    text.append(name, meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '▶ Play';
    btn.addEventListener('click', () => void play(btn, key, preset));
    li.append(text, btn);
    list.append(li);
  };

  row('Original', 'The untouched sample (48 kHz, full precision)', 'orig');
  for (const p of PRESETS) {
    row(`${p.name} recording`, `${p.desc} · ~${fmtBytes(bytesPerMinute(p))} per minute`, p.id, p);
  }
}
