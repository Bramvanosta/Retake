/** The shapes of a recording (record.ts): what is asked, what it runs through, where it starts and what it gives. */
import type { Secrets } from './secrets/secrets.js';
import type { EngineEnv } from './env.js';
import type { ResolvedEnvironment } from '@retake/core/environment';
import type { ResolvedPersona } from '@retake/core/environment';
import type { DraftIssue, RecordedEvent, RunProgress } from '@retake/core/run';
import type { JobClient } from './jobs/job-input.js';
import type { RecordSessionOptions, RecordSessionResult } from '@retake/runner-web/types';
import type { CaptureRunner } from './capture/runner.js';
import type { HookRunner } from './hook-run/runner.js';
import type { JobQueueView } from './jobs/job-queue.js';
import type { Clock } from './clock.js';
import type { ProjectStores } from './store/store.js';

export interface RecordRequest {
  env?: string;
  /** The persona the window is signed in as (`none`: signed out); default the persona whose `pages` list the page. */
  persona?: string;
  /** The environment page the window opens (default: the persona's first page, else the environment's first). */
  page?: string;
  /** A path under the page (default `/`). */
  path?: string;
  /** Instead of page + path: an http(s) URL on the exact origin of one of the environment's pages. */
  url?: string;
  /** The scenario's name (default recorded-YYYYMMDD-HHMM). Saved only when it is free. */
  name?: string;
  /** `--allow-writes` (a production environment whose project.yaml allows writes), as `retake run`. */
  allowWrites?: boolean;
  /** The check replay after the recording (default true). */
  check?: boolean;
  /** The draft is saved under agent trust (an MCP submission: agent-trust issues refuse it). */
  agent?: boolean;
  submittedBy?: JobClient;
  /** The recording's id, reserved by a `record` job at submit (default: a new one). */
  id?: string;
  /** The `record` job that runs it (meta.json's job_id; none for `retake record`). */
  jobId?: string;
}

export interface RecordPorts {
  /** The workspace's job queue: a recording whose job is queued or running is never pruned. */
  queue: JobQueueView;
  /** What the recording is stamped with (its composition root's clock). */
  clock: Clock;
  /** The environment its composition root read (env.ts): the time limit a person set, whether a window has a display. */
  env: EngineEnv;
  /** What the draft scenario is saved through. */
  stores: ProjectStores;
  /** What opens the window, checks and signs the persona in, and replays the draft (its composition root's). */
  capture: CaptureRunner;
  /** What its secret references are resolved with (its composition root's Secrets port). */
  secrets: Secrets;
  /** What the check replay's hooks would run through (a dry replay: none run). */
  hooks: HookRunner;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** What the recording does now. */
  onPhase?: (phase: 'preflight' | 'recording' | 'draft' | 'check') => void;
  /** The window shows its first page: the person can start. */
  onOpen?: (url: string) => void;
  /** Each event kept while recording (count it; never print its page text). */
  onEvent?: (e: RecordedEvent) => void;
  /** The check replay's progress. */
  onCheckProgress?: (e: RunProgress) => void;
  /** Stop and keep (Ctrl-C, a worker signal). */
  stop?: AbortSignal;
  /** Asked once the recording ended: true skips the check replay (a worker stopped by a signal keeps the draft only). */
  skipCheck?: () => boolean;
  /** Append the recording's history line (default true; a job's line is the worker's). */
  history?: boolean;
  /** Cancel: while recording, nothing is kept; after it, the check replay stops. */
  signal?: AbortSignal;
  /** Who stands behind the check replay (`mcp`: agent trust in the runner). */
  hookTrust?: 'author' | 'mcp';
  loginCommand?: (p: { project: string; env: string; persona?: string }) => string;
  /** Test hooks (runner-web recordSession): Playwright plays the person; the window runs headless; its size. */
  drive?: RecordSessionOptions['drive'];
  headless?: boolean;
  windowSize?: { width: number; height: number };
}

/** What the check replay found (the error's text is page-derived: `untrusted`). */
export interface RecordCheck {
  status: 'passed' | 'failed' | 'skipped' | 'cancelled';
  /** all: the whole draft (a read-only environment); until_write: up to the step before the first write. */
  scope: 'all' | 'until_write' | null;
  /** The last step replayed (`scene.step`) when the replay stopped before the first write. */
  until?: string;
  /** Why it was skipped. */
  reason?: 'disabled' | 'stopped' | 'nothing_recorded' | 'invalid_draft' | 'first_step_writes';
  steps_passed: number;
  steps_total: number;
  failed_at?: { scene: string; step: number; action: string };
  /** The check's run folder (run.json; the error screenshot when it failed). */
  dir?: string;
  untrusted?: { error: string };
}

export interface RecordOutcome {
  rec_id: string;
  /** The recording's folder (null when nothing was recorded: it was removed). */
  dir: string | null;
  /** draft.yaml (null when nothing was recorded). */
  draft: string | null;
  name: string;
  saved: { file: string; path: string; hash: string } | null;
  /** studio: a recording the Studio started — the person saves it from the Record screen. */
  not_saved?: 'name_taken' | 'invalid' | 'nothing_recorded' | 'refused' | 'studio';
  env: string;
  persona: string | null;
  access: 'read-only' | 'read-write';
  stop: RecordSessionResult['stop'];
  ms: number;
  window: { width: number; height: number } | null;
  capture: { width: number; height: number };
  counts: RecordSessionResult['counts'];
  stats: { scenes: number; steps: number; actions: number; noise: number; secrets: number; fallbacks: number };
  /** The draft's scenes (ids are slugs made from paths) and their step counts. */
  scenes: Array<{ id: string; steps: number; opens: boolean }>;
  /** The draft's issues (never page text; scene / step say where). */
  issues: DraftIssue[];
  /** The recording's warnings (never page text). */
  warnings: string[];
  /** Writes to the environment's hosts while recording (their labels are in record.json). */
  writes: { total: number; by_steps: number; ambient: number; first: { scene: string; step: number } | null };
  check: RecordCheck;
}

/** The start of a recording: environment, persona, page URL (checked before any window opens). */
export interface RecordStart {
  env: ResolvedEnvironment;
  persona: ResolvedPersona | null;
  page: string;
  path: string;
  url: string;
  /** Default persona of each page (null: none); undefined when the environment has no personas. */
  defaultPersonas?: Record<string, string | null>;
}
