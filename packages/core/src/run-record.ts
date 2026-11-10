/**
 * The run record (runs/<id>/run.json) as a union of states, the only functions that change a run's status, and the
 * parse boundary of the two files a run folder is read by: run.json and the head of timeline.json.
 *
 * Two types, on purpose. `RunRecord` is what this version writes: a queued run has nothing of a run, a running
 * one has no end, a succeeded one has its end and neither an error nor a current step, a failed or cancelled one has
 * its end and its error — and may still say where it was (`current`, `paused`) and what it had filmed, because that is
 * what a run closed from outside keeps. `StoredRunRecord` is what any version left on a disk: the same states, with
 * every member that decides nothing read leniently: the two diagnostic blocks (`engine`, `perf`) ask for less, a closed
 * word is any text, and a member that does not read is left out — a record is refused only for what the two rules and
 * the union need (its id, scenario, kind, status and what that state has or never has). A written record is a stored
 * one, not the reverse.
 *
 * Pure: no I/O, no clock (a transition takes its time as an argument). Reading the files is core/io run-folder.ts.
 */
import { FORMAT_VERSIONS, newerFormatMessage } from './formats.js';
import type { RunId } from './id-grammar.js';
import { z } from 'zod';
import { StoredRunEngineSchema, StoredRunPerfSchema, StoredRunRecordSchema, StoredRunStateSchemas, UnknownStatusRunSchema } from './schemas/timeline.js';
import type { EnvironmentAccess, OptionalFailure, RunEngine, RunError, RunMode, RunOutlineStep, RunPause, RunPerf, RunPerfCpu, RunSandbox, RunSessionStatus, Timeline, TimelineEvent } from './types.js';

// ── The states ───────────────────────────────────────────────────────────────

/** Members a state never has (reading one gives undefined; writing one does not compile, on a state or on the union). */
type No<K extends string> = { readonly [P in K]?: never };

/** What every state of a run record holds, the two diagnostic blocks aside. */
interface RunCommon {
  /** Format version (1; absent in runs made before L1.4: read as 1). */
  version?: 1;
  id: string;
  project: string;
  scenario: string;
  mode: RunMode;
  started_at: string;
  /** Absolute run directory (of the machine that filmed). */
  dir: string;
  env: string;
  /** `allow_writes`: `--allow-writes` was given and accepted (production with `access: read-write`). */
  options: { until?: string; hooks: 'run' | 'skip'; headed: boolean; cursor?: 'hidden'; allow_writes?: true };
  /**
   * The environment's safety (L1.7): production, the run's effective access, the product's clock (as written, the zone
   * a time without an offset is read in, frozen or not).
   */
  environment?: { production?: true; access: EnvironmentAccess; clock?: { at: string; timezone?: string; freeze?: true }; sandbox?: RunSandbox };
  steps_total: number;
  steps_done: number;
  /** One screenshot per step: a dry run's, or a capture's with `capture.step_shots` (L5.6). */
  screenshots: string[];
  hooks: {
    setup: 'ok' | 'failed' | 'skipped' | 'none';
    teardown: 'ok' | 'failed' | 'skipped' | 'none';
    /** `hook:` steps (L5.8; absent when the scenario has none): ok, a step's hook failed, or skipped with the hooks. */
    steps?: 'ok' | 'failed' | 'skipped';
  };
  warnings: string[];
  /** The `optional` steps that failed, in order (L5.6; absent when none did). */
  optional_failures?: OptionalFailure[];
  /** The reason the run stopped early (a dry run's irreversible step, --until). */
  stopped_at?: { scene: string; step: number; reason: 'irreversible' | 'until' };
  /** L4.4: the pauses it had, in order (before which step, when, how long); absent when none. */
  pauses?: RunPause[];
}

/** What every state of a record this version writes holds. */
export interface RunBase extends RunCommon {
  /** What ran it (absent in runs made before L1.4, and in a queued run). */
  engine?: RunEngine;
  /** What the take cost and how smoothly it was filmed (L5.7; captures only). */
  perf?: RunPerf;
}

/** run.json `engine` as any version left it: every member optional (keys this build does not know are kept, unnamed). */
export type StoredRunEngine = Partial<RunEngine>;
/** run.json `perf.cpu` as any version left it: `retake` optional. */
export type StoredRunPerfCpu = Omit<RunPerfCpu, 'retake'> & { retake?: number };
/** run.json `perf` as any version left it. */
export type StoredRunPerf = Omit<RunPerf, 'cpu'> & { cpu?: StoredRunPerfCpu };

/** A closed word as any version left it: one of the words this version writes, or any other text (kept as the file holds it). */
export type StoredWord<W extends string> = W | (string & {});
/** run.json `environment.sandbox` as any version left it: its name; the rest is whatever the file holds. */
export type StoredRunSandbox = { name: string } & { [K in Exclude<keyof RunSandbox, 'name'>]?: unknown };

/**
 * What every state of a record read from a disk holds. The members that decide nothing are read leniently: a closed
 * word is any text, a flag any boolean (`StoredWord`; what this version writes is still assignable).
 */
export interface StoredRunBase extends Omit<RunCommon, 'options' | 'environment' | 'hooks' | 'stopped_at'> {
  options: { until?: string; hooks: StoredWord<'run' | 'skip'>; headed: boolean; cursor?: StoredWord<'hidden'>; allow_writes?: boolean };
  environment?: { production?: boolean; access: StoredWord<EnvironmentAccess>; clock?: { at: string; timezone?: string; freeze?: boolean }; sandbox?: StoredRunSandbox };
  hooks: { setup: StoredWord<'ok' | 'failed' | 'skipped' | 'none'>; teardown: StoredWord<'ok' | 'failed' | 'skipped' | 'none'>; steps?: StoredWord<'ok' | 'failed' | 'skipped'> };
  stopped_at?: { scene: string; step: number; reason: StoredWord<'irreversible' | 'until'> };
  engine?: StoredRunEngine;
  perf?: StoredRunPerf;
}

/** The step a run is at (or was at when it was closed from outside). */
export type RunCurrent = { scene: string; step: number; action: string };
/** L4.4: a run paused now, before this step; `since` ISO time. */
export type RunPaused = { scene: string; step: number; since: string };
/** Where a run is and what it has filmed so far. */
interface InFlight {
  current?: RunCurrent;
  paused?: RunPaused;
  capture?: string;
  timeline?: string;
}

// The three members that decide a state — its status, its end, its error — are read-only in every state, so on the
// union too: a status changes through the transitions below, never by an assignment (what a run is at and what it has
// filmed stay writable on a running record: the runner fills them in as it goes).
type Queued<B> = B & { readonly status: 'queued' } & No<'finished_at' | 'error' | 'current' | 'paused' | 'capture' | 'timeline'>;
type Running<B> = B & { readonly status: 'running' } & InFlight & No<'finished_at' | 'error'>;
type Succeeded<B> = B & { readonly status: 'succeeded'; readonly finished_at: string; capture?: string; timeline?: string } & No<'error' | 'current' | 'paused'>;
type Failed<B> = B & { readonly status: 'failed'; readonly finished_at: string; readonly error: RunError } & InFlight;
type Cancelled<B> = B & { readonly status: 'cancelled'; readonly finished_at: string; readonly error: RunError } & InFlight;

/** A run reserved by a job, before it starts: nothing of a run yet. */
export type QueuedRun = Queued<RunBase>;
/** A run in flight. */
export type RunningRun = Running<RunBase>;
/** A run that ended well: its end, never an error nor a current step. */
export type SucceededRun = Succeeded<RunBase>;
/** A run that failed: its end and its error; `current` and `paused` only when it was closed from outside. */
export type FailedRun = Failed<RunBase>;
/** A run that was cancelled: as a failed one. */
export type CancelledRun = Cancelled<RunBase>;

/** runs/<id>/run.json as this version writes it — written at start, updated during the run and at the end. */
export type RunRecord = QueuedRun | RunningRun | SucceededRun | FailedRun | CancelledRun;
export type FinishedRun = SucceededRun | FailedRun | CancelledRun;

/** runs/<id>/run.json as any version left it on a disk (parseRunRecord answers one). */
export type StoredRunRecord = Queued<StoredRunBase> | Running<StoredRunBase> | Succeeded<StoredRunBase> | Failed<StoredRunBase> | Cancelled<StoredRunBase>;

declare const unknownRunStatus: unique symbol;
/**
 * A status Retake never writes, as the file says it: a text the reader found to be none of the five (parseRunRecord
 * makes it; no literal is one, so a view that hands a status on says `RunStatus | UnknownRunStatus` without a cast).
 */
export type UnknownRunStatus = string & { readonly [unknownRunStatus]: true };

/** A stored record whose status is a text Retake never writes: shown as `unknown`, never taken for a capture. */
export type UnknownStatusRun = StoredRunBase & { readonly status: UnknownRunStatus; readonly finished_at?: string; readonly error?: RunError } & InFlight;

const KNOWN_STATUS: ReadonlySet<string> = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
/**
 * Whether a record read from a disk is in one of the five states (else: its status is a text Retake never writes).
 * After it the union of states narrows on `status` as usual — a comparison with a text cannot tell the two apart by
 * type alone.
 */
export function isKnownRun(record: StoredRunRecord | UnknownStatusRun): record is StoredRunRecord {
  return KNOWN_STATUS.has(record.status);
}

/** Progress events streamed by runners (CLI prints them, MCP stores them). */
export type RunProgress =
  | { type: 'run_start'; run: RunRecord }
  /** L4.4: right after run_start, every step this run executes (`until` and skipped scenes honoured). */
  | { type: 'outline'; steps: RunOutlineStep[] }
  /** L4.4: one per persona, from the preflight (before any setup hook); `detail` may hold page text. */
  | { type: 'session'; persona: string; status: RunSessionStatus; detail?: string }
  /**
   * L4.4: a pause between steps: `paused` before step `step` of `scene` (`max_ms`: the longest it may last before the
   * run stops), `resumed` after `ms` (a capture does not film it). `refused` (with its `reason`) is no longer emitted:
   * runs of part A's lot wrote it for a capture.
   */
  | { type: 'pause'; state: 'paused' | 'resumed' | 'refused'; scene: string; step: number; ms?: number; max_ms?: number; reason?: string }
  | { type: 'hook'; phase: 'setup' | 'teardown' | 'rollback' | 'step'; name: string; status: 'start' | 'ok' | 'failed' | 'skipped'; message?: string }
  | { type: 'scene_start'; scene: string; index: number }
  | { type: 'step_start'; scene: string; step: number; action: string; desc: string }
  | { type: 'step_end'; scene: string; step: number; action: string; status: TimelineEvent['status']; ms: number; message?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'encode'; status: 'start' | 'done'; message?: string }
  | { type: 'run_end'; run: RunRecord };

// ── The transitions: the only way to change a status ─────────────────────────

type Fields<B> = Omit<B, 'id'> & { id: RunId };

/** `fields` with its status after `mode`, where run.json has always had it (the order of a record's members is kept). */
function withStatus<S extends string>(fields: Fields<RunBase>, status: S): Fields<RunBase> & { status: S } {
  const { version, id, project, scenario, mode, ...rest } = fields;
  return { ...(version !== undefined ? { version } : {}), id, project, scenario, mode, status, ...rest };
}

/** The record of a run reserved by a job. */
export function queuedRun(fields: Fields<Omit<RunBase, 'engine' | 'perf' | 'pauses' | 'optional_failures' | 'stopped_at'>>): QueuedRun {
  return withStatus(fields, 'queued');
}

/** The record of a run that starts. */
export function startedRun(fields: Fields<RunBase>): RunningRun {
  return withStatus(fields, 'running');
}

/** How a run ends: when, with which warnings, and either well or with its error. */
export type RunEnd = { at: string; warnings: string[] } & ({ status: 'succeeded' } | { status: 'failed' | 'cancelled'; error: RunError });

/**
 * The record of a run that ends: its status, its end and its warnings, its error on a failure or a cancellation; the
 * step it was at and its pause are dropped. The members keep their order; the end and the error come last.
 */
export function finishRun(run: RunningRun, end: RunEnd): FinishedRun {
  const { current: _current, paused: _paused, ...rest } = run;
  if (end.status === 'succeeded') return { ...rest, status: 'succeeded', warnings: end.warnings, finished_at: end.at };
  return { ...rest, status: end.status, warnings: end.warnings, finished_at: end.at, error: end.error };
}

/**
 * A reserved run closed from outside (its job failed or was cancelled before the runner ended it). The lenient one: it
 * takes whatever run.json held — a record the reader refuses must still be closed —, keeps every member (where the
 * run was, what it had filmed, an error's other members) and writes the status, the end and the message.
 */
export function closeReservedRun(
  run: { status: 'queued' | 'running' } & Record<string, unknown>,
  end: { status: 'failed' | 'cancelled'; at: string; message: string },
): Record<string, unknown> {
  return { ...run, status: end.status, finished_at: end.at, error: { ...((run.error ?? {}) as object), message: end.message } };
}

// ── The parse boundary ───────────────────────────────────────────────────────

/**
 * A member that did not read and was left out of the record (or, for a member every record holds, replaced by its
 * empty value): the member's path, then `-dropped` — `engine-dropped`, `perf-dropped`, `environment-dropped`, …
 */
export type ReadNote = `${string}-dropped`;

/** Why a file gave no value: it is not there, cannot be read, is too big, is no regular file, is no JSON, or is not what it should be. */
export type FileProblem = 'missing' | 'unreadable' | 'too-big' | 'not-a-file' | 'not-json' | 'invalid';

/**
 * What reading one file answered: the value, or a typed problem — never a throw. `detail` is the path of the first
 * member that does not read (a path, never a value: it may reach a trusted line). `P`: the problems only this kind of
 * file has (a run record's: `RunRead`).
 */
export type Read<T, P = never> = { ok: true; value: T; notes: ReadNote[] } | { ok: false; problem: FileProblem; detail?: string } | P;

/**
 * A run.json made for a newer Retake: its sentence (core formats.ts), and what such a record says of its scenario and
 * its kind, read leniently (for the notice of `latest` only).
 */
export type NewerFormatRead = { ok: false; problem: 'newer-format'; message: string; scenario?: string; dry?: true };
/** A run.json that reads and whose status is a text Retake never writes. */
export type UnknownStatusRead = { ok: false; problem: 'unknown-status'; record: UnknownStatusRun };
/** What reading a run.json answered. */
export type RunRead = Read<StoredRunRecord, NewerFormatRead | UnknownStatusRead>;

/**
 * The members of a timeline the rules read; `film`: `capture.file`, or `capture.mp4` when it names none. `lacks`: the
 * first member a complete head has and this one has not — its run id, or its film's name. A run someone names works
 * without them (a timeline made by hand: the film is then `capture.mp4`); `latest` and every list take a complete
 * head only. The head says nothing of the timeline's lists: the megabytes below it are not looked at, so a head that
 * reads over lists that are none is found by whoever reads the whole timeline (parseTimeline), with its own sentence.
 */
export interface TimelineHead {
  mode: 'capture' | 'dry';
  scenario: string;
  run_id?: string;
  film: string;
  lacks?: 'run_id' | 'capture.file';
}

/** The film of a timeline that names none (a capture's file has always been this one). */
export const DEFAULT_FILM = 'capture.mp4';

/**
 * Whether a film's name is a file of its run folder: one path segment — not empty, not `.` or `..`, no separator of
 * either kind. A run met in a listing is a take only with such a film; through MCP a named run is held to it too.
 */
export function isFilmName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const firstPath = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string => issues[0]?.path.map(String).join('.') || '(root)';
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
const isStatus = (s: string): s is (typeof STATUSES)[number] => KNOWN_STATUS.has(s);

/**
 * The value the schema accepted, as the file held it: the schemas judge and change nothing (no default, no transform),
 * so what was read is what the file says, its members in the file's order. The stored schemas carry the static types
 * of the strict ones (schemas/timeline.ts); `T` is the type the record is read as, which says text where they take text.
 */
function asRead<T>(value: Record<string, unknown>): T {
  return value as T;
}

// ── The lenient read of the members that decide nothing ──────────────────────

/**
 * The members that decide what a record is: never repaired — a record without them, or with a wrong one, is no record.
 * (Most have no empty value anyway; the list is what keeps the end of a run of an unknown status from being left out.)
 */
const DECIDING: ReadonlySet<string> = new Set(['id', 'scenario', 'mode', 'status', 'finished_at', 'engine', 'perf']);
/** The empty value of a member every record holds, by its path: what it is read as when the file's does not read. */
const EMPTY: Readonly<Record<string, () => unknown>> = {
  project: () => '',
  started_at: () => '',
  dir: () => '',
  env: () => '',
  steps_total: () => 0,
  steps_done: () => 0,
  screenshots: () => [],
  warnings: () => [],
  options: () => ({}),
  'options.hooks': () => '',
  'options.headed': () => false,
  hooks: () => ({}),
  'hooks.setup': () => '',
  'hooks.teardown': () => '',
  'environment.access': () => '',
  'error.message': () => '',
};
const unwrapped = (schema: z.ZodType): z.ZodType => (schema instanceof z.ZodOptional ? unwrapped(schema.unwrap() as z.ZodType) : schema);

/**
 * `value` with every member of `shape` that does not read repaired: an object is read member by member; a member a
 * record may lack is left out; one every record holds becomes its empty value (EMPTY). Undefined (inside a block
 * only): a member that must be there has no empty value, so the block does not read. A member a state never has is
 * not touched: its presence is what makes the record impossible. `value` itself is never changed, and is answered as
 * it is when everything reads.
 */
function lenient(value: Record<string, unknown>, shape: Readonly<Record<string, z.ZodType>>, path: string, notes: ReadNote[]): Record<string, unknown> | undefined {
  let out = value;
  for (const [key, schema] of Object.entries(shape)) {
    const at = `${path}${key}`;
    const inner = unwrapped(schema);
    if ((path === '' && DECIDING.has(key)) || inner instanceof z.ZodNever) continue;
    const held = out[key];
    if (schema.safeParse(held).success) continue;
    let next: unknown;
    const from = isObj(held) ? held : undefined;
    if (inner instanceof z.ZodObject && (from !== undefined || at in EMPTY)) next = lenient(from ?? {}, inner.shape as Record<string, z.ZodType>, `${at}.`, notes);
    else next = EMPTY[at]?.();
    if (next === undefined && !schema.safeParse(undefined).success) {
      // A member that must be there and has no empty value. Inside a block: the block does not read (the caller
      // leaves it out). At the root: left as it is, for the schema to refuse the record at this member — the other
      // members are still repaired, so the refusal names what decides, never a member that decides nothing.
      if (path !== '') return undefined;
      continue;
    }
    // An object read member by member says which of its members were left out; anything else says itself.
    if (held !== undefined && !(isObj(next) && from !== undefined)) notes.push(`${at}-dropped`);
    out = { ...out };
    if (next === undefined) delete out[key];
    else out[key] = next;
  }
  return out;
}

/**
 * A parsed run.json as a stored record. Only what the rules and the union need decides whether it is one: an object,
 * of a format this version reads (else `newer-format`), with an id, a scenario, a kind and a status, and what its
 * state has (a finished run its end, a failed or cancelled one its error) and never has. Every other member is read
 * leniently — a word, a number or a block this version does not know never loses the run: the two diagnostic blocks
 * are dropped whole when they do not read, a closed word is kept as text, and any other member that does not read is
 * left out or read as its empty value, each noted. A status Retake never writes → `unknown-status`, with the record.
 */
export function parseRunRecord(value: unknown): RunRead {
  if (!isObj(value)) return { ok: false, problem: 'invalid', detail: '(root)' };
  const message = newerFormatMessage(value, { file: 'run.json', supported: FORMAT_VERSIONS.run });
  if (message !== undefined) {
    return { ok: false, problem: 'newer-format', message, ...(typeof value.scenario === 'string' ? { scenario: value.scenario } : {}), ...(value.mode === 'dry' ? { dry: true as const } : {}) };
  }
  const notes: ReadNote[] = [];
  let rest = value;
  if (rest.engine !== undefined && !StoredRunEngineSchema.safeParse(rest.engine).success) {
    const { engine: _engine, ...kept } = rest;
    rest = kept;
    notes.push('engine-dropped');
  }
  if (rest.perf !== undefined && !StoredRunPerfSchema.safeParse(rest.perf).success) {
    const { perf: _perf, ...kept } = rest;
    rest = kept;
    notes.push('perf-dropped');
  }
  if (typeof rest.status !== 'string') return { ok: false, problem: 'invalid', detail: 'status' };
  const status = rest.status;
  const known = isStatus(status);
  const state = isStatus(status) ? StoredRunStateSchemas[status] : StoredRunStateSchemas.unknown;
  // What decides is left as the file holds it, for the schema to judge (a failed run's error that is no object is
  // refused there, at `error`).
  rest = lenient(rest, state.shape as Record<string, z.ZodType>, '', notes) ?? rest;
  if (!known) {
    const unknown = UnknownStatusRunSchema.safeParse(rest);
    return unknown.success ? { ok: false, problem: 'unknown-status', record: asRead<UnknownStatusRun>(rest) } : { ok: false, problem: 'invalid', detail: firstPath(unknown.error.issues) };
  }
  const parsed = StoredRunRecordSchema.safeParse(rest);
  return parsed.success ? { ok: true, value: asRead<StoredRunRecord>(rest), notes } : { ok: false, problem: 'invalid', detail: firstPath(parsed.error.issues) };
}

/**
 * The head of a parsed timeline.json: its mode, its scenario, its run and its film. A handful of members are looked
 * at, the megabytes of events are not walked. No object, no mode, no scenario, or a `capture` that is no object →
 * `invalid`, with the member that does not read; a head without its run id or its film's name reads and says so
 * (`lacks`).
 */
export function parseTimelineHead(value: unknown): Read<TimelineHead> {
  const bad = (detail: string): Read<TimelineHead> => ({ ok: false, problem: 'invalid', detail });
  if (!isObj(value)) return bad('(root)');
  if (value.mode !== 'capture' && value.mode !== 'dry') return bad('mode');
  if (typeof value.scenario !== 'string') return bad('scenario');
  if (!isObj(value.capture)) return bad('capture');
  const file = value.capture.file;
  // The film a timeline names: its text; none (absent, null, empty) is the film a capture has always had.
  if (file !== undefined && file !== null && typeof file !== 'string') return bad('capture.file');
  const lacks = typeof value.run_id !== 'string' ? 'run_id' : typeof file !== 'string' ? 'capture.file' : undefined;
  return {
    ok: true,
    value: { mode: value.mode, scenario: value.scenario, ...(typeof value.run_id === 'string' ? { run_id: value.run_id } : {}), film: file || DEFAULT_FILM, ...(lacks ? { lacks } : {}) },
    notes: [],
  };
}

/**
 * A parsed timeline.json as a whole timeline: its head reads and its `events`, `markers` and `scenes` are lists; the
 * rest is taken as the runner wrote it (the one place a parsed timeline is taken for a Timeline; reading the file is
 * core/io run-folder.ts). A timeline made by hand without its run id or its film's name still reads: a run someone
 * names works with it.
 */
export function parseTimeline(value: unknown): Read<Timeline> {
  const head = parseTimelineHead(value);
  if (!head.ok) return head;
  if (!isObj(value)) return { ok: false, problem: 'invalid', detail: '(root)' };
  for (const list of ['events', 'markers', 'scenes']) if (!Array.isArray(value[list])) return { ok: false, problem: 'invalid', detail: list };
  return { ok: true, value: value as unknown as Timeline, notes: [] };
}
