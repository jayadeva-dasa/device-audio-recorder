export type SupportLevel = 'full' | 'tab' | 'none';

export interface Compat {
  level: SupportLevel;
  title: string;
  details: string[];
  mobile: boolean;
  hasWorklet: boolean;
  chromium: boolean;
}

type Nav = Navigator & { userAgentData?: { mobile: boolean; platform: string; brands: { brand: string }[] } };

export function detectCompat(): Compat {
  const nav = navigator as Nav;
  const ua = navigator.userAgent;
  const mobile =
    !!nav.userAgentData?.mobile ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const platform = (nav.userAgentData?.platform || navigator.platform || ua).toLowerCase();
  const isWin = platform.includes('win');
  const isMac = platform.includes('mac');
  const isLinux = platform.includes('linux') || platform.includes('x11');
  const chromium = /Chrome\/|Edg\//.test(ua) && !/OPR\/|Firefox\//.test(ua);
  const hasWorklet = typeof AudioWorkletNode !== 'undefined' && typeof AudioContext !== 'undefined';
  const hasDisplay = !!navigator.mediaDevices?.getDisplayMedia;

  const base = { mobile, hasWorklet, chromium };
  if (mobile) {
    return {
      ...base,
      level: 'none',
      title: 'Not supported on this browser/device (use desktop Chrome or Edge)',
      details: ['Mobile browsers cannot capture device or tab audio.'],
    };
  }
  if (!hasWorklet) {
    return {
      ...base,
      level: 'none',
      title: 'Not supported on this browser/device (use desktop Chrome or Edge)',
      details: ['This browser lacks AudioWorklet, which the lossless recorder requires.'],
    };
  }
  if (!chromium || !hasDisplay) {
    return {
      ...base,
      level: 'none',
      title: 'Not supported on this browser/device (use desktop Chrome or Edge)',
      details: [
        'This browser cannot share system or tab audio.',
        'You can still record from an input device (e.g. a loopback device) using Source → Input device.',
      ],
    };
  }
  if (isWin) {
    return {
      ...base,
      level: 'full',
      title: 'Full system audio supported',
      details: ['Windows: choose “Entire Screen” and tick “Also share system audio”.'],
    };
  }
  if (isMac) {
    return {
      ...base,
      level: 'full',
      title: 'Full system audio supported',
      details: [
        'macOS 14.2 or newer: choose “Entire Screen” and tick “Also share system audio”.',
        'On older macOS only “Chrome Tab” + “Also share tab audio” works; for all device audio use a loopback driver (e.g. BlackHole) via Source → Input device.',
      ],
    };
  }
  if (isLinux) {
    return {
      ...base,
      level: 'tab',
      title: 'Tab audio only',
      details: [
        'Linux: Chrome/Edge can share the audio of a browser tab. Whole-system audio is not offered by the browser here.',
        'For all device audio: select a “Monitor of …” input (PulseAudio/PipeWire) via Source → Input device.',
      ],
    };
  }
  return { ...base, level: 'tab', title: 'Tab audio only', details: ['Choose a Chrome Tab and tick “Also share tab audio”.'] };
}
