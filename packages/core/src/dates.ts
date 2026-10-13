/** Days written in scenarios and calendar labels (the `date` action, R-CHO-24): read by validation and the runner. */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

function epochDay(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  return new Date(t).getUTCDate() === d ? t / 86_400_000 : null;
}

/**
 * The day a text names (days since 1970-01-01), found anywhere in it: an ISO date, or an English long date — "10
 * January 2027", "Sunday, 10 January 2027", "January 10th, 2027", "Jan 10, 2027" (labels like "Choose …" or
 * "Today, …" included). Null when it names none (other languages: matched by label only). Pure.
 */
export function parseDay(text: string): number | null {
  const s = text.replace(/[\u00a0\u2007\u202f]/g, ' ');
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return epochDay(+iso[1], +iso[2], +iso[3]);
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?,?\s+(\d{4})\b/gi)) {
    const mo = MONTHS[m[2].toLowerCase()];
    const n = mo ? epochDay(+m[3], mo, +m[1]) : null;
    if (n !== null) return n;
  }
  for (const m of s.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const mo = MONTHS[m[1].toLowerCase()];
    const n = mo ? epochDay(+m[3], mo, +m[2]) : null;
    if (n !== null) return n;
  }
  return null;
}

/** ISO date (YYYY-MM-DD) of a parsed day. */
export function isoDay(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}
