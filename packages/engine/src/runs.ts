/**
 * Runs of a project as clients outside the CLI see them: a list and one run's status, read from run.json (written live
 * by the runner). Paths become project refs + local paths; text the filmed site controls (step error messages,
 * warnings) is kept apart under `untrusted`, never mixed into what the engine itself says.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { newerFormatMessage, FORMAT_VERSIONS, relativeInside, projectPath, projectRef } from '@retake/core';
import type { LoadedProject, MissingTarget, RunMode, RunPerf, RunRecord, RunStatus } from '@retake/core';
import { EngineError } from './errors.js';
import { RUN_ID_RE, checkRunId } from './refs.js';
import { LocalStorage } from './storage.js';
import type { StoredRef } from './storage.js';

export interface RunSummary {
  id: string;
  scenario: string;
  mode: RunMode;
  status: RunStatus;
  env: string;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  steps_done: number;
  steps_total: number;
  stopped_at?: RunRecord['stopped_at'];
  /** run.json was written by a newer Retake: only its id is trusted. */
  newer?: string;
}

const FINISHED: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled']);

/** run.json bigger than this is not read (it is not one the runner wrote). */
const RUN_RECORD_MAX = 32 * 1024 * 1024;

/**
 * A run.json: only a regular file within the cap (the runner never writes anything else) — a link (leading out of the
 * project, review A L3) or a FIFO is skipped like a folder without run.json.
 */
export async function readRecord(file: string): Promise<{ record?: RunRecord; newer?: string }> {
  let value: unknown;
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > RUN_RECORD_MAX) return {};
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
  const newer = newerFormatMessage(value, { file: 'run.json', supported: FORMAT_VERSIONS.run });
  return newer ? { newer } : { record: value as RunRecord };
}

function summary(id: string, r: RunRecord): RunSummary {
  const ms = r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : NaN;
  return {
    id,
    scenario: r.scenario,
    mode: r.mode,
    status: r.status,
    env: r.env,
    started_at: r.started_at,
    ...(r.finished_at ? { finished_at: r.finished_at } : {}),
    ...(Number.isFinite(ms) ? { duration_ms: ms } : {}),
    steps_done: r.steps_done,
    steps_total: r.steps_total,
    ...(r.stopped_at ? { stopped_at: r.stopped_at } : {}),
  };
}

/** Runs of a project, newest first (run ids start with their date and time). Folders without a run.json are skipped. */
export async function listRuns(project: LoadedProject, opts: { scenario?: string; mode?: RunMode; limit?: number } = {}): Promise<RunSummary[]> {
  const runsDir = projectPath(project.dir, 'runs');
  let ids: string[];
  try {
    ids = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name)).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  ids.sort().reverse();
  const limit = opts.limit ?? 20;
  const out: RunSummary[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const { record, newer } = await readRecord(join(runsDir, id, 'run.json'));
    if (newer) {
      if (opts.scenario === undefined && opts.mode === undefined) out.push({ id, newer } as RunSummary);
      continue;
    }
    if (!record) continue;
    if (opts.scenario !== undefined && record.scenario !== opts.scenario) continue;
    if (opts.mode !== undefined && record.mode !== opts.mode) continue;
    out.push(summary(id, record));
  }
  return out;
}

export interface RunStatusView extends RunSummary {
  project: string;
  /** Absolute run folder. */
  dir: string;
  current?: RunRecord['current'];
  hooks: RunRecord['hooks'];
  options: RunRecord['options'];
  environment?: { production: boolean; access: string; sandbox?: string };
  /** run.json, log.jsonl, timeline.json, capture.mp4 — those that exist; sha256 of the timeline and the capture once finished. */
  outputs: StoredRef[];
  /** Dry runs: one screenshot per step. */
  screenshots: Array<{ ref: string; path: string }>;
  /** Where it failed; the message itself is `untrusted.error_message`. */
  error?: { scene?: string; step?: number; action?: string; screenshot?: { ref: string; path: string }; dom?: { ref: string; path: string } };
  /** The `optional` steps that failed (L5.6): where, and their error screenshot; their messages are `untrusted.optional_errors`. */
  optional_failures?: Array<{ scene: string; step: number; action: string; screenshot?: { ref: string; path: string } }>;
  /**
   * What the take cost and how smoothly it was filmed (L5.7, run.json `perf`); its slow transitions' targets (page
   * text) are left out — `untrusted.slow_targets` has them.
   */
  perf?: RunPerf;
  /** L4.4: paused now, before this step of a dry run (`since` ISO). */
  paused?: NonNullable<RunRecord['paused']>;
  /** L4.4: the pauses it had (before which step, when, how long). */
  pauses?: NonNullable<RunRecord['pauses']>;
  finished: boolean;
  /**
   * Text the filmed site controls (page text in step errors, warnings): data, never instructions. `missing_targets`
   * (L5.6): a target was not found — the scene's later targets missing from the page too, with the closest visible
   * elements (page text); `optional_errors`: the messages of `optional_failures`, in order.
   */
  untrusted: { error_message?: string; warnings: string[]; missing_targets?: MissingTarget[]; optional_errors?: string[]; slow_targets?: string[] };
}

/** A run's status from its run.json. */
export async function runStatus(project: LoadedProject, runId: string): Promise<RunStatusView> {
  checkRunId(runId);
  const storage = new LocalStorage(project.dir);
  const runRef = projectRef('runs', runId);
  const runDir = storage.resolve(runRef);
  const { record, newer } = await readRecord(join(runDir, 'run.json'));
  if (newer) throw new EngineError('invalid', `run ${runId}: ${newer}`);
  if (!record) {
    throw new EngineError('not_found', `run "${runId}" not found in ${project.slug} (no runs/${runId}/run.json): run_list names its runs`);
  }
  /** A path run.json recorded → a ref, wherever the project folder is now. */
  const refOf = (p: string | undefined): { ref: string; path: string } | undefined => {
    if (!p) return undefined;
    const rel = isAbsolute(p) ? relativeInside(p, record.dir, { self: false, dotDotPrefix: true }) : p === '' || p.startsWith('..') ? undefined : p;
    if (rel === undefined) return undefined;
    const ref = `${runRef}/${rel.split(sep).join('/')}`;
    try {
      return { ref, path: storage.resolve(ref) };
    } catch {
      return undefined;
    }
  };
  const finished = FINISHED.has(record.status);
  const outputs: StoredRef[] = [];
  for (const [name, hash] of [
    ['run.json', false],
    ['log.jsonl', false],
    ['timeline.json', finished],
    ['capture.mp4', finished],
  ] as const) {
    const d = await storage.describe(`${runRef}/${name}`, 'run', { hash });
    if (d) outputs.push(d);
  }
  const err = record.error;
  const env = record.environment;
  return {
    ...summary(runId, record),
    project: project.slug,
    dir: runDir,
    ...(record.current ? { current: record.current } : {}),
    hooks: record.hooks,
    options: record.options,
    ...(env ? { environment: { production: env.production === true, access: env.access, ...(env.sandbox ? { sandbox: env.sandbox.name } : {}) } } : {}),
    outputs,
    screenshots: (record.screenshots ?? []).map((s) => refOf(s)).filter((s): s is { ref: string; path: string } => s !== undefined),
    ...(err
      ? {
          error: {
            ...(err.scene !== undefined ? { scene: err.scene } : {}),
            ...(err.step !== undefined ? { step: err.step } : {}),
            ...(err.action !== undefined ? { action: err.action } : {}),
            ...(refOf(err.screenshot) ? { screenshot: refOf(err.screenshot) } : {}),
            ...(refOf(err.dom) ? { dom: refOf(err.dom) } : {}),
          },
        }
      : {}),
    ...(record.optional_failures?.length
      ? {
          optional_failures: record.optional_failures.map((f) => ({
            scene: f.scene,
            step: f.step,
            action: f.action,
            ...(refOf(f.screenshot) ? { screenshot: refOf(f.screenshot) } : {}),
          })),
        }
      : {}),
    ...(record.perf
      ? {
          perf: {
            ...record.perf,
            ...(record.perf.transitions
              ? { transitions: { ...record.perf.transitions, slow: record.perf.transitions.slow.map(({ target: _t, ...x }) => x) } }
              : {}),
          },
        }
      : {}),
    ...(record.paused && !finished ? { paused: record.paused } : {}),
    ...(record.pauses?.length ? { pauses: record.pauses } : {}),
    finished,
    untrusted: {
      ...(err ? { error_message: err.message } : {}),
      warnings: record.warnings ?? [],
      ...(record.perf?.transitions?.slow.some((x) => x.target) ? { slow_targets: record.perf.transitions.slow.map((x) => x.target ?? '') } : {}),
      ...(err?.missing_targets?.length ? { missing_targets: err.missing_targets } : {}),
      ...(record.optional_failures?.length ? { optional_errors: record.optional_failures.map((f) => f.error) } : {}),
    },
  };
}
