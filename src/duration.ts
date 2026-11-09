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
