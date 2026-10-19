// Runs on the audio thread. Input 0 = system/tab audio (stereo), input 1 = microphone.
// Posts interleaved Float32 chunks to the main thread.
// Output layout: 'system' / 'mixed' -> 2 channels (L, R); 'separate' -> 3 channels (sysL, sysR, mic).
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.mode = o.mode;
    this.channels = this.mode === 'separate' ? 3 : 2;
    this.chunkFrames = o.chunkFrames || 4096;
    this.newBuffer();
    this.peaks = [0, 0, 0]; // sysL, sysR, mic
    this.totalFrames = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.port.postMessage({ done: true, totalFrames: this.totalFrames });
        this.active = false;
      }
    };
  }

  newBuffer() {
    this.buf = new Float32Array(this.chunkFrames * this.channels);
    this.pos = 0;
  }

  flush() {
    if (this.pos === 0) return;
    const frames = this.pos / this.channels;
    const data = this.pos === this.buf.length ? this.buf : this.buf.slice(0, this.pos);
    this.totalFrames += frames;
    this.port.postMessage({ data, frames, peaks: this.peaks, frame: currentFrame }, [data.buffer]);
    this.peaks = [0, 0, 0];
    this.newBuffer();
  }

  process(inputs) {
    if (!this.active) return false;
    const sys = inputs[0] || [];
    const mic = inputs[1] || [];
    const n = (sys[0] || mic[0] || { length: 128 }).length;
    const sL = sys[0], sR = sys[1] || sys[0], m = mic[0];
    const p = this.peaks;
    for (let i = 0; i < n; i++) {
      const l = sL ? sL[i] : 0;
      const r = sR ? sR[i] : 0;
      const mv = m ? m[i] : 0;
      const al = Math.abs(l), ar = Math.abs(r), am = Math.abs(mv);
      if (al > p[0]) p[0] = al;
      if (ar > p[1]) p[1] = ar;
      if (am > p[2]) p[2] = am;
      if (this.mode === 'separate') {
        this.buf[this.pos++] = l;
        this.buf[this.pos++] = r;
        this.buf[this.pos++] = mv;
      } else if (this.mode === 'mixed') {
        this.buf[this.pos++] = l + mv;
        this.buf[this.pos++] = r + mv;
      } else {
        this.buf[this.pos++] = l;
        this.buf[this.pos++] = r;
      }
      if (this.pos === this.buf.length) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
