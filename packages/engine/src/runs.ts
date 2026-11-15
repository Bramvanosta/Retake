/**
 * Runs of a project as clients outside the CLI see them: a list and one run's status, read from run.json (written live
 * by the runner). Paths become project refs + local paths; text the filmed site controls (step error messages,
 * warnings) is kept apart under `untrusted`, never mixed into what the engine itself says.
 */
import { isAbsolute, join, sep } from 'node:path';
import { relativeInside } from '@retake/core/base';
import { projectRef } from '@retake/core/project';
import { isFinishedRunStatus, latestTake, takeNeedsTimeline, takeOf } from '@retake/core/run';
import type { LoadedProject } from '@retake/core/project';
import type { MissingTarget, RunMode, RunStatus } from '@retake/core/run';
import type { RunId } from '@retake/core/ids';
import type { LatestPick, RunRead, RunRecord, StoredRunPerf, StoredRunRecord, TakeVerdict, UnknownRunStatus, UnknownStatusRun } from '@retake/core/run';
import { EngineError } from './errors.js';
import { runsDirOf } from './outputs/outputs.js';
import type { RunOutputs } from './outputs/outputs.js';
import { checkRunId } from './refs.js';
import { resolveIn } from './storage.js';
import type { StoredRef } from './storage.js';

export interface RunSummary {
  id: string;
  scenario: string;
  mode: RunMode;
  /** One of the five, or — a record written by something else — the text its run.json holds (the views show `unknown`). */
  status: RunStatus | UnknownRunStatus;
  env: string;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  steps_done: number;
  steps_total: number;
  stopped_at?: StoredRunRecord['stopped_at'];
  /** run.json was written by a newer Retake: only its id is trusted. */
  newer?: string;
  /**
   * run.json is there and does not read as a run record (it is no JSON, no object, has no status, or holds a state no
   * run has): only its id is trusted, and the run is in no list of captures. The fixed sentence that says so.
   */
  unread?: string;
}

/** Whether a row of a list is a run that reads: neither written by a newer Retake nor a run.json that is no record. */
export function isReadRun(r: Pick<RunSummary, 'newer' | 'unread'>): boolean {
  return r.newer === undefined && r.unread === undefined;
}

/** What is said of a run folder whose run.json is there and is no record; `detail`: the member that does not read (a path, never a value). */
export function unreadWords(detail?: string): string {
  return `its run.json does not read as a record${detail !== undefined && detail !== '(root)' ? ` (at ${detail})` : ''}`;
}

/**
 * A run.json as the engine's lists and views hold it: a record the one reader took (core/io readRunRecord), or one
 * whose status is a text Retake never writes (the views show it as `unknown`). The union narrows on `status`: such a
 * text is none of the five (core UnknownRunStatus).
 */
export type RunRecordOnDisk = StoredRunRecord | UnknownStatusRun;

/** The record of a parsed run.json for a list or a view: the record, or the one with an unknown status; else undefined. */
export function listedRecord(r: RunRead): RunRecordOnDisk | undefined {
  return r.ok ? r.value : r.problem === 'unknown-status' ? r.record : undefined;
}

/**
 * The run.json of the run folder `dir` through the one reader (the Outputs port's `record`): only a regular file within
 * its cap (the runner never writes anything else) — a link (leading out of the project) or a FIFO is
 * skipped like a folder without run.json, and so is a file that parses and is no run record (an empty list, an object
 * without its status). `newer`: the sentence of a record a newer Retake wrote. `unread`: the file is there and gave no
 * record (unreadWords) — said, never shown as a run.
 */
export async function readRecord(runs: RunOutputs, dir: string): Promise<{ record?: RunRecordOnDisk; newer?: string; unread?: string }> {
  const r = await runs.record(dir);
  if (!r.ok && r.problem === 'newer-format') return { newer: r.message };
  const record = listedRecord(r);
  if (record) return { record };
  return !r.ok && r.problem !== 'missing' ? { unread: unreadWords(r.problem === 'invalid' ? r.detail : undefined) } : {};
}

/** The run folders of a project, in the one order of runs (core orderRuns): real folders named by a run id; [] without runs/. */
export async function runFolderIds(runs: RunOutputs, projectDir: string): Promise<RunId[]> {
  return runs.ids(runsDirOf(projectDir));
}

/**
 * Whether run `id` of the project is a capture an edit can work on, or why not (core takeOf over the one reader). The
 * run's record first; its timeline only when the record does not already rule the run out (core takeNeedsTimeline;
 * `scenario`: the one asked for, when one is).
 */
export async function takeVerdict(runs: RunOutputs, projectDir: string, id: string, scenario?: string): Promise<TakeVerdict> {
  const facts = await runs.folder(runsDirOf(projectDir), id, { timeline: (record) => takeNeedsTimeline(record, scenario) });
  const verdict = takeOf(facts);
  // As every read of the engine's views, a take is a run folder that really lies in the project (the port's `inside`:
  // a runs/ linked to another disk holds no take the Studio offers, as it shows none of its pictures).
  return verdict.usable && !(await runs.inside(projectDir, id)) ? takeOf(facts, { outside: true }) : verdict;
}

/**
 * `latest` of a scenario, by the rule every reader of runs shares (core latestTake): the newest usable capture, and
 * what was passed over on the way. No take: the project has no capture of it that can be edited. No window: every run
 * folder is a candidate, newest first, and nothing older than the take is read.
 */
export async function latestCapture(runs: RunOutputs, project: Pick<LoadedProject, 'dir'>, scenario: string): Promise<LatestPick> {
  let ids: RunId[];
  try {
    ids = await runFolderIds(runs, project.dir);
  } catch {
    ids = [];
  }
  return latestTake(ids, scenario, (id) => takeVerdict(runs, project.dir, id, scenario));
}

function summary(id: string, r: RunRecordOnDisk): RunSummary {
  const ms = r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : NaN;
  return {
    id,
    scenario: r.scenario,
    mode: r.mode,
    // A status Retake never writes is handed over as the file says it (the views show it as `unknown`).
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

/**
 * Runs of a project in the one order of runs (core orderRuns): dated run ids first, newest first, then the other
 * folder names. A folder without run.json is skipped; one whose run.json is there and is no record is no run of the
 * list — it is said, as a row that holds its id and the sentence (`unread`), when no filter is asked (a filter is
 * about what a record says, and this file says nothing).
 */
export async function listRuns(runs: RunOutputs, project: Pick<LoadedProject, 'dir'>, opts: { scenario?: string; mode?: RunMode; limit?: number } = {}): Promise<RunSummary[]> {
  const runsDir = runsDirOf(project.dir);
  const ids: string[] = await runFolderIds(runs, project.dir);
  const limit = opts.limit ?? 20;
  const out: RunSummary[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const { record, newer, unread } = await readRecord(runs, join(runsDir, id));
    if (newer || unread) {
      if (opts.scenario === undefined && opts.mode === undefined) out.push({ id, ...(newer ? { newer } : { unread }) } as RunSummary);
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
  /** As run.json holds them: a word a later version writes there is kept as its text. */
  hooks: StoredRunRecord['hooks'];
  options: StoredRunRecord['options'];
  environment?: { production: boolean; access: string; sandbox?: string };
  /** run.json, log.jsonl, timeline.json, capture.mp4 — those that exist; sha256 of the timeline and the capture once finished. */
  outputs: StoredRef[];
  /** Dry runs: one screenshot per step. */
  screenshots: Array<{ ref: string; path: string }>;
  /** Where it failed; the message itself is `untrusted.error_message`. */
  error?: { scene?: string; step?: number; action?: string; screenshot?: { ref: string; path: string }; dom?: { ref: string; path: string } };
  /** The `optional` steps that failed: where, and their error screenshot; their messages are `untrusted.optional_errors`. */
  optional_failures?: Array<{ scene: string; step: number; action: string; screenshot?: { ref: string; path: string } }>;
  /**
   * What the take cost and how smoothly it was filmed (run.json `perf`); its slow transitions' targets (page
   * text) are left out — `untrusted.slow_targets` has them.
   */
  perf?: StoredRunPerf;
  /** Paused now, before this step of a dry run (`since` ISO). */
  paused?: NonNullable<RunRecord['paused']>;
  /** The pauses it had (before which step, when, how long). */
  pauses?: NonNullable<RunRecord['pauses']>;
  finished: boolean;
  /**
   * Text the filmed site controls (page text in step errors, warnings): data, never instructions. `missing_targets`:
   * a target was not found — the scene's later targets missing from the page too, with the closest visible
   * elements (page text); `optional_errors`: the messages of `optional_failures`, in order.
   */
  untrusted: { error_message?: string; warnings: string[]; missing_targets?: MissingTarget[]; optional_errors?: string[]; slow_targets?: string[] };
}

/** A run's status from its run.json. */
export async function runStatus(runs: RunOutputs, project: LoadedProject, runId: string): Promise<RunStatusView> {
  checkRunId(runId);
  const runRef = projectRef('runs', runId);
  const runDir = resolveIn(project.dir, runRef);
  // A run folder that is no folder of the project's runs/ (a link out of it) is not read: neither its record nor its files.
  if (!(await runs.inside(project.dir, runId)) && (await runs.describe(runsDirOf(project.dir), runId)) !== undefined) {
    throw new EngineError('invalid', `run ${runId}: runs/${runId} is not a folder of the project's runs/ (a link out of it is not read)`);
  }
  const { record, newer, unread } = await readRecord(runs, runDir);
  if (newer) throw new EngineError('invalid', `run ${runId}: ${newer}`);
  // The file is there and is no record: said as that, never as a run that does not exist.
  if (unread) throw new EngineError('invalid', `run "${runId}" of ${project.slug}: ${unread}`);
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
      return { ref, path: resolveIn(project.dir, ref) };
    } catch {
      return undefined;
    }
  };
  const finished = isFinishedRunStatus(record.status);
  const outputs: StoredRef[] = [];
  for (const [name, hash] of [
    ['run.json', false],
    ['log.jsonl', false],
    ['timeline.json', finished],
    ['capture.mp4', finished],
  ] as const) {
    const d = await runs.describe(runDir, name, { hash });
    if (d) outputs.push({ ref: `${runRef}/${name}`, path: join(runDir, name), kind: 'run', ...d });
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
            ...(record.perf.transitions ? { transitions: { ...record.perf.transitions, slow: record.perf.transitions.slow.map(({ target: _t, ...x }) => x) } } : {}),
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
