import { formatClock, parseClock } from './duration';
import { downloadBlob, wavToMp3 } from './mp3';
import { fmtBytes } from './presets';
import { saveRecording, type SavedRecording } from './storage';
import { buildWavHeader, parseWavHeader, type WavInfo } from './wav';

const BUCKETS = 600;

/** Peak level per bucket, sampled from short windows so even huge files load fast. */
async function loadPeaks(blob: Blob, info: WavInfo, frames: number): Promise<Float32Array> {
  const peaks = new Float32Array(BUCKETS);
  const per = frames / BUCKETS;
  const win = Math.max(1, Math.min(Math.floor(per), 8192));
  const bps = info.blockAlign / info.channels;
  const one = async (i: number) => {
    const f0 = Math.floor(i * per);
    const n = Math.min(win, frames - f0);
    if (n <= 0) return;
    const start = info.dataOffset + f0 * info.blockAlign;
    const buf = await blob.slice(start, start + n * info.blockAlign).arrayBuffer();
    let max = 0;
    if (info.bitDepth === 'float32') {
      for (const x of new Float32Array(buf)) max = Math.max(max, Math.abs(x));
    } else if (info.bitDepth === 'pcm16') {
      for (const x of new Int16Array(buf)) max = Math.max(max, Math.abs(x) / 32768);
    } else {
      const u = new Uint8Array(buf);
      for (let o = 0; o + bps <= u.length; o += 3) {
        const x = (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16)) << 8 >> 8;
        max = Math.max(max, Math.abs(x) / 8388608);
      }
    }
    peaks[i] = max;
  };
  for (let i = 0; i < BUCKETS; i += 40) {
    await Promise.all(Array.from({ length: Math.min(40, BUCKETS - i) }, (_, k) => one(i + k)));
  }
  return peaks;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export async function openEditor(rec: SavedRecording, onSaved: () => void): Promise<void> {
  const dlg = $<HTMLDialogElement>('editor');
  const canvas = $<HTMLCanvasElement>('ed-wave');
  const audio = $<HTMLAudioElement>('ed-audio');
  const startIn = $<HTMLInputElement>('ed-start');
  const endIn = $<HTMLInputElement>('ed-end');
  const info$ = $('ed-info');
  const msg = $('ed-msg');
  $('ed-title').textContent = rec.name;
  msg.textContent = 'Reading…';
  dlg.showModal();

  const head = new Uint8Array(await rec.blob.slice(0, 4096).arrayBuffer());
  const info = parseWavHeader(head);
  if (!info) {
    msg.textContent = 'This file can’t be edited (not a WAV recorded by this app).';
    return;
  }
  const frames = Math.floor(Math.min(info.dataBytes, rec.blob.size - info.dataOffset) / info.blockAlign);
  const duration = frames / info.sampleRate;
  const peaks = await loadPeaks(rec.blob, info, frames);
  msg.textContent = 'Drag the handles, or play and press “Set start / end here”.';

  let start = 0;
  let end = duration;
  let selectionOnly = false;
  const url = URL.createObjectURL(rec.blob);
  audio.src = url;

  const x2t = (x: number) => Math.max(0, Math.min(duration, (x / canvas.clientWidth) * duration));
  const t2x = (t: number) => (t / duration) * canvas.clientWidth;

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const col = (n: string) => css.getPropertyValue(n).trim();
    c.clearRect(0, 0, w, h);
    const sx = t2x(start);
    const ex = t2x(end);
    c.fillStyle = col('--accent-soft');
    c.fillRect(sx, 0, ex - sx, h);
    const mid = h / 2;
    for (let i = 0; i < BUCKETS; i++) {
      const x = (i / BUCKETS) * w;
      const amp = Math.max(1, Math.min(1, Math.sqrt(peaks[i])) * (mid - 2));
      c.fillStyle = x >= sx && x <= ex ? col('--accent') : col('--muted');
      c.fillRect(x, mid - amp, Math.max(1, w / BUCKETS - 0.5), amp * 2);
    }
    for (const x of [sx, ex]) {
      c.fillStyle = col('--fg');
      c.fillRect(x - 1, 0, 2, h);
      c.fillRect(x - 5, 0, 10, 8);
      c.fillRect(x - 5, h - 8, 10, 8);
    }
    c.fillStyle = col('--ok');
    c.fillRect(t2x(audio.currentTime) - 1, 0, 2, h);
  }

  function refresh(): void {
    startIn.value = formatClock(start);
    endIn.value = formatClock(end);
    const bytes = Math.round((end - start) * info!.sampleRate) * info!.blockAlign;
    info$.textContent = `Length ${formatClock(end - start)} · about ${fmtBytes(bytes)}`;
    draw();
  }

  const setStart = (t: number) => { start = Math.min(Math.max(0, t), end - 0.1); refresh(); };
  const setEnd = (t: number) => { end = Math.max(Math.min(duration, t), start + 0.1); refresh(); };

  // Dragging handles; clicking elsewhere seeks the player.
  let drag: 'start' | 'end' | null = null;
  const onDown = (e: PointerEvent) => {
    const x = e.offsetX;
    const ds = Math.abs(x - t2x(start));
    const de = Math.abs(x - t2x(end));
    if (Math.min(ds, de) < 12) drag = ds <= de ? 'start' : 'end';
    else audio.currentTime = x2t(x);
    canvas.setPointerCapture(e.pointerId);
    draw();
  };
  const onMove = (e: PointerEvent) => {
    if (drag === 'start') setStart(x2t(e.offsetX));
    else if (drag === 'end') setEnd(x2t(e.offsetX));
  };
  const onUp = () => (drag = null);
  const onTime = () => {
    if (selectionOnly && audio.currentTime >= end) {
      audio.pause();
      selectionOnly = false;
    }
    draw();
  };
  const tick = () => {
    if (!audio.paused) draw();
    raf = requestAnimationFrame(tick);
  };
  let raf = requestAnimationFrame(tick);

  const parseInto = (el: HTMLInputElement, apply: (t: number) => void) => () => {
    const t = parseClock(el.value);
    if (t === null) refresh();
    else apply(t);
  };

  const cut = () => {
    const f0 = Math.round(start * info.sampleRate);
    const f1 = Math.min(frames, Math.round(end * info.sampleRate));
    const body = rec.blob.slice(info.dataOffset + f0 * info.blockAlign, info.dataOffset + f1 * info.blockAlign);
    const header = buildWavHeader(info, body.size);
    return { blob: new Blob([header as BlobPart, body], { type: 'audio/wav' }), frames: f1 - f0 };
  };
  const base = rec.name.replace(/\.wav$/i, '');
  const cutName = () => `${base}-${formatClock(start).replace(/[:.]/g, '-')}_to_${formatClock(end).replace(/[:.]/g, '-')}.wav`;

  const handlers: Array<[HTMLElement, string, EventListener]> = [
    [canvas, 'pointerdown', onDown as EventListener],
    [canvas, 'pointermove', onMove as EventListener],
    [canvas, 'pointerup', onUp],
    [audio, 'timeupdate', onTime],
    [audio, 'seeked', draw],
    [startIn, 'change', parseInto(startIn, setStart)],
    [endIn, 'change', parseInto(endIn, setEnd)],
    [$('ed-set-start'), 'click', () => setStart(audio.currentTime)],
    [$('ed-set-end'), 'click', () => setEnd(audio.currentTime)],
    [$('ed-play-sel'), 'click', () => {
      selectionOnly = true;
      audio.currentTime = start;
      void audio.play().catch(() => {});
    }],
    [$('ed-download'), 'click', async () => {
      const fmt = $<HTMLSelectElement>('ed-format').value;
      const btn = $<HTMLButtonElement>('ed-download');
      const { blob } = cut();
      const name = cutName();
      if (fmt === 'wav') {
        downloadBlob(blob, name);
        msg.textContent = `Downloaded ${name}`;
        return;
      }
      btn.disabled = true;
      try {
        const mp3 = await wavToMp3(blob, Number(fmt), (f) => (msg.textContent = `Converting to MP3… ${Math.round(f * 100)}%`));
        const mp3Name = name.replace(/\.wav$/, '.mp3');
        downloadBlob(mp3, mp3Name);
        msg.textContent = `Downloaded ${mp3Name} (${fmtBytes(mp3.size)})`;
      } catch (e) {
        msg.textContent = `MP3 conversion failed: ${e instanceof Error ? e.message : 'unknown error'}`;
      } finally {
        btn.disabled = false;
      }
    }],
    [$('ed-save'), 'click', async () => {
      const { blob, frames: n } = cut();
      try {
        await saveRecording({
          id: crypto.randomUUID(),
          name: cutName(),
          createdAt: Date.now(),
          duration: n / info.sampleRate,
          channels: info.channels,
          size: blob.size,
          blob,
        });
        msg.textContent = 'Saved as a new recording.';
        onSaved();
      } catch {
        msg.textContent = 'Could not save (browser storage is full?).';
      }
    }],
  ];
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  handlers.forEach(([el, ev, fn]) => el.addEventListener(ev, fn));

  dlg.addEventListener(
    'close',
    () => {
      cancelAnimationFrame(raf);
      audio.pause();
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      window.removeEventListener('resize', onResize);
      handlers.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
    },
    { once: true },
  );
  refresh();
}
