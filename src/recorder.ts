import { buildWavHeader, bytesPerSample, encodeSamples, MAX_DATA_BYTES, type BitDepth } from './wav';
import { discardChunks, finalizeRecording, putChunk, type SavedRecording } from './storage';

export type Mode = 'system' | 'mixed' | 'separate';

export interface RecorderOptions {
  ctx: AudioContext;
  system: MediaStream;
  mic?: MediaStream;
  mode: Mode;
  bitDepth: BitDepth;
  onLevels(peaks: number[]): void;
  onWarning(msg: string): void;
  onFatal(msg: string): void;
}

const FLUSH_SECONDS = 2;
const SILENCE_WARN_SECONDS = 5;

interface Segment {
  id: string;
  name: string;
  index: number;
  bytes: number;
  frames: number;
  seq: number;
  startedAt: number;
}

export class Recorder {
  private node!: AudioWorkletNode;
  private channels: number;
  private parts: Uint8Array[] = [];
  private pendingBytes = 0;
  private pendingFrames = 0;
  private seg: Segment;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private finished: Promise<SavedRecording>[] = [];
  private totalFrames = 0;
  private t0 = 0;
  private lastChunk = 0;
  private silentFrames = 0;
  private stalled = false;
  private failed = false;
  private watchdog = 0;
  private baseName: string;
  private sources: AudioNode[] = [];

  constructor(private o: RecorderOptions) {
    this.channels = o.mode === 'separate' ? 3 : 2;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    this.baseName = `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    this.seg = this.newSegment(1);
  }

  private newSegment(index: number): Segment {
    return {
      id: crypto.randomUUID(),
      name: `${this.baseName}${index > 1 ? `-part${index}` : ''}.wav`,
      index,
      bytes: 0,
      frames: 0,
      seq: 0,
      startedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    const { ctx } = this.o;
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`);
    if (ctx.state !== 'running') await ctx.resume();
    this.node = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { mode: this.o.mode, chunkFrames: 4096 },
    });
    this.node.port.onmessage = (e) => this.onChunk(e.data);

    const sys = ctx.createMediaStreamSource(this.o.system);
    sys.connect(this.node, 0, 0);
    this.sources.push(sys);
    if (this.o.mic) {
      const mic = ctx.createMediaStreamSource(this.o.mic);
      mic.connect(this.node, 0, 1);
      this.sources.push(mic);
    }
    // The processor only runs when connected to the destination; a zero-gain node
    // keeps it alive without ever sending captured audio to the speakers.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(ctx.destination);
    this.sources.push(mute);

    this.t0 = ctx.currentTime;
    this.lastChunk = performance.now();
    this.watchdog = window.setInterval(() => this.checkHealth(), 1000);
    ctx.onstatechange = () => {
      if (ctx.state === 'suspended' && !this.failed) {
        this.o.onWarning('Audio engine was suspended; trying to resume…');
        void ctx.resume();
      }
    };
  }

  private checkHealth(): void {
    const idle = performance.now() - this.lastChunk;
    if (idle > 1500 && !this.stalled) {
      this.stalled = true;
      this.o.onWarning(
        document.hidden
          ? 'Tab is in the background and audio capture has stalled. Keep this tab visible, or put it in its own window.'
          : 'Audio capture has stalled — no data received for over 1.5 s.',
      );
    }
    if (this.queued > 10) this.o.onWarning('Disk is writing slowly; audio may be dropped if this continues.');
  }

  private onChunk(m: { data?: Float32Array; frames?: number; peaks?: number[]; done?: boolean }): void {
    if (m.done || !m.data || !m.frames || this.failed) return;
    this.lastChunk = performance.now();
    this.stalled = false;
    const peaks = m.peaks ?? [0, 0, 0];
    this.o.onLevels(peaks);

    if (peaks.every((p) => p < 1e-6)) {
      this.silentFrames += m.frames;
      if (this.silentFrames / this.o.ctx.sampleRate > SILENCE_WARN_SECONDS && this.silentFrames - m.frames <= SILENCE_WARN_SECONDS * this.o.ctx.sampleRate) {
        this.o.onWarning('No audio is being received (silence for 5 s+). Is anything playing? Check the share includes audio.');
      }
    } else {
      this.silentFrames = 0;
    }

    const bytes = encodeSamples(m.data, this.o.bitDepth);
    if (this.seg.bytes + this.pendingBytes + bytes.length > MAX_DATA_BYTES) this.rotate();
    this.parts.push(bytes);
    this.pendingBytes += bytes.length;
    this.pendingFrames += m.frames;
    this.totalFrames += m.frames;
    if (this.pendingFrames >= FLUSH_SECONDS * this.o.ctx.sampleRate) this.flush();
  }

  /** Queue pending parts to IndexedDB for the current segment. */
  private flush(): void {
    if (!this.parts.length) return;
    const blob = new Blob(this.parts as BlobPart[]);
    const seg = this.seg;
    const seq = seg.seq++;
    seg.bytes += this.pendingBytes;
    seg.frames += this.pendingFrames;
    this.parts = [];
    this.pendingBytes = 0;
    this.pendingFrames = 0;
    this.queued++;
    this.chain = this.chain
      .then(() => (this.failed ? undefined : putChunk(seg.id, seq, blob)))
      .catch((err) => this.fail(err))
      .finally(() => this.queued--);
  }

  private rotate(): void {
    this.flush();
    this.o.onWarning('Reached the 4 GB WAV limit — continuing in a new file (part ' + (this.seg.index + 1) + ').');
    this.queueFinalize(this.seg);
    this.seg = this.newSegment(this.seg.index + 1);
  }

  private queueFinalize(seg: Segment): void {
    const p = this.chain.then(() => {
      const fmt = { channels: this.channels, sampleRate: this.o.ctx.sampleRate, bitDepth: this.o.bitDepth };
      return finalizeRecording(
        {
          id: seg.id,
          name: seg.name,
          createdAt: seg.startedAt,
          duration: seg.frames / fmt.sampleRate,
          channels: this.channels,
        },
        buildWavHeader(fmt, seg.bytes),
      );
    });
    p.catch((err) => this.fail(err));
    this.chain = p.catch(() => undefined);
    this.finished.push(p);
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const msg = err instanceof DOMException && err.name === 'QuotaExceededError' ? 'Disk is full' : 'Could not write to browser storage';
    this.o.onFatal(`${msg}. Recording stopped; free some space and try again. Already-saved recordings are kept.`);
  }

  async stop(): Promise<SavedRecording[]> {
    clearInterval(this.watchdog);
    this.o.ctx.onstatechange = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      const prev = this.node.port.onmessage;
      this.node.port.onmessage = (e) => {
        (prev as (e: MessageEvent) => void).call(this.node.port, e);
        if (e.data?.done) {
          clearTimeout(t);
          resolve();
        }
      };
      this.node.port.postMessage('stop');
    });

    const expected = (this.o.ctx.currentTime - this.t0) * this.o.ctx.sampleRate;
    const lost = (expected - this.totalFrames) / this.o.ctx.sampleRate;
    if (lost > 0.5) this.o.onWarning(`Dropped audio detected: about ${lost.toFixed(1)} s is missing from the recording.`);

    this.sources.forEach((n) => n.disconnect());
    this.node.disconnect();
    this.o.system.getTracks().forEach((t) => t.stop());
    this.o.mic?.getTracks().forEach((t) => t.stop());
    await this.o.ctx.close().catch(() => {});

    this.flush();
    if (this.failed) {
      await discardChunks(this.seg.id);
    } else if (this.seg.frames > 0) {
      this.queueFinalize(this.seg);
    }
    await this.chain;
    const results = await Promise.allSettled(this.finished);
    return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  }

  get bytesPerFrame(): number {
    return this.channels * bytesPerSample(this.o.bitDepth);
  }
}
