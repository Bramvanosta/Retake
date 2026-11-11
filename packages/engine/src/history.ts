/**
 * The job history of a workspace (L3.1 guard-rail): `<workspace>/.retake/history.jsonl`, one line per finished job
 * of the worker (historyOf, jobs/run-job-record.ts) and per `retake run` / `render` / `still` / `inspect` of the CLI
 * (which run no job: the engine's in-process operations, in-process.ts), per `retake export` that re-rendered a format,
 * and per `retake record` (record.ts) — one writer per kind of line. It counts what was produced —
 * captures, dry runs, renders — for the usage counters a commercial version would need (entitlements.ts) and for the
 * index a later lot builds. Best effort: a line that cannot be written never fails the work it records.
 */
import { HISTORY_FILE } from '@retake/core';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobClient } from '@retake/core';
import { stampOf } from './clock.js';
import type { Clock } from './clock.js';
import { stateDir } from './workspace-state.js';

export const HISTORY_VERSION = 1;

export interface HistoryEntry {
  v: typeof HISTORY_VERSION;
  /** When it finished. */
  at: string;
  /** The job's id (a CLI command has none). */
  job?: string;
  /** A job kind, or `render` / `still` / `export` / `inspect` (the CLI's commands; previews and inspections count nothing). */
  kind: string;
  /** Absent for a workspace-level job (a site extraction). */
  project?: string;
  submitted_by: JobClient;
  /** succeeded (it ran to the end; a run may still have failed: `run.status`), failed, cancelled, interrupted. */
  state: string;
  ms?: number;
  run?: { id: string; scenario: string; mode: string; status: string };
  /** A render job's render (L3.2). */
  render?: { id: string; scenario: string; variant?: string };
  /** A review job's render, and whether the review was clean (L3.2). */
  review?: { render: string; clean?: boolean };
  /** An export job's render and the formats it wrote (L3.2); `counted.renders` = the formats it re-rendered. */
  export?: { render: string; formats: string[] };
  /** A preview job's id and what it showed (a component id, or `theme`); it counts nothing (L3.2). */
  preview?: { id: string; target: string; theme?: string };
  /** An inspect job's id, its source (a page or a scenario replay) and its outcome; it counts nothing (L3.3). */
  inspect?: { id: string; source: 'page' | 'scenario'; status?: string; reported?: boolean };
  /** A recording's id, its draft's steps and whether the draft was saved; it counts nothing (L3.4). */
  record?: { id: string; steps: number; saved: boolean };
  /** A site extraction's id, host and outcome; it counts nothing (L3.5). */
  site?: { id: string; host: string; status?: string };
  /** What it produced. */
  counted: { captures: number; dry_runs: number; renders: number };
}

export interface UsageCounts {
  captures: number;
  dry_runs: number;
  renders: number;
  /** Lines of the history (jobs and CLI commands). */
  entries: number;
  /** The first line's time. */
  since?: string;
}

export function historyFile(root: string): string {
  return join(stateDir(root), HISTORY_FILE);
}

/** Append one line (O_APPEND: lines of concurrent writers never interleave), at the entry's own `at` or else the time of `clock`. Never throws. */
export async function appendHistory(root: string, entry: Omit<HistoryEntry, 'v' | 'at'> & { at?: string }, clock: Clock): Promise<void> {
  try {
    await mkdir(stateDir(root), { recursive: true });
    await appendFile(historyFile(root), `${JSON.stringify({ v: HISTORY_VERSION, at: entry.at ?? stampOf(clock), ...entry })}\n`, { flag: 'a' });
  } catch {
    // best effort: the work it records is done
  }
}

/** The counters of the whole history (a torn or foreign line is skipped). */
export async function usageCounts(root: string): Promise<UsageCounts> {
  const out: UsageCounts = { captures: 0, dry_runs: 0, renders: 0, entries: 0 };
  let text: string;
  try {
    text = await readFile(historyFile(root), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Partial<HistoryEntry>;
    try {
      e = JSON.parse(line) as Partial<HistoryEntry>;
    } catch {
      continue;
    }
    if (e.v !== HISTORY_VERSION || !e.counted) continue;
    out.entries++;
    out.since ??= e.at;
    out.captures += Number(e.counted.captures) || 0;
    out.dry_runs += Number(e.counted.dry_runs) || 0;
    out.renders += Number(e.counted.renders) || 0;
  }
  return out;
}

/** The counted part of a run that ran: a capture or a dry run that succeeded. */
export function runCounted(mode: string, status: string): HistoryEntry['counted'] {
  const ok = status === 'succeeded';
  return { captures: ok && mode === 'capture' ? 1 : 0, dry_runs: ok && mode === 'dry' ? 1 : 0, renders: 0 };
}
