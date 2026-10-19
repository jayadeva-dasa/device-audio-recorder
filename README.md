# Device Audio Recorder

A tiny single-page app that records the audio playing on your device as **lossless WAV** (32-bit float or 24-bit PCM, 48 kHz). Plain HTML + TypeScript + Vite. No backend, no analytics, no network calls — audio never leaves your browser.

## Run

```
npm install
npm run dev        # http://localhost:5173
npm test           # WAV encoder unit tests
npm run typecheck
npm run build      # static files in dist/
```

Use `localhost` or HTTPS (required for screen/audio capture APIs).

## How it works

`getDisplayMedia` → video track discarded → audio track → `AudioContext` (48 kHz) → `AudioWorklet` (raw Float32 PCM, no `MediaRecorder`/Opus) → ~2 s Blob chunks in IndexedDB → WAV header written at the end and stitched into one file. Audio is never routed to the speakers.

## Support matrix (honest version)

| OS | Chrome / Edge (desktop) | Notes |
|---|---|---|
| Windows | **Full system audio** | Pick *Entire Screen* + tick *Also share system audio*. |
| macOS 14.2+ | **Full system audio** | Pick *Entire Screen* + tick *Also share system audio* (verified working, incl. local apps like VLC). Older macOS: tab audio only. |
| Linux | **Tab audio only** | Same. |
| ChromeOS | Tab / system audio varies | Untested. |
| Firefox, Safari | Not supported for share capture | No audio in `getDisplayMedia`. |
| Mobile (any) | Not supported | Detected up front; Record is disabled. |

### Getting *all* device audio on Linux (or older macOS)
Set **Source → Input device only** and record from a loopback input:
- **macOS (older than 14.2):** install [BlackHole](https://github.com/ExistentialAudio/BlackHole), create a Multi-Output Device (speakers + BlackHole) in *Audio MIDI Setup*, set it as output, then pick BlackHole as the input device.
- **Linux (PulseAudio/PipeWire):** pick the “Monitor of <your output>” input.
- **Windows** can use this too (e.g. “Stereo Mix” / VB-Cable) but doesn't need to.

This mode works in any browser with AudioWorklet, including Firefox/Safari.

## Features and limits
- Optional microphone (permission asked only when first enabled), echo cancellation/noise suppression toggle, Mixed or Separate (3-channel WAV: sysL, sysR, mic) modes, separate mic meter.
- Screen Wake Lock while recording; warnings for hidden/throttled tab, stalled capture, dropped audio, slow disk, and 5 s+ of pure silence.
- Files near 4 GB (about 3 h of stereo float) are automatically split into `-part2`, … files.
- Storage is IndexedDB only (the File System Access streaming-to-disk path was **not** implemented). Browser storage quotas apply — download and delete long recordings.
- If the share is stopped from the browser's bar, the recording is saved automatically.

## Consent
Recording other people without their knowledge or consent may be illegal where you live. Only record audio you have the right to record, and respect the terms of any service whose audio you capture.
