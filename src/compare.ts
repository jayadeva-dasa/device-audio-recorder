import { encodeMp3Channels } from './mp3';
import { bytesPerMinute, fmtBytes, MP3_PRESETS, PRESETS, presetById, quantize, type Preset } from './presets';

/** The sample as it would sound if recorded with this preset. */
export async function simulate(src: AudioBuffer, p: Preset): Promise<AudioBuffer> {
  if (p.kbps) {
    // Really encode to MP3 and decode it again, so you hear exactly what the file would sound like.
    const l = src.getChannelData(0);
    const r = src.numberOfChannels > 1 ? src.getChannelData(1) : undefined;
    const mp3 = encodeMp3Channels(l, r, src.sampleRate, p.kbps);
    const ctx = new OfflineAudioContext(src.numberOfChannels, 1, src.sampleRate);
    return ctx.decodeAudioData(await mp3.arrayBuffer());
  }
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

export function initCompare(onSelect?: (id: string) => void): { select(id: string): void } {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const chipsEl = $('cmp-presets');
  const info = $('cmp-info');
  const origBtn = $<HTMLButtonElement>('cmp-orig');
  const testBtn = $<HTMLButtonElement>('cmp-test');

  let current = PRESETS[0].id;
  let ctx: AudioContext | undefined;
  let sample: Promise<AudioBuffer> | undefined;
  const cache = new Map<string, AudioBuffer>();
  let playing: AudioBufferSourceNode | undefined;
  let active: HTMLButtonElement | undefined;

  const label = (b: HTMLButtonElement) => (b === origBtn ? '▶ Original' : `▶ Recorded · ${presetById(current).name}`);
  const ALL = [...PRESETS, ...MP3_PRESETS];
  const maxBytes = Math.max(...ALL.map(bytesPerMinute));

  const chips = ALL.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    const size = bytesPerMinute(p);
    b.innerHTML =
      '<span class="chip-name"></span><span class="chip-desc"></span><span class="chip-size"></span><span class="chip-bar"><i></i></span>';
    b.querySelector('.chip-name')!.textContent = p.name;
    b.querySelector('.chip-desc')!.textContent = p.desc;
    b.querySelector('.chip-size')!.textContent = `${fmtBytes(size)}/min`;
    b.querySelector<HTMLElement>('.chip-bar i')!.style.width = `${Math.max(6, (size / maxBytes) * 100)}%`;
    b.addEventListener('click', () => select(p.id, true));
    chipsEl.append(b);
    return b;
  });

  const stop = () => {
    if (playing) {
      playing.onended = null;
      try { playing.stop(); } catch { /* already stopped */ }
    }
    if (active) active.textContent = label(active);
    playing = active = undefined;
  };

  function select(id: string, user = false): void {
    stop();
    current = id;
    const p = presetById(id);
    chips.forEach((c, i) => c.setAttribute('aria-checked', String(ALL[i].id === id)));
    testBtn.textContent = label(testBtn);
    const b = bytesPerMinute(p);
    info.textContent = `${p.name} uses about ${fmtBytes(b)} per minute · ${fmtBytes(b * 60)} per hour.${p.kbps ? ' MP3 is made when you download a recording; recording itself stays lossless WAV.' : ''}`;
    if (user && !p.kbps) onSelect?.(id); // MP3 levels are export-only, not recording formats
  }

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
      const key = withPreset ? current : 'orig';
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
      btn.textContent = label(btn);
      info.textContent = 'Could not load the sample audio.';
    }
  }

  origBtn.addEventListener('click', () => void play(origBtn, false));
  testBtn.addEventListener('click', () => void play(testBtn, true));
  origBtn.textContent = label(origBtn);
  select(current);
  return { select: (id) => select(id) };
}
