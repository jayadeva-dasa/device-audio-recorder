import './style.css';
import { detectCompat } from './compat';
import { Recorder, type Mode } from './recorder';
import { deleteRecording, listRecordings, type SavedRecording } from './storage';
import type { BitDepth } from './wav';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const recBtn = $<HTMLButtonElement>('rec-btn');
const timerEl = $('timer');
const statusEl = $('status');
const alertBox = $('alert');
const alertMsg = $('alert-msg');
const retryBtn = $<HTMLButtonElement>('retry-btn');
const warningsEl = $('warnings');
const sourceSel = $<HTMLSelectElement>('source');
const formatSel = $<HTMLSelectElement>('format');
const micOn = $<HTMLInputElement>('mic-on');
const micOpts = $('mic-opts');
const micToggleRow = $('mic-toggle-row');
const deviceSel = $<HTMLSelectElement>('device');
const deviceLabel = $('device-label');
const modeSel = $<HTMLSelectElement>('mode');
const modeLabel = $('mode-label');
const procRow = $('proc-row');
const micProc = $<HTMLInputElement>('mic-proc');
const hpTip = $('hp-tip');
const meters = [$('m-l'), $('m-r'), $('m-m')];
const micMeterRow = meters[2].closest('.meter')!;

type State = 'idle' | 'starting' | 'recording' | 'stopping';
let state: State = 'idle';
let recorder: Recorder | null = null;
let startedAt = 0;
let timerId = 0;
let wakeLock: WakeLockSentinel | null = null;
let displayTrack: MediaStreamTrack | null = null;
const shownWarnings = new Set<string>();

// ---------- compatibility ----------
const compat = detectCompat();
$('compat').classList.add(compat.level);
$('compat-title').textContent = compat.title;
for (const d of compat.details) {
  const li = document.createElement('li');
  li.textContent = d;
  $('compat-details').append(li);
}
if (compat.mobile || !compat.hasWorklet) {
  recBtn.disabled = true;
  setStatus('Recording is unavailable on this device.');
} else if (compat.level === 'none') {
  sourceSel.value = 'input';
  void primeMicPermission();
}

// ---------- helpers ----------
function setStatus(msg: string): void {
  statusEl.textContent = msg;
}
function showAlert(msg: string): void {
  alertMsg.textContent = msg;
  alertBox.hidden = false;
}
function clearAlert(): void {
  alertBox.hidden = true;
}
function warn(msg: string): void {
  if (shownWarnings.has(msg)) return;
  shownWarnings.add(msg);
  const li = document.createElement('li');
  li.textContent = '⚠ ' + msg;
  warningsEl.append(li);
}
function fmtTime(s: number): string {
  const t = Math.floor(s);
  return [t / 3600, (t / 60) % 60, t % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
}
function fmtSize(b: number): string {
  return b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
}

function explain(err: unknown, what: 'share' | 'mic'): string {
  const name = err instanceof DOMException ? err.name : '';
  if (what === 'share') {
    if (name === 'NotAllowedError' || name === 'AbortError')
      return 'The share was cancelled or blocked. Click Retry and choose a screen or tab to share.';
    if (name === 'NotFoundError') return 'No screen or tab was available to share.';
    return `Could not start capture (${name || String(err)}).`;
  }
  if (name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in the browser’s site settings, then retry.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'The selected audio input was not found. Pick another device or plug it in, then retry.';
  if (name === 'NotReadableError') return 'The audio input is busy or unavailable (another app may be using it).';
  return `Could not open the audio input (${name || String(err)}).`;
}

// ---------- microphone / devices ----------
async function refreshDevices(): Promise<void> {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const prev = deviceSel.value;
  deviceSel.replaceChildren(
    ...devs.map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId)),
  );
  if (devs.some((d) => d.deviceId === prev)) deviceSel.value = prev;
  if (!devs.length) warn('No audio input devices found.');
}

async function primeMicPermission(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    await refreshDevices();
    return true;
  } catch (e) {
    showAlert(explain(e, 'mic'));
    return false;
  }
}

function updateSettings(): void {
  const input = sourceSel.value === 'input';
  micToggleRow.hidden = input;
  micOpts.hidden = !(input || micOn.checked);
  modeLabel.hidden = input;
  procRow.hidden = input;
  hpTip.hidden = input;
  deviceLabel.firstChild!.textContent = input ? 'Input device ' : 'Microphone ';
  micMeterRow.classList.toggle('active', micOn.checked && !input);
  const locked = state !== 'idle';
  [sourceSel, formatSel, micOn, deviceSel, modeSel, micProc].forEach((el) => (el.disabled = locked));
}

micOn.addEventListener('change', async () => {
  if (micOn.checked && !(await primeMicPermission())) micOn.checked = false;
  updateSettings();
});
sourceSel.addEventListener('change', async () => {
  if (sourceSel.value === 'input') await primeMicPermission();
  updateSettings();
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (!micOpts.hidden) void refreshDevices();
});

// ---------- recording ----------
async function start(): Promise<void> {
  if (state !== 'idle') return;
  state = 'starting';
  clearAlert();
  warningsEl.replaceChildren();
  shownWarnings.clear();
  updateSettings();
  setStatus('Starting…');

  // Created inside the click gesture so it is allowed to run.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  let system: MediaStream | undefined;
  let mic: MediaStream | undefined;
  const cleanup = () => {
    system?.getTracks().forEach((t) => t.stop());
    mic?.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    state = 'idle';
    updateSettings();
  };

  try {
    const inputOnly = sourceSel.value === 'input';
    const wantMic = !inputOnly && micOn.checked;
    const procOn = micProc.checked;
    const deviceId = deviceSel.value ? { deviceId: { exact: deviceSel.value } } : {};

    if (inputOnly) {
      try {
        system = await navigator.mediaDevices.getUserMedia({
          audio: { ...deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
        });
      } catch (e) {
        showAlert(explain(e, 'mic'));
        return cleanup();
      }
    } else {
      if (wantMic) {
        try {
          mic = await navigator.mediaDevices.getUserMedia({
            audio: { ...deviceId, echoCancellation: procOn, noiseSuppression: procOn, autoGainControl: false, channelCount: 1 },
          });
        } catch (e) {
          showAlert(explain(e, 'mic'));
          return cleanup();
        }
      }
      let display: MediaStream;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
          systemAudio: 'include',
        } as DisplayMediaStreamOptions);
      } catch (e) {
        showAlert(explain(e, 'share'));
        return cleanup();
      }
      display.getVideoTracks().forEach((t) => {
        t.stop();
        display.removeTrack(t);
      });
      if (display.getAudioTracks().length === 0) {
        display.getTracks().forEach((t) => t.stop());
        showAlert(
          'No audio was shared. In the picker:\n' +
            '• Choose “Entire Screen” and tick “Also share system audio” (Windows), or\n' +
            '• Choose a “Chrome Tab” and tick “Also share tab audio”.\n' +
            (compat.level === 'tab' ? 'On macOS/Linux only tab audio is offered; for all device audio use Source → Input device.' : ''),
        );
        return cleanup();
      }
      system = new MediaStream(display.getAudioTracks());
      displayTrack = system.getAudioTracks()[0];
      displayTrack.addEventListener('ended', () => void stop('The share was stopped.'));
    }

    const mode: Mode = wantMic ? (modeSel.value as Mode) : 'system';
    recorder = new Recorder({
      ctx,
      system,
      mic,
      mode,
      bitDepth: formatSel.value as BitDepth,
      onLevels: drawLevels,
      onWarning: warn,
      onFatal: (msg) => {
        showAlert(msg);
        void stop();
      },
    });
    await recorder.start();
    state = 'recording';
    recBtn.textContent = 'Stop';
    recBtn.classList.add('on');
    startedAt = performance.now();
    timerId = window.setInterval(() => (timerEl.textContent = fmtTime((performance.now() - startedAt) / 1000)), 250);
    setStatus('Recording…');
    try {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* optional */
    }
    updateSettings();
  } catch (e) {
    showAlert(`Could not start recording: ${e instanceof Error ? e.message : String(e)}`);
    recorder = null;
    cleanup();
  }
}

async function stop(note?: string): Promise<void> {
  if (state !== 'recording' || !recorder) return;
  state = 'stopping';
  clearInterval(timerId);
  recBtn.disabled = true;
  setStatus('Finishing and saving…');
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  const rec = recorder;
  recorder = null;
  const saved = await rec.stop();
  drawLevels([0, 0, 0]);
  recBtn.textContent = 'Record';
  recBtn.classList.remove('on');
  recBtn.disabled = false;
  state = 'idle';
  updateSettings();
  if (saved.length) {
    setStatus(`${note ? note + ' ' : ''}Saved ${saved.map((s) => s.name).join(', ')}`);
  } else {
    setStatus(note ?? '');
    warn('Nothing was saved.');
  }
  await renderLibrary();
}

recBtn.addEventListener('click', () => (state === 'recording' ? void stop() : void start()));
retryBtn.addEventListener('click', () => void start());
document.addEventListener('visibilitychange', async () => {
  if (state !== 'recording') return;
  if (document.hidden) warn('This tab is hidden. Browsers may throttle hidden tabs; keep it visible if audio drops out.');
  else if (wakeLock?.released) {
    try {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* optional */
    }
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state === 'recording') e.preventDefault();
});

// ---------- meters ----------
const levels = [0, 0, 0];
function drawLevels(peaks: number[]): void {
  peaks.forEach((p, i) => {
    const db = p > 0 ? 20 * Math.log10(p) : -90;
    const target = Math.max(0, Math.min(1, (db + 60) / 60));
    levels[i] = Math.max(target, levels[i] * 0.8);
    meters[i].style.transform = `scaleX(${levels[i]})`;
  });
}

// ---------- library ----------
const libEl = $('library');
const libEmpty = $('library-empty');
let urls: string[] = [];

async function renderLibrary(): Promise<void> {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  let items: SavedRecording[] = [];
  try {
    items = await listRecordings();
  } catch {
    warn('Could not read saved recordings from browser storage.');
  }
  libEmpty.hidden = items.length > 0;
  libEl.replaceChildren(...items.map(libraryItem));
}

function libraryItem(r: SavedRecording): HTMLLIElement {
  const li = document.createElement('li');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = r.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${fmtTime(r.duration)} · ${fmtSize(r.size)} · ${r.channels} ch · ${new Date(r.createdAt).toLocaleString()}`;
  const actions = document.createElement('div');
  actions.className = 'actions';

  const play = document.createElement('button');
  play.textContent = 'Play';
  play.addEventListener('click', () => {
    const existing = li.querySelector('audio');
    if (existing) return existing.remove();
    const url = URL.createObjectURL(r.blob);
    urls.push(url);
    const a = document.createElement('audio');
    a.controls = true;
    a.src = url;
    li.append(a);
    void a.play().catch(() => {});
  });

  const dl = document.createElement('a');
  const url = URL.createObjectURL(r.blob);
  urls.push(url);
  dl.href = url;
  dl.download = r.name;
  dl.textContent = 'Download';

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete ${r.name}?`)) return;
    await deleteRecording(r.id);
    await renderLibrary();
  });

  actions.append(play, dl, del);
  li.append(name, meta, actions);
  return li;
}

updateSettings();
void renderLibrary();
