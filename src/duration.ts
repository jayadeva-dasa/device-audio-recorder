/** Parse "90" (minutes), "23:15" (mm:ss) or "1:23:15" (h:mm:ss) into seconds. Blank = no limit (0). null = invalid. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  const parts = t.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 1) return n[0] * 60;
  if (n.length === 2) return n[0] * 60 + n[1];
  return n[0] * 3600 + n[1] * 60 + n[2];
}

/** Parse a clock like "83.5", "1:23.5" or "1:02:03.25" into seconds. null = invalid. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Seconds -> "m:ss.s" (or "h:mm:ss.s" past an hour). */
export function formatClock(t: number): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths / 600) % 60);
  const sec = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
