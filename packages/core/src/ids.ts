/**
 * The generators of the domain's ids and the zod helpers of their grammars (id-grammar.ts holds the grammars, the
 * parsers and the formatters; everything about an id is in these two files).
 *
 * ULIDs: 10 Crockford base32 characters of milliseconds, then 16 random ones (80 bits): unique across machines and
 * sortable by creation time. The ids of jobs, previews, inspections, sites, recordings, frame comment threads and
 * entries and capture markers are a prefix (ULID_PREFIXES) + one.
 *
 * The clock and the randomness are this file's only reads of the machine: every generator takes the time as an
 * argument (default: now); the random part comes from node:crypto.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  ANY_THEME_NAME_MAX,
  ANY_THEME_NAME_RE,
  NEW_THEME_NAME_MAX,
  NEW_THEME_NAME_RE,
  RENDER_ID_MAX,
  RENDER_ID_RE,
  RUN_ID_MAX,
  RUN_ID_RE,
  ULID_PREFIXES,
  formatRunId,
  formatUlid,
  isRenderId,
} from './id-grammar.js';
import type { UlidKind } from './id-grammar.js';

let last = 0;
let lastRandom: number[] = [];

/** A new ULID; ULIDs made in the same millisecond by this process still sort in creation order (monotonic). */
export function ulid(now: number = Date.now()): string {
  let t = Math.max(now, last);
  let rnd: number[];
  if (t === last && lastRandom.length) {
    // Same millisecond: increment the random part (monotonic ULID).
    rnd = [...lastRandom];
    let i = rnd.length - 1;
    while (i >= 0 && rnd[i] === 31) rnd[i--] = 0;
    if (i < 0) {
      t += 1;
      rnd = [...randomBytes(16)].map((b) => b & 31);
    } else rnd[i]++;
  } else {
    rnd = [...randomBytes(16)].map((b) => b & 31);
  }
  last = t;
  lastRandom = rnd;
  return formatUlid(t, rnd);
}

/** A new id of `kind`: its prefix + a ULID ("j_…", "c_…"). */
export function newUlidId(kind: UlidKind, now?: number): string {
  return `${ULID_PREFIXES[kind]}${ulid(now)}`;
}

/**
 * "20261011-142233-catalogue" (local time): the id of a new run of `scenario`. A string, not a RunId: a scenario name
 * of more than 184 characters gives an id past the cap.
 */
export function newRunId(scenario: string, date: Date = new Date()): string {
  return formatRunId(scenario, date);
}

// ── zod ──────────────────────────────────────────────────────────────────────
// Plain strings, the cap first and the grammar second (the order of their issues), each site with its own sentence.
// Each helper refuses what its predicate of id-grammar.ts refuses, and takes what it takes.
// No helper for the ULID ids: their sites cap them differently, and those caps are published.

/** A run id (a folder name of runs/): at most RUN_ID_MAX characters. */
export function zRunId(message: string): z.ZodString {
  return z.string().max(RUN_ID_MAX).regex(RUN_ID_RE, message);
}

/**
 * A render id: at most RENDER_ID_MAX characters, a version of at most RENDER_VERSION_MAX. The published schema holds
 * the cap and the pattern; the version's bound is a refinement (a pattern cannot say it), which speaks only for a
 * string of the cap and the pattern — those two keep their own issues, in their order.
 */
export function zRenderId(message: string): z.ZodString {
  return z
    .string()
    .max(RENDER_ID_MAX)
    .regex(RENDER_ID_RE, message)
    .refine((v) => v.length > RENDER_ID_MAX || !RENDER_ID_RE.test(v) || isRenderId(v), message);
}

/**
 * The name of a theme that exists: at most ANY_THEME_NAME_MAX characters. `nonEmpty`: a site whose first word on an
 * empty string is the length's (its issue comes first; the grammar refuses an empty string either way).
 */
export function zThemeName(message: string, o: { nonEmpty?: boolean } = {}): z.ZodString {
  return (o.nonEmpty ? z.string().min(1) : z.string()).max(ANY_THEME_NAME_MAX).regex(ANY_THEME_NAME_RE, message);
}

/** The name of a new theme: at most NEW_THEME_NAME_MAX characters. */
export function zNewThemeName(message: string): z.ZodString {
  return z.string().max(NEW_THEME_NAME_MAX).regex(NEW_THEME_NAME_RE, message);
}
