// Formatting helpers shared by the server (PDF page) and both SPAs. Deterministic: no Intl/locale
// dependency, so screenshots look the same on every machine.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function group(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 720 → "€720.00"; 2327.5 → "€2,327.50". */
export function eur(n, { decimals = 2 } = {}) {
  const sign = n < 0 ? '−' : '';
  const [i, d] = Math.abs(n).toFixed(decimals).split('.');
  return `${sign}€${group(i)}${d ? `.${d}` : ''}`;
}

export function num(n, decimals = 0) {
  const [i, d] = Number(n).toFixed(decimals).split('.');
  return `${group(i)}${d ? `.${d}` : ''}`;
}

/** "2027-01-10" or "2027-01-10T…" → { y, m (0-based), d } */
function parts(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y, m: m - 1, d };
}

export function weekday(iso) {
  const { y, m, d } = parts(iso);
  return WEEKDAYS[new Date(Date.UTC(y, m, d)).getUTCDay()];
}

/** "10 Jan 2027" */
export function date(iso) {
  const { y, m, d } = parts(iso);
  return `${d} ${MONTHS_SHORT[m]} ${y}`;
}

/** "10 January 2027" */
export function dateLong(iso) {
  const { y, m, d } = parts(iso);
  return `${d} ${MONTHS[m]} ${y}`;
}

/** 0 → "Jan" */
export function monthShort(m) {
  return MONTHS_SHORT[m];
}

export function monthYear(y, m) {
  return `${MONTHS[m]} ${y}`;
}

/** "10 – 24 Jan 2027", "12 Jan – 30 Apr 2027", "28 Dec 2026 – 8 Jan 2027". */
export function range(start, end) {
  if (!start) return '';
  if (!end) return date(start);
  const a = parts(start);
  const b = parts(end);
  if (a.y === b.y && a.m === b.m) return a.d === b.d ? date(start) : `${a.d} – ${b.d} ${MONTHS_SHORT[b.m]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS_SHORT[a.m]} – ${b.d} ${MONTHS_SHORT[b.m]} ${b.y}`;
  return `${date(start)} – ${date(end)}`;
}

/** "2026-11-02T14:42:00" → "14:42" */
export function time(local) {
  return local.slice(11, 16);
}

/** Relative day label against the demo "today": "Today, 14:42", "Yesterday, 16:05", "31 Oct, 14:20". */
export function dayTime(local, today) {
  const day = local.slice(0, 10);
  if (today && day === today) return `Today, ${time(local)}`;
  if (today) {
    const t = parts(today);
    const prev = new Date(Date.UTC(t.y, t.m, t.d - 1)).toISOString().slice(0, 10);
    if (day === prev) return `Yesterday, ${time(local)}`;
  }
  const { y, m, d } = parts(local);
  const sameYear = today && parts(today).y === y;
  return `${d} ${MONTHS_SHORT[m]}${sameYear ? '' : ` ${y}`}, ${time(local)}`;
}

/** A Date in the browser's own time zone → "Monday 2 November 2026, 10:24" (the shop's "prices as of" line). */
export function dateTimeLong(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** 49152 → "48 KB"; 1468211 → "1.4 MB" */
export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(n, one, many = `${one}s`) {
  return `${num(n)} ${n === 1 ? one : many}`;
}
