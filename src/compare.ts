import { bytesPerMinute, fmtBytes, PRESETS, presetById, quantize, type Preset } from './presets';

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
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const presetSel = $<HTMLSelectElement>('cmp-preset');
  const info = $('cmp-info');
  const origBtn = $<HTMLButtonElement>('cmp-orig');
  const testBtn = $<HTMLButtonElement>('cmp-test');

  presetSel.replaceChildren(...PRESETS.map((p) => new Option(`${p.name} — ${p.desc}`, p.id)));

  let ctx: AudioContext | undefined;
  let sample: Promise<AudioBuffer> | undefined;
  const cache = new Map<string, AudioBuffer>();
  let playing: AudioBufferSourceNode | undefined;
  let active: HTMLButtonElement | undefined;
  const labels = new Map([[origBtn, origBtn.textContent ?? ''], [testBtn, testBtn.textContent ?? '']]);

  const stop = () => {
    if (playing) {
      playing.onended = null;
      try { playing.stop(); } catch { /* already stopped */ }
    }
    if (active) active.textContent = labels.get(active) ?? '';
    playing = active = undefined;
  };

  const refreshInfo = () => {
    const p = presetById(presetSel.value);
    const b = bytesPerMinute(p);
    info.textContent = `${p.name}: about ${fmtBytes(b)} per minute · ${fmtBytes(b * 60)} per hour`;
  };

  async function play(btn: HTMLButtonElement, withPreset: boolean): Promise<void> {
    const wasActive = active === btn;
    stop();
    if (wasActive) return;
    ctx ??= new AudioContext(); // created inside the click so it may run
    void ctx.resume();
    btn.textContent = 'Loading…';
    try {
      sample ??= fetch(`${import.meta.env.BASE_URL}sample-voice.wav`)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx!.decodeAudioData(ab));
      const src = await sample;
      const key = withPreset ? presetSel.value : 'orig';
      let buf = cache.get(key);
      if (!buf) {
        buf = withPreset ? await simulate(src, presetById(key)) : src;
        cache.set(key, buf);
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      node.onended = stop;
      node.start();
      playing = node;
      active = btn;
      btn.textContent = '■ Stop';
    } catch {
      sample = undefined;
      btn.textContent = labels.get(btn) ?? '';
      info.textContent = 'Could not load the sample audio.';
    }
  }

  origBtn.addEventListener('click', () => void play(origBtn, false));
  testBtn.addEventListener('click', () => void play(testBtn, true));
  presetSel.addEventListener('change', () => {
    stop();
    refreshInfo();
  });
  refreshInfo();
}
