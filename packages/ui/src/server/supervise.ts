/**
 * The supervised server's lines to the desktop shell (L5.2b, DESIGN §4j): after the `ui` line, `retake ui --supervised`
 * writes on stdout, one JSON object per line, at most PIPE_LINE_MAX bytes each, each line framed by a newline before
 * and after (review A L3: a stray partial write of another module on stdout becomes a line of its own, which the shell
 * ignores, never glued to the next state):
 *
 * - `{"type":"pending","jobs":[{kind,state,project,scenario?}…],"jobs_total","unsaved":[{kind,project?,scenario?}…],
 *   "unsaved_total"}` — what Quit would leave behind, whole, at start and on every change: coalesced (at most one write
 *   per PENDING_GAP_MS, the last state always written), latest-wins while stdout is full (nothing queues);
 * - `{"type":"job_end","kind","outcome","reason"?,"project","scenario"?}` — once per job that ends while the server
 *   runs (at most JOB_END_PER_MIN a minute; more are counted on stderr);
 * - L5.12d: `{"type":"shown","id","shown":true}` / `{"type":"answer","id","answer"}` — the window page's word on the
 *   quit question (desktop.ts `desktop_answer`), written as the op runs.
 *
 * Words live in the shell: every field is an enum it knows or a slug it checks again — never a path, a message, a URL
 * or page text. A hand-edited job.json is data: its project and scenario are named only when they pass the slug rules
 * AND exist (`<projects>/<project>/project.yaml`, `scenarios/<scenario>.yaml`: review A L1), as the unsaved board does —
 * slugs are still words a person or an agent chose, so the shell also cuts a long one when it shows it.
 * The job watch (engine JobsWatch, polled every PIPE_POLL_MS for the server's life, nudged after a Studio write op)
 * takes stock first: jobs finished before the server started never give a `job_end`. Jobs of the workspace's queue
 * count — the guard and the notifications alike — whoever queued them: the Studio (any window or tab on this server)
 * or Claude through MCP. A terminal's `retake run` / `render` / `export` / `record` runs in-process, writes no job and
 * is neither asked about nor notified (review B L1). Kinds that count: captures and dry runs, renders, reviews,
 * exports, recordings (`studio_recording` when the Studio started it: its controls are on the Record screen, review B
 * L5), sandbox starts and resets, environment resets and hooks that are not dry. A queued job with no live worker is
 * left out (critique M2: nothing runs it until the next submit starts one — it would hold Quit for nothing).
 * The watch reads each live job once per poll (its record is reused: review B L15); the event stream's own watch
 * (live.ts) is a second reader while a page is open — one shared watch is BL-125.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { JobsWatch, liveWorker, submittedInStudio } from '@retake/engine';
import type { JobQueueView, JobRecord } from '@retake/engine';
import type { UnsavedBoard, UnsavedItem } from './unsaved.js';
import type { DesktopPipe } from './desktop.js';
import { SLUG_RE } from '@retake/core/model';
import { renderSuffix } from '@retake/core/ids';
import { PROJECT_SLUG_RE, projectPath } from '@retake/core/project';
import type { JobClient } from '@retake/engine';

/** The kinds on the pipe: the shell's words are keyed by them. */
export const PIPE_KINDS = ['capture', 'dry_run', 'render', 'review', 'export', 'recording', 'studio_recording', 'hooks', 'env_reset', 'sandbox_start', 'sandbox_reset'] as const;
export type PipeKind = (typeof PIPE_KINDS)[number];
export const PIPE_OUTCOMES = ['succeeded', 'failed', 'attention'] as const;
export type PipeOutcome = (typeof PIPE_OUTCOMES)[number];
export const PIPE_REASONS = ['run_failed', 'interrupted', 'review_issues', 'check_failed', 'ready_to_save', 'nothing_recorded', 'hooks_failed', 'reset_failed'] as const;
export type PipeReason = (typeof PIPE_REASONS)[number];

/** Longest line written (bytes). */
export const PIPE_LINE_MAX = 8192;
/** Items listed per list (the totals count them all). */
export const PIPE_LIST_MAX = 8;
export const PIPE_POLL_MS = 1000;
export const PENDING_GAP_MS = 250;
export const JOB_END_PER_MIN = 20;
/** Job ids remembered as ended (a job ends once). */
const ENDED_MAX = 1000;

/** The shell's slug rules (desktop_core pipe.rs): a project slug and a scenario name (core's grammars), each of at most 100 characters. */
export const PIPE_NAME_MAX = 100;
export const isPipeProject = (v: string): boolean => v.length <= PIPE_NAME_MAX && PROJECT_SLUG_RE.test(v);
export const isPipeScenario = (v: string): boolean => v.length <= PIPE_NAME_MAX && SLUG_RE.test(v);

export interface PipeJob {
  kind: PipeKind;
  state: 'running' | 'queued';
  project?: string;
  scenario?: string;
}

export interface PendingSnapshot {
  jobs: PipeJob[];
  jobs_total: number;
  unsaved: UnsavedItem[];
  unsaved_total: number;
}

export interface JobEnd {
  kind: PipeKind;
  outcome: PipeOutcome;
  reason?: PipeReason;
  project?: string;
  scenario?: string;
}

type Input = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A job's kind on the pipe; undefined for a kind that never counts — `preview` (the library's posters and loops),
 * `auth_login` (the person is at its window), `inspect` and `site` (Claude's quick tools), dry hooks and dry
 * environment resets. One explicit table (critique L6): `sandbox_up` is `sandbox_start` on the pipe.
 */
export function pipeKind(job: Pick<JobRecord, 'kind' | 'input'>): PipeKind | undefined {
  const i = (job.input ?? {}) as Input;
  switch (job.kind) {
    case 'run':
      return i.mode === 'dry' ? 'dry_run' : 'capture';
    case 'render':
      return 'render';
    case 'review':
      return 'review';
    case 'export':
      return 'export';
    case 'record':
      return submittedInStudio({ submitted_by: i.submitted_by as JobClient | undefined }) ? 'studio_recording' : 'recording';
    case 'hooks':
      return i.dry === false ? 'hooks' : undefined;
    case 'env_reset':
      return i.dry === false ? 'env_reset' : undefined;
    case 'sandbox_up':
      return 'sandbox_start';
    case 'sandbox_reset':
      return 'sandbox_reset';
    case 'preview':
    case 'auth_login':
    case 'inspect':
    case 'site':
      return undefined;
    default: {
      const never: never = job.kind;
      return never;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The project and scenario a job names, each kept only when it passes the shell's slug rule. */
export function jobNames(job: Pick<JobRecord, 'kind' | 'input'>): { project?: string; scenario?: string } {
  const i = (job.input ?? {}) as Input;
  const project = str(i.project);
  let scenario: string | undefined;
  if (job.kind === 'run' || job.kind === 'render' || job.kind === 'record') scenario = str(i.scenario);
  else if (job.kind === 'review' || job.kind === 'export') {
    // The id without its last "-v<N>[-vertical|-square]"; an id without one, whole (a record written with --out).
    const id = str(i.render_id);
    scenario = id === undefined ? undefined : (renderSuffix(id)?.stem ?? id);
  } else if (job.kind === 'hooks') scenario = /^([^:]+):(?:setup|teardown)$/.exec(str(i.source) ?? '')?.[1];
  return {
    ...(project !== undefined && isPipeProject(project) ? { project } : {}),
    ...(scenario !== undefined && isPipeScenario(scenario) ? { scenario } : {}),
  };
}

/**
 * How a finished job ended, for a notification; null: no notification (a cancel — someone asked for it — or a run
 * whose own status is cancelled).
 */
export function jobOutcome(job: Pick<JobRecord, 'kind' | 'state' | 'result'>): { outcome: PipeOutcome; reason?: PipeReason } | null {
  if (job.state === 'cancelled') return null;
  if (job.state === 'interrupted') return { outcome: 'failed', reason: 'interrupted' };
  if (job.state === 'failed') return { outcome: 'failed' };
  if (job.state !== 'succeeded') return null;
  const r = (job.result ?? {}) as Input;
  switch (job.kind) {
    case 'run':
      if (r.status === 'failed') return { outcome: 'failed', reason: 'run_failed' };
      if (r.status === 'cancelled') return null;
      break;
    case 'render': {
      const review = r.review as Input | undefined;
      if (review?.state === 'succeeded' && review.clean === false) return { outcome: 'attention', reason: 'review_issues' };
      break;
    }
    case 'review':
      if (r.clean === false) return { outcome: 'attention', reason: 'review_issues' };
      break;
    case 'record': {
      if (r.not_saved === 'nothing_recorded') return { outcome: 'attention', reason: 'nothing_recorded' };
      if ((r.check as Input | undefined)?.status === 'failed') return { outcome: 'attention', reason: 'check_failed' };
      if (r.not_saved === 'studio') return { outcome: 'attention', reason: 'ready_to_save' };
      if (r.not_saved !== undefined) return { outcome: 'attention' };
      break;
    }
    case 'hooks':
      if (r.ok === false) return { outcome: 'failed', reason: 'hooks_failed' };
      break;
    case 'env_reset':
      if (r.ok === false) return { outcome: 'failed', reason: 'reset_failed' };
      break;
    default:
      break;
  }
  return { outcome: 'succeeded' };
}

/** An unsaved item with only the names that pass the shell's slug rules. */
function pipeItem(i: UnsavedItem): UnsavedItem {
  return {
    kind: i.kind,
    ...(i.project !== undefined && isPipeProject(i.project) ? { project: i.project } : {}),
    ...(i.project !== undefined && isPipeProject(i.project) && i.scenario !== undefined && isPipeScenario(i.scenario) ? { scenario: i.scenario } : {}),
  };
}

/** The `pending` line (no newline): the lists cut to PIPE_LIST_MAX, emptied (totals kept) if it would pass PIPE_LINE_MAX. */
export function pendingLine(s: PendingSnapshot): string {
  const line = JSON.stringify({ type: 'pending', jobs: s.jobs.slice(0, PIPE_LIST_MAX), jobs_total: s.jobs_total, unsaved: s.unsaved.slice(0, PIPE_LIST_MAX), unsaved_total: s.unsaved_total });
  if (Buffer.byteLength(line) < PIPE_LINE_MAX) return line;
  return JSON.stringify({ type: 'pending', jobs: [], jobs_total: s.jobs_total, unsaved: [], unsaved_total: s.unsaved_total });
}

/** The `job_end` line (no newline), or undefined past PIPE_LINE_MAX (it cannot be, with the slug caps). */
export function jobEndLine(e: JobEnd): string | undefined {
  const line = JSON.stringify({ type: 'job_end', ...e });
  return Buffer.byteLength(line) < PIPE_LINE_MAX ? line : undefined;
}

/** Where the lines go: stdout's own write (captured before anything could replace it), and its drain event. */
export interface PipeOut {
  write(text: string): boolean;
  once(event: 'drain', f: () => void): unknown;
}

export interface SupervisorOptions {
  root: string;
  /** The engine's job queue (Engine.queue): the supervisor's watch reads it with a memory of its own (withOwnMemory). */
  queue: JobQueueView;
  /** The workspace's projects folder (names are kept only for what exists there); default `<root>/projects`. */
  projectsDir?: string;
  board: UnsavedBoard;
  out: PipeOut;
  pollMs?: number;
  gapMs?: number;
  /** stderr diagnostics (counts only). */
  log?: (message: string) => void;
  /** Whether a worker holds the workspace's lock now (tests inject it). */
  workerAlive?: () => Promise<boolean>;
}

export class Supervisor {
  private readonly watch: JobsWatch;
  private readonly jobs = new Map<string, JobRecord>();
  /** The names of each job in `jobs` that pass the slug rules and exist (looked up once, when it is first seen). */
  private readonly names = new Map<string, { project?: string; scenario?: string }>();
  private readonly ended = new Set<string>();
  private worker = false;
  private stocked = false;
  private polling: Promise<void> | undefined;
  private again = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private pushTimer: NodeJS.Timeout | undefined;
  private blocked = false;
  private lastLine: string | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private endWindow = { start: 0, count: 0, dropped: 0 };
  private stopped = false;
  private readonly unsubscribe: () => void;
  /** Lines written (pending and job_end): tests. */
  written = 0;

  constructor(private readonly o: SupervisorOptions) {
    this.watch = new JobsWatch(o.queue.withOwnMemory());
    this.unsubscribe = o.board.onChange(() => this.schedulePush());
  }

  /** Start polling (the first poll takes stock, then writes the first `pending`). */
  start(): this {
    void this.nudge();
    return this;
  }

  /** Poll now (after a Studio write op: a submit shows at once); polls in flight are not doubled. */
  nudge(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    clearTimeout(this.pollTimer);
    this.polling = (async () => {
      do {
        this.again = false;
        try {
          await this.poll();
        } catch (e) {
          this.o.log?.(`job watch: ${e instanceof Error ? e.name : 'error'}`);
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.polling = undefined;
      if (!this.stopped) this.pollTimer = setTimeout(() => void this.nudge(), this.o.pollMs ?? PIPE_POLL_MS);
    });
    return this.polling;
  }

  private async poll(): Promise<void> {
    const changed = await this.watch.poll();
    if (!this.stocked) {
      // Taking stock: the unfinished jobs only — none of the history gives a job_end.
      this.stocked = true;
      for (const id of this.watch.unfinished) {
        const job = this.watch.record(id);
        if (job) await this.keep(job);
      }
    }
    for (const id of changed) {
      // The record the watch read in this poll (review B L15: no second read — no second `ps` per live job).
      const job = this.watch.record(id);
      if (!job) {
        this.forget(id);
        continue;
      }
      if (job.state === 'queued' || job.state === 'running') await this.keep(job);
      else {
        const names = this.names.get(id) ?? (await this.checkedNames(job));
        this.forget(id);
        this.end(job, names);
      }
    }
    const live = new Set(this.watch.unfinished);
    for (const id of [...this.jobs.keys()]) if (!live.has(id)) this.forget(id);
    const queued = [...this.jobs.values()].some((j) => j.state === 'queued' && pipeKind(j));
    this.worker = queued ? await (this.o.workerAlive ?? (async () => (await liveWorker(this.o.root)) !== null))() : false;
    this.schedulePush();
  }

  /** `job`'s names that pass the slug rules and exist in the workspace (review A L1). */
  private async checkedNames(job: JobRecord): Promise<{ project?: string; scenario?: string }> {
    const n = jobNames(job);
    if (n.project === undefined) return {};
    const dir = join(this.o.projectsDir ?? join(this.o.root, 'projects'), n.project);
    if (!(await exists(join(dir, 'project.yaml')))) return {};
    return n.scenario !== undefined && (await exists(projectPath(dir, 'scenarios', `${n.scenario}.yaml`))) ? n : { project: n.project };
  }

  private async keep(job: JobRecord): Promise<void> {
    if (!this.names.has(job.id)) this.names.set(job.id, await this.checkedNames(job));
    this.jobs.set(job.id, job);
  }

  private forget(id: string): void {
    this.jobs.delete(id);
    this.names.delete(id);
  }

  /** What Quit would leave behind now. */
  snapshot(): PendingSnapshot {
    const jobs: PipeJob[] = [];
    for (const [, j] of [...this.jobs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const kind = pipeKind(j);
      if (!kind || (j.state !== 'running' && j.state !== 'queued')) continue;
      if (j.state === 'queued' && !this.worker) continue;
      jobs.push({ kind, state: j.state, ...this.names.get(j.id) });
    }
    const unsaved = this.o.board.items().map(pipeItem);
    return { jobs, jobs_total: jobs.length, unsaved, unsaved_total: unsaved.length };
  }

  private end(job: JobRecord, names: { project?: string; scenario?: string }): void {
    if (this.ended.has(job.id)) return;
    this.ended.add(job.id);
    if (this.ended.size > ENDED_MAX) this.ended.delete(this.ended.values().next().value as string);
    const kind = pipeKind(job);
    const o = kind ? jobOutcome(job) : null;
    if (!kind || !o) return;
    const now = Date.now();
    const w = this.endWindow;
    if (now - w.start >= 60_000) {
      if (w.dropped > 0) this.o.log?.(`${w.dropped} job end(s) not sent to the app (more than ${JOB_END_PER_MIN} a minute)`);
      this.endWindow = { start: now, count: 0, dropped: 0 };
    }
    if (this.endWindow.count >= JOB_END_PER_MIN) {
      this.endWindow.dropped++;
      return;
    }
    const line = jobEndLine({ kind, ...o, ...names });
    if (!line) return;
    this.endWindow.count++;
    this.write(line);
  }

  private write(line: string): boolean {
    this.written++;
    // Framed (review A L3): a partial write of another module before it ends as a line of its own.
    const ok = this.o.out.write(`\n${line}\n`);
    if (!ok && !this.blocked) {
      this.blocked = true;
      this.o.out.once('drain', () => {
        this.blocked = false;
        this.schedulePush();
      });
    }
    return ok;
  }

  /** A `pending` write soon: at most one per gap, the latest state when it runs, none while stdout is full. */
  private schedulePush(): void {
    if (this.stopped || this.pushTimer || this.blocked || !this.stocked) return;
    const wait = Math.max(0, this.lastWriteAt + (this.o.gapMs ?? PENDING_GAP_MS) - Date.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (this.stopped || this.blocked) return;
      const line = pendingLine(this.snapshot());
      if (line === this.lastLine) return;
      this.lastLine = line;
      this.lastWriteAt = Date.now();
      this.write(line);
    }, wait);
  }

  /**
   * A line of the window's page (L5.12d desktop.ts: `shown` / `answer`): framed like the others and written even while
   * stdout is full (Node keeps it: an answer is never dropped); not counted in `written`. False once stopped: nothing
   * written (review B-L6: `desktop_answer` then says so).
   */
  pageLine(line: string): boolean {
    if (this.stopped) return false;
    this.o.out.write(`\n${line}\n`);
    return true;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.pushTimer);
    this.unsubscribe();
  }
}

/**
 * The supervisor of a Studio server (`retake ui --supervised`, owned): writes the lines on `out`, polls until
 * `server.close()` (which stops it first), polls again after each Studio write op.
 */
export function startSupervisor(o: {
  server: {
    engine: { workspace: { root: string; projectsDir: string }; queue: JobQueueView };
    unsaved: UnsavedBoard;
    desktop?: DesktopPipe;
    onWrite(f: () => void): () => void;
    close(): Promise<void>;
  };
  out: PipeOut;
  pollMs?: number;
  log?: (message: string) => void;
}): Supervisor {
  const sup = new Supervisor({
    root: o.server.engine.workspace.root,
    queue: o.server.engine.queue,
    projectsDir: o.server.engine.workspace.projectsDir,
    board: o.server.unsaved,
    out: o.out,
    ...(o.pollMs ? { pollMs: o.pollMs } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  const off = o.server.onWrite(() => void sup.nudge());
  // L5.12d: the window page's ack and answer to the quit question go out on the same pipe.
  o.server.desktop?.attach((line) => sup.pageLine(line));
  const close = o.server.close;
  o.server.close = () => {
    sup.stop();
    off();
    return close();
  };
  return sup.start();
}
