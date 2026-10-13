/**
 * The product's clock (L1.7, R-ENV-05): `clock:` of a project or scenario names the date and time the browser reads
 * when the capture starts, so dates and times the product shows are the same on every take. Pure helpers: parsing,
 * validation and the instant a clock names (the runner installs it in the browser).
 */
import type { ClockSpec, ResolvedClock } from './types.js';

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockError';
  }
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const EXAMPLE = 'e.g. 2026-11-02T10:24:00, or with an offset 2026-11-02T10:24:00+01:00';

interface ClockParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
  /** Minutes east of UTC when written (Z = 0), else null: wall time in the browser's zone. */
  offset: number | null;
}

function parts(value: string): ClockParts | null {
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  let offset: number | null = null;
  if (m[8]) {
    if (m[8].toUpperCase() === 'Z') offset = 0;
    else {
      const sign = m[8][0] === '-' ? -1 : 1;
      const digits = m[8].slice(1).replace(':', '');
      const minutes = Number(digits.slice(2, 4) || '0');
      // Minutes past 59 (+05:99) name no offset: NaN makes clockError refuse it.
      offset = minutes > 59 ? NaN : sign * (Number(digits.slice(0, 2)) * 60 + minutes);
    }
  }
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6] ?? '0'),
    ms: Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3)),
    offset,
  };
}

/** Why a `clock` date-time is not usable, or null. A date alone is refused (the time matters as much). */
export function clockError(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `a date alone is not enough: add a time, e.g. ${v}T10:24:00`;
  const p = parts(v);
  if (!p) return `expected an ISO 8601 date and time, ${EXAMPLE}`;
  const probe = new Date(utc({ ...p, ms: 0 }));
  if (p.mo < 1 || p.mo > 12 || probe.getUTCDate() !== p.d || p.h > 23 || p.mi > 59 || p.s > 59) return `"${v}" is not a real date and time (${EXAMPLE})`;
  if (p.y < 1970) return `"${v}": the year must be 1970 or later (${EXAMPLE})`;
  if (p.offset !== null && (Number.isNaN(p.offset) || Math.abs(p.offset) > 14 * 60)) return `"${v}": the offset is out of range (±HH:MM, minutes 00–59, at most ±14:00; ${EXAMPLE})`;
  return null;
}

/** The instant of the parts read as UTC (years before 100 kept as written, unlike Date.UTC). */
function utc(p: ClockParts): number {
  const d = new Date(Date.UTC(2000, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms));
  d.setUTCFullYear(p.y, p.mo - 1, p.d);
  return d.getTime();
}

/** Offset (ms) of a time zone at an instant: local wall time − UTC. */
function zoneOffsetMs(epoch: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const f: Record<string, number> = {};
  for (const x of dtf.formatToParts(new Date(epoch))) if (x.type !== 'literal') f[x.type] = Number(x.value);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

/** Whether `timeZone` is an IANA time zone this Node.js knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const DAY_MS = 86_400_000;

/** `+01:00` for an offset in ms. */
function offsetText(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  return `${ms < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The machine's IANA zone (what the browser uses without `browser.timezone`), when Node.js knows it. */
function machineZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The instant of a wall time in `timeZone` (DST-aware). A wall time the zone skips (the clocks go forward) or shows twice
 * (they go back) names no single instant: ClockError, saying which offset to write.
 */
function wallEpoch(at: string, p: ClockParts, timeZone: string): number {
  const guess = utc(p);
  const before = zoneOffsetMs(guess - DAY_MS, timeZone);
  const after = zoneOffsetMs(guess + DAY_MS, timeZone);
  const instants = [...new Set([before, zoneOffsetMs(guess, timeZone), after])]
    .map((o) => ({ o, at: guess - o }))
    .filter((c) => zoneOffsetMs(c.at, timeZone) === c.o)
    .sort((a, b) => a.at - b.at);
  if (instants.length === 1) return instants[0].at;
  if (instants.length === 0) {
    throw new ClockError(`clock: ${at} does not exist in ${timeZone} (the clocks go forward then): give an offset, e.g. ${at}${offsetText(before)}`);
  }
  throw new ClockError(
    `clock: ${at} happens twice in ${timeZone} (the clocks go back then): give an offset — ${at}${offsetText(instants[0].o)} (the first) or ${at}${offsetText(instants[instants.length - 1].o)} (the second)`,
  );
}

/**
 * The clock of a run: the scenario's `clock` (or `false`: none), else the project's. A time without an offset is wall
 * time in `timezone` (the browser's `browser.timezone`), else in the machine's zone (the browser's then) — recorded as
 * `timezone` either way. Throws ClockError on an unusable value, an unknown time zone, or a wall time the zone skips or
 * shows twice (a DST change: write an offset).
 */
export function resolveClock(
  scenario: ClockSpec | false | undefined,
  project: ClockSpec | undefined,
  opts: { timezone?: string } = {},
): ResolvedClock | undefined {
  const spec = scenario === false ? undefined : (scenario ?? project);
  if (spec === undefined) return undefined;
  const at = typeof spec === 'string' ? spec : spec.at;
  const error = clockError(at);
  if (error) throw new ClockError(`clock: ${error}`);
  const p = parts(at)!;
  if (opts.timezone !== undefined && p.offset === null && !isTimeZone(opts.timezone)) {
    throw new ClockError(`clock: browser.timezone "${opts.timezone}" is not a time zone (e.g. Europe/Paris, America/New_York)`);
  }
  const tz = p.offset === null ? (opts.timezone ?? machineZone()) : undefined;
  const epoch =
    p.offset !== null
      ? utc(p) - p.offset * 60_000
      : tz !== undefined
        ? wallEpoch(at.trim(), p, tz)
        : new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms).getTime();
  return {
    at: at.trim(),
    epoch_ms: epoch,
    ...(tz !== undefined ? { timezone: tz } : {}),
    ...(typeof spec === 'object' && spec.freeze === true ? { freeze: true as const } : {}),
  };
}
