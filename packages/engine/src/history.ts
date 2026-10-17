/**
 * The job history of a workspace (L3.1 guard-rail): `<workspace>/.demo-studio/history.jsonl`, one line per finished job
 * of the worker and per `studio run` / `studio render` / `studio still` of the CLI (which run no job), and per `studio
 * export` that re-rendered a format. It counts what was produced —
 * captures, dry runs, renders — for the usage counters a commercial version would need (entitlements.ts) and for the
 * index a later lot builds. Best effort: a line that cannot be written never fails the work it records.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobClient } from '@demo-studio/core';
import { stateDir } from './jobs/queue.js';

export const HISTORY_VERSION = 1;

export interface HistoryEntry {
  v: typeof HISTORY_VERSION;
  /** When it finished. */
  at: string;
  /** The job's id (a CLI command has none). */
  job?: string;
  /** A job kind, or `render` / `still` / `export` (the CLI's commands; component previews are not counted). */
  kind: string;
  project: string;
  submitted_by: JobClient;
  /** succeeded (it ran to the end; a run may still have failed: `run.status`), failed, cancelled, interrupted. */
  state: string;
  ms?: number;
  run?: { id: string; scenario: string; mode: string; status: string };
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
  return join(stateDir(root), 'history.jsonl');
}

/** Append one line (O_APPEND: lines of concurrent writers never interleave). Never throws. */
export async function appendHistory(root: string, entry: Omit<HistoryEntry, 'v' | 'at'> & { at?: string }): Promise<void> {
  try {
    await mkdir(stateDir(root), { recursive: true });
    await appendFile(historyFile(root), `${JSON.stringify({ v: HISTORY_VERSION, at: entry.at ?? new Date().toISOString(), ...entry })}\n`, { flag: 'a' });
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
