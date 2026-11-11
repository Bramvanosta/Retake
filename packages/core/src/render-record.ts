/**
 * The render record (renders/<id>.json) as a union of states, the two functions that make a state, the parse boundary
 * of a file of renders/, and the rules laid over the records — each written once: a record of its file, a render of
 * its scenario, what a message may quote, the order of renders, the previous render, the two `latest`, why a file is
 * no render, and what prune keeps.
 *
 * Two types, on purpose. `FinishedRender` / `RenderAttempt` are what this version makes: a succeeded record has no
 * error; a failed or cancelled one has its error and no probe — and is never written (it rides on the error a render
 * throws). `StoredRenderRecord` is what any version, or a person, left on a disk: the same states with every member
 * that decides nothing read leniently. Only three members decide whether a file is a record at all: its format
 * version, its status and its id. A record that lacks its scenario, its creation time or its plan says so (`lacks`):
 * a render someone NAMES keeps working with what it has; `latest` and every list take complete records only.
 *
 * The plan a record holds is opaque here (`StoredPlan`): core never looks inside. The one place it becomes an edit
 * plan is the editor's render-record.ts.
 *
 * Pure: no I/O, no clock. Reading the files is core/io render-folder.ts.
 */
import { FORMAT_VERSIONS, newerFormatMessage } from './formats.js';
import { isIsoUtcDate } from './comments.js';
import { projectRef } from './layout.js';
import { printableText } from './printable.js';
import { parseRenderId, renderIdOf } from './id-grammar.js';
import type { RenderId, RenderVariant } from './id-grammar.js';
import { asRead, firstPath, isObj, lenient } from './record-read.js';
import type { LenientTables } from './record-read.js';
import type { FileProblem, ReadNote, StoredWord } from './run-record.js';
import { SLUG_RE } from './schemas/primitives.js';
import { StoredRenderRecordSchema, StoredRenderStateSchemas, UnknownStatusRenderSchema } from './schemas/render.js';
import { PASSED_OVER_MAX } from './take.js';
import type { z } from 'zod';

// ── The states ───────────────────────────────────────────────────────────────

/** Members a state never has (reading one gives undefined; writing one does not compile). */
type No<K extends string> = { readonly [P in K]?: never };

/** Where a setting of the render policy came from. */
export type RenderSettingSource = 'option' | 'retake.yaml' | 'env' | 'default';

/** How the video was encoded. `audio`: what the audio track carries. */
export interface RenderEncoding {
  codec: 'h264';
  encoder?: 'libx264' | 'h264_videotoolbox';
  crf?: number;
  bitrate?: string;
  gop?: number;
  pixel_format: 'yuv420p';
  faststart: true;
  audio: 'silent' | 'music' | 'files' | 'music+files';
}

/** The render policy: the GL and the encoder asked, resolved and used; a fallback; which ffmpeg encoded. */
export interface RenderPolicy {
  gl: { asked: 'auto' | 'gpu' | 'software'; source: RenderSettingSource; resolved: 'angle' | 'software'; used: 'angle' | 'software'; renderer?: string };
  encoder: { asked: 'auto' | 'videotoolbox' | 'libx264'; source: RenderSettingSource; used: 'libx264' | 'h264_videotoolbox' };
  concurrency_source: RenderSettingSource;
  fallback?: { reason: string };
  ffmpeg?: { asked: 'auto' | 'own' | 'library'; source: RenderSettingSource; used: 'own' | 'library'; version?: string; note?: string; failed?: string };
}

/** What ffprobe saw in the file. */
export interface RenderProbe {
  duration_s: number;
  frames?: number;
  width: number;
  height: number;
  fps: number;
  audio_streams: number;
  video_codec?: string;
  audio_codec?: string;
}

/** Where the edit came from: today's scenario file re-planned on the run, or the run as captured. */
export interface RenderEdit {
  from: 'scenario' | 'run';
  sha256?: string;
  changes?: string[];
  captions?: Record<string, string[]>;
}

/**
 * What every state of a record this version makes holds, its status and its error aside. `P`: the plan's type, `O`:
 * the overrides' — for the written type only (the editor names them once); no function here chooses them.
 */
export interface RenderBase<P, O> {
  version: 1;
  /** "<scenario>-v<N>" (+ "-vertical" / "-square"), or the base name of an explicit `out` file. */
  id: string;
  project: string;
  scenario: string;
  run_id: string;
  /** Absolute run directory. */
  run_dir: string;
  /** Theme (template name) the plan was made with, and its folder's content hash at render time. */
  template: string;
  template_sha256?: string;
  overrides: O;
  edit?: RenderEdit;
  variant: RenderVariant;
  /** Absolute path of the video, and of this record. */
  file: string;
  record: string;
  /** Render version (absent with an explicit `out`). */
  render_version?: number;
  created_at: string;
  finished_at: string;
  duration_s: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  size_bytes: number;
  encoding: RenderEncoding;
  policy?: RenderPolicy;
  probe?: RenderProbe;
  concurrency: number;
  bundle: { hash: string; cached: boolean; ms: number };
  browser: { path: string | null; source: 'env' | 'bundled' | 'playwright' | 'none' | 'remotion' };
  timings: { plan_ms: number; bundle_ms: number; render_ms: number; total_ms: number };
  warnings: string[];
  /** The plan rendered. */
  plan: P;
}

/** A record's plan as a file holds it: an object nobody here looks into. */
export type StoredPlan = Readonly<Record<string, unknown>>;

type W<T> = T extends string ? StoredWord<T> : T;
/** `T` with every closed word read as any text (kept as the file holds it), one level down. */
type Words<T> = { [K in keyof T]: T[K] extends infer V ? (V extends object ? { [J in keyof V]: W<V[J]> } : W<V>) : never };

/**
 * What every state of a record read from a disk holds. `scenario` and `created_at` are `''` when the file's is no
 * text, and the plan is absent when the file's is no object: each then in the read's `lacks`. `variant` is left out
 * when absent (never an empty value: the sites that default it would stop doing so). The diagnostic blocks are
 * optional; a closed word is any text.
 */
export interface StoredRenderBase {
  version: 1;
  id: string;
  project: string;
  scenario: string;
  run_id: string;
  run_dir: string;
  template: string;
  template_sha256?: string;
  overrides: Readonly<Record<string, unknown>>;
  edit?: Omit<RenderEdit, 'from'> & { from: StoredWord<RenderEdit['from']> };
  variant?: StoredWord<RenderVariant>;
  file: string;
  record: string;
  render_version?: number;
  created_at: string;
  finished_at: string;
  duration_s: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  size_bytes: number;
  encoding?: Omit<Words<RenderEncoding>, 'faststart'> & { faststart: boolean };
  policy?: Words<RenderPolicy>;
  probe?: RenderProbe;
  concurrency?: number;
  bundle?: { hash: string; cached: boolean; ms: number };
  browser?: { path: string | null; source: StoredWord<RenderBase<unknown, unknown>['browser']['source']> };
  timings?: { plan_ms: number; bundle_ms: number; render_ms: number; total_ms: number };
  warnings: string[];
  plan?: StoredPlan;
}

// The two members that decide a state — its status and its error — are read-only in every state: a state is made by
// the two functions below, never by an assignment.
type Finished<B> = B & { readonly status: 'succeeded' } & No<'error'>;
type Attempt<B> = B & { readonly status: 'failed' | 'cancelled'; readonly error: string } & No<'probe'>;

/** A render that ended well: the only state a writer puts on a disk. */
export type FinishedRender<P, O> = Finished<RenderBase<P, O>>;
/** A render that failed or was cancelled: what the error of a render carries; never on a disk. */
export type RenderAttempt<P, O> = Attempt<RenderBase<P, O>>;
/** renders/<id>.json as any version, or a person, left it (parseRenderRecord answers one). */
export type StoredRenderRecord = Finished<StoredRenderBase> | Attempt<StoredRenderBase>;

declare const unknownRenderStatus: unique symbol;
/** A status Retake never writes, as the file says it: a text the reader found to be none of the three (no literal is one). */
export type UnknownRenderStatus = string & { readonly [unknownRenderStatus]: true };
/** A stored record whose status is a text Retake never writes: said as that, never taken for a render. */
export type UnknownStatusRender = StoredRenderBase & { readonly status: UnknownRenderStatus; readonly error?: string };

// ── The two transitions: the only way to make a state ────────────────────────

/** What a render holds before it ends: every member of its record but its status, its error, its policy and its probe. */
export type RenderFields<P, O> = Omit<RenderBase<P, O>, 'policy' | 'probe'>;

/** What the end of a render adds, and nothing else does: a record is made from its fields, never from another state. */
type EndMembers = 'status' | 'error' | 'policy' | 'probe';
const END_MEMBERS: readonly EndMembers[] = ['status', 'error', 'policy', 'probe'];

/**
 * `fields` with its status after `variant`, where a render record has always had it (the order of the members is kept).
 * Fields that already hold a status, an error, a policy or a probe — a state handed back in, which the types refuse —
 * are an internal error: never a record whose status is not the one asked.
 */
function withStatus<F extends { variant: unknown }, S extends string>(fields: F, status: S): F & { readonly status: S } {
  const held = END_MEMBERS.filter((k) => Object.hasOwn(fields, k));
  if (held.length) throw new Error(`internal: a render record is made from its fields only, and these hold ${held.map((k) => `"${k}"`).join(', ')}`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v;
    if (k === 'variant') out.status = status;
  }
  return out as F & { readonly status: S };
}

/** The record of a render that ended well: its status, then — after the plan, as ever — the policy that drew it and what ffprobe saw. */
export function finishedRender<P, O>(fields: RenderFields<P, O> & No<EndMembers>, done: { policy?: RenderPolicy; probe?: RenderProbe } = {}): FinishedRender<P, O> {
  return { ...withStatus<RenderFields<P, O>, 'succeeded'>(fields, 'succeeded'), ...(done.policy ? { policy: done.policy } : {}), ...(done.probe ? { probe: done.probe } : {}) };
}

/** The record a failed or cancelled render carries: its status, then — after the plan — its error and the policy it tried. Never a probe. */
export function renderAttempt<P, O>(fields: RenderFields<P, O> & No<EndMembers>, end: { status: 'failed' | 'cancelled'; error: string; policy?: RenderPolicy }): RenderAttempt<P, O> {
  return { ...withStatus<RenderFields<P, O>, 'failed' | 'cancelled'>(fields, end.status), error: end.error, ...(end.policy ? { policy: end.policy } : {}) };
}

// ── The parse boundary ───────────────────────────────────────────────────────

/** A member a complete record has and this one has not: read as its empty value (the plan: absent). */
export type RenderLack = 'scenario' | 'created_at' | 'plan';

/** What a file of renders/ that is no record says all the same of the render it names: texts only, each when the file holds one. */
export interface RenderSaid {
  id?: string;
  scenario?: string;
  run_id?: string;
  created_at?: string;
}

/**
 * What reading a file of renders/ answered — never a throw: a stored record with what it lacks; a file problem (`said`:
 * what the object says all the same); a record made for a newer Retake, with its sentence; a record of a status Retake
 * never writes. `detail`: the path of the first member that does not read (a path, never a value).
 */
export type RenderRead =
  | { ok: true; value: StoredRenderRecord; notes: ReadNote[]; lacks: RenderLack[] }
  | { ok: false; problem: FileProblem; detail?: string; said?: RenderSaid }
  | { ok: false; problem: 'newer-format'; message: string; said: RenderSaid }
  | { ok: false; problem: 'unknown-status'; record: UnknownStatusRender; lacks: RenderLack[] };

const KNOWN_STATUS = ['succeeded', 'failed', 'cancelled'] as const;
const isKnownStatus = (s: string): s is (typeof KNOWN_STATUS)[number] => (KNOWN_STATUS as readonly string[]).includes(s);

/**
 * The members that decide whether a file is a render record: its format version, its status, its id — and nothing
 * else (decision iii of the lot: a record that lacks its creation time or its plan is still a record, and says so).
 */
export const RENDER_DECIDING_MEMBERS: readonly ['version', 'status', 'id'] = ['version', 'status', 'id'];
const DECIDING: ReadonlySet<string> = new Set(RENDER_DECIDING_MEMBERS);
/** The empty value of a member every record holds: what it is read as when the file's does not read. */
const EMPTY: Readonly<Record<string, () => unknown>> = {
  project: () => '',
  scenario: () => '',
  run_id: () => '',
  run_dir: () => '',
  template: () => '',
  file: () => '',
  record: () => '',
  created_at: () => '',
  finished_at: () => '',
  duration_s: () => 0,
  frames: () => 0,
  fps: () => 0,
  width: () => 0,
  height: () => 0,
  size_bytes: () => 0,
  warnings: () => [],
  overrides: () => ({}),
  // A failed or cancelled record exists on a disk only when written by hand: its error reads leniently.
  error: () => '',
};
const TABLES: LenientTables = { deciding: DECIDING, empty: EMPTY };

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** What any object says of the render it names, read leniently: its text `id`, `scenario`, `run_id` and `created_at`. */
export function renderSaidOf(value: unknown): RenderSaid | null {
  if (!isObj(value)) return null;
  const said: RenderSaid = {};
  for (const k of ['id', 'scenario', 'run_id', 'created_at'] as const) {
    const v = text(value[k]);
    if (v !== undefined) said[k] = v;
  }
  return said;
}

/**
 * A parsed file of renders/ as a stored record. In this order: no object → `invalid` at `(root)`; a format version
 * above this one's → `newer-format`; a version that is not 1, a status or an id that is no text → `invalid` at that
 * member; a status that is none of the three → `unknown-status`, with the record read leniently. Every other member
 * is read leniently: left out when a record may lack it, its empty value when every record holds it, a block that
 * does not read dropped whole — each noted. A member a state never has (an error on a succeeded record, a probe on a
 * failed one) is dropped and noted: it decides nothing. When everything reads, the value is the file's own object.
 */
export function parseRenderRecord(value: unknown): RenderRead {
  if (!isObj(value)) return { ok: false, problem: 'invalid', detail: '(root)' };
  const said = renderSaidOf(value) ?? {};
  const message = newerFormatMessage(value, { file: 'render record', supported: FORMAT_VERSIONS.render });
  if (message !== undefined) return { ok: false, problem: 'newer-format', message, said };
  for (const member of RENDER_DECIDING_MEMBERS) {
    if (member === 'version' ? value.version !== 1 : typeof value[member] !== 'string') return { ok: false, problem: 'invalid', detail: member, said };
  }
  const status = value.status as string;
  const known = isKnownStatus(status);
  const notes: ReadNote[] = [];
  const lacks: RenderLack[] = [];
  if (typeof value.scenario !== 'string') lacks.push('scenario');
  if (typeof value.created_at !== 'string') lacks.push('created_at');
  if (!isObj(value.plan)) lacks.push('plan');
  let rest = value;
  // What a state never has decides nothing: dropped, and noted.
  for (const member of known ? (status === 'succeeded' ? ['error'] : ['probe']) : []) {
    if (rest[member] === undefined) continue;
    const { [member]: _dropped, ...kept } = rest;
    rest = kept;
    notes.push(`${member}-dropped`);
  }
  const state = known ? StoredRenderStateSchemas[status] : StoredRenderStateSchemas.unknown;
  rest = lenient(rest, state.shape as Record<string, z.ZodType>, '', notes, TABLES) ?? rest;
  if (!known) {
    const unknown = UnknownStatusRenderSchema.safeParse(rest);
    return unknown.success ? { ok: false, problem: 'unknown-status', record: asRead<UnknownStatusRender>(rest), lacks } : { ok: false, problem: 'invalid', detail: firstPath(unknown.error.issues), said };
  }
  const parsed = StoredRenderRecordSchema.safeParse(rest);
  return parsed.success ? { ok: true, value: asRead<StoredRenderRecord>(rest), notes, lacks } : { ok: false, problem: 'invalid', detail: firstPath(parsed.error.issues), said };
}

// ── The entries of renders/ and the rules ────────────────────────────────────

/** One `*.json` of renders/ as the reader answered it. `name`: the file's base name without `.json`; `link`: the entry is a symbolic link. */
export interface RenderEntry {
  name: string;
  link: boolean;
  read: RenderRead;
}

/** A render of its scenario: a complete record of its own file whose id is `<its scenario>-v<N>[-variant]`. */
export interface ProjectRender {
  id: RenderId;
  record: StoredRenderRecord;
}

/** What an entry says of the render it names, whatever it is: a record's own members, or what the reader kept of a file that is none. Null: nothing. */
export function entrySaid(entry: RenderEntry): RenderSaid | null {
  const r = entry.read;
  if (r.ok || r.problem === 'unknown-status') {
    const said = renderSaidOf(r.ok ? r.value : r.record) ?? {};
    // A member the record lacks was read as its empty value: the file says none.
    if (r.lacks.includes('scenario')) delete said.scenario;
    if (r.lacks.includes('created_at')) delete said.created_at;
    return said;
  }
  return 'said' in r && r.said ? r.said : null;
}

/** D-10 — a record of its file: it reads, and its id is the file's name. */
export function renderOfFile(entry: RenderEntry): StoredRenderRecord | null {
  return entry.read.ok && entry.read.value.id === entry.name ? entry.read.value : null;
}

/** A record whose plan is there (an object): what a list, a `latest` and a render someone named hand on. */
export type WithStoredPlan<T> = T extends unknown ? T & { plan: StoredPlan } : never;
/** A complete record: a stored record that lacks neither its scenario, its creation time nor its plan (its scenario and creation time are texts). */
export type CompleteRender = WithStoredPlan<StoredRenderRecord>;

/** A complete record: it reads and lacks neither its scenario, its creation time nor its plan. Whatever its file is called. */
export function completeRender(entry: RenderEntry): CompleteRender | null {
  // (No lack: the plan read as an object — the parse's own test, `lacks`.)
  return entry.read.ok && entry.read.lacks.length === 0 ? (entry.read.value as CompleteRender) : null;
}

/** A render of its scenario (see ProjectRender), or null. */
export function projectRenderOf(entry: RenderEntry): ProjectRender | null {
  const record = renderOfFile(entry);
  if (!record || completeRender(entry) === null) return null;
  const id = renderIdOf(record.id, record.scenario);
  return id ? { id: id.id, record } : null;
}

const KNOWN_VARIANTS: readonly string[] = ['landscape', 'vertical', 'square'];

/** What a message may quote: a render of its scenario whose scenario is a slug, whose creation time is an ISO UTC date and whose variant is one the tool writes. */
export function quotableRender(r: { record: Pick<StoredRenderRecord, 'scenario' | 'created_at' | 'variant'> }): boolean {
  const { scenario, created_at, variant } = r.record;
  return SLUG_RE.test(scenario) && isIsoUtcDate(created_at) && variant !== undefined && KNOWN_VARIANTS.includes(variant);
}

/**
 * The order of renders, oldest first: by creation time, then by id — both compared as text, as every listing always
 * did. A record without its creation time (`''`) is the oldest.
 */
export function orderRenders<T extends { created_at: string; id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/**
 * The render a review compares `current` with: the LAST, in the order of renders, of the succeeded records of the
 * same scenario and variant, of another video, made before it — an earlier creation time, or the same one and a lower
 * version — whose video `exists`. Its own order, kept as it was: among several of one creation time the last by id as
 * text wins (`v9` over `v10`). A `current` without its creation time has none.
 */
export function previousRender<T extends Pick<StoredRenderRecord, 'id' | 'file' | 'scenario' | 'variant' | 'created_at' | 'render_version' | 'status'>>(
  list: readonly T[],
  current: Pick<StoredRenderRecord, 'file' | 'scenario' | 'variant' | 'created_at' | 'render_version'>,
  exists: (file: string) => boolean,
): T | undefined {
  const older = orderRenders(list).filter(
    (r) =>
      r.status === 'succeeded' &&
      r.scenario === current.scenario &&
      r.variant === current.variant &&
      r.file !== current.file &&
      (r.created_at < current.created_at || (r.created_at === current.created_at && (r.render_version ?? 0) < (current.render_version ?? 0))) &&
      exists(r.file),
  );
  return older[older.length - 1];
}

/**
 * Why an entry of renders/ is no render a `latest` or a list takes — a closed list, said with fixed words
 * (renderNotWords), never with a text read from a file.
 */
export type RenderNot =
  | 'linked'
  | 'too-big'
  | 'unreadable'
  | 'newer-format'
  | 'unknown-status'
  | 'renamed'
  | 'incomplete'
  | 'another-scenario'
  | 'other-name'
  | 'not-succeeded';

const RENDER_NOT_WORDS: Record<RenderNot, string> = {
  linked: 'its record is a link',
  'too-big': 'its record is too big to read',
  unreadable: 'its record does not read',
  'newer-format': 'written by a newer Retake',
  'unknown-status': 'its status is not one Retake writes',
  renamed: 'its record says another id',
  incomplete: 'its record lacks its scenario, its creation time or its plan',
  'another-scenario': 'its record says another scenario',
  'other-name': 'its name is not a render id of its scenario',
  'not-succeeded': 'failed or cancelled',
};

/** The fixed words of a reason. */
export function renderNotWords(why: RenderNot): string {
  return RENDER_NOT_WORDS[why];
}

/**
 * Why an entry is no succeeded render of its scenario (of `o.scenario` when given), or null when it is one. The first
 * that holds, in this order: what the file is (a link the reader refused, too big, unreadable, of a newer format, of
 * an unknown status), then what the record is (it says another id, lacks a member, says another scenario than its id
 * or than the one asked, is named otherwise than a render of its scenario, did not succeed).
 */
export function renderNot(entry: RenderEntry, o: { scenario?: string } = {}): RenderNot | null {
  const r = entry.read;
  if (!r.ok) {
    if (r.problem === 'newer-format' || r.problem === 'unknown-status' || r.problem === 'too-big') return r.problem;
    return entry.link && r.problem === 'not-a-file' ? 'linked' : 'unreadable';
  }
  if (r.value.id !== entry.name) return 'renamed';
  if (r.lacks.length) return 'incomplete';
  const named = parseRenderId(r.value.id);
  if (!named) return 'other-name';
  if (named.scenario !== r.value.scenario || (o.scenario !== undefined && r.value.scenario !== o.scenario)) return 'another-scenario';
  return r.value.status === 'succeeded' ? null : 'not-succeeded';
}

/** What a `latest` answered: its pick (none: nothing to take) and what it passed over on the way. */
export interface RenderLatestPick<T> {
  pick?: T;
  /** The newer files of renders/ of the scenario asked that it did not take, newest first (at most PASSED_OVER_MAX). `file`: the file's name. */
  passed: Array<{ file: string; why: RenderNot }>;
  /** How many more it passed over. */
  passed_more: number;
  /** Every file passed over, counted by reason, in the order the reasons were met. */
  reasons: Array<{ why: RenderNot; count: number }>;
  /** Files that say nothing readable and whose name is no render id: counted, never named. */
  not_considered: number;
}

type Candidate<T> = { entry: RenderEntry; pick: T; created_at: string; id: string };

/** The pick of `candidates` (the last in the order of renders, which is stable) and what was passed over for it. */
function latestOf<T>(entries: readonly RenderEntry[], candidates: Array<Candidate<T>>, o: { scenario?: string; why: (e: RenderEntry) => RenderNot | null }): RenderLatestPick<T> {
  const ordered = orderRenders(candidates);
  const best = ordered[ordered.length - 1];
  const taken = new Set(candidates.map((c) => c.entry));
  const passed: Array<{ file: string; why: RenderNot; at: string | undefined }> = [];
  let notConsidered = 0;
  for (const entry of entries) {
    if (taken.has(entry)) continue;
    // A file that says none of the four (an object of other keys, too) says nothing readable.
    const told = entrySaid(entry);
    const said = told && Object.keys(told).length > 0 ? told : null;
    const byName = parseRenderId(entry.name)?.scenario;
    if (said === null && byName === undefined) {
      notConsidered++;
      continue;
    }
    // Of the scenario asked: by what it says, else by its file's name being a render id of it.
    const scenario = said?.scenario ?? byName;
    if (o.scenario !== undefined && scenario !== o.scenario) continue;
    // Newer than the pick: by the creation time it says; one that says none counts as newer.
    if (best && said?.created_at !== undefined && said.created_at.localeCompare(best.created_at) <= 0) continue;
    const why = o.why(entry);
    if (why !== null) passed.push({ file: `${entry.name}.json`, why, at: said?.created_at });
  }
  // Newest first; those that say no creation time first of all.
  passed.sort((a, b) => (a.at === undefined ? (b.at === undefined ? 0 : -1) : b.at === undefined ? 1 : b.at.localeCompare(a.at)) || b.file.localeCompare(a.file));
  const reasons: Array<{ why: RenderNot; count: number }> = [];
  for (const p of passed) {
    const reason = reasons.find((x) => x.why === p.why);
    if (reason) reason.count++;
    else reasons.push({ why: p.why, count: 1 });
  }
  return {
    ...(best ? { pick: best.pick } : {}),
    passed: passed.slice(0, PASSED_OVER_MAX).map(({ file, why }) => ({ file, why })),
    passed_more: Math.max(0, passed.length - PASSED_OVER_MAX),
    reasons,
    not_considered: notConsidered,
  };
}

/**
 * The records a terminal lists (`retake` lists, the render a review compares with): the complete records of their own
 * file (D-10), in the order of renders. A copy, a record renamed by hand, one that lacks a member are not listed.
 */
export function renderRecordsOf(entries: readonly RenderEntry[]): CompleteRender[] {
  const out: CompleteRender[] = [];
  for (const e of entries) {
    const r = completeRender(e);
    if (r && renderOfFile(e)) out.push(r);
  }
  return orderRenders(out);
}

/** An id longer than this (UTF-8 bytes) never names a folder: with a format's suffix it would pass a file name's limit. */
const OUTPUT_ID_MAX_BYTES = 200;

/**
 * The name of the folder (and the stem of the files) a render named at a terminal is exported or reviewed into:
 * the id its record says when that is one folder name a person can read — never an empty name, `.`, `..`, one that
 * holds a separator, a control character or a space a terminal hides, nor one over 200 bytes (a hand-written id is any
 * text: it could name review/ itself, or a folder outside the project) — and is not `taken`; else the name of the file
 * it was read from, when that is one folder name and is not taken; else null (the caller refuses). `taken`: the names
 * among the two that ANOTHER file of renders/ answers to as the file system compares names (case and Unicode
 * normalisation included): the folder of exports/ or review/ of that name is another render's.
 */
export function renderOutputName(entry: Pick<RenderEntry, 'name'>, id: string, taken: ReadonlySet<string> = new Set()): string | null {
  const one = (s: string): boolean => s !== '' && s !== '.' && s !== '..' && !/[\\/\0]/.test(s);
  const readable = (s: string): boolean => printableText(s) === s && new TextEncoder().encode(s).length <= OUTPUT_ID_MAX_BYTES;
  if (one(id) && readable(id) && !taken.has(id)) return id;
  return one(entry.name) && !taken.has(entry.name) ? entry.name : null;
}

const UNREAD_DETAIL: Readonly<Record<string, string>> = { 'not-json': 'it is not JSON', 'not-a-file': 'it is no file', 'too-big': 'it is too big to read', unreadable: 'it cannot be read', missing: 'it cannot be read' };

/**
 * What a sentence may say of why a file is no render record: the member that does not read when it is one of the
 * three that decide (a path of the tool's, never a key a file chose), or the fixed words of a file problem.
 */
export function renderUnreadDetail(read: Extract<RenderRead, { ok: false; problem: FileProblem }>): string | undefined {
  if (read.problem !== 'invalid') return UNREAD_DETAIL[read.problem];
  return read.detail !== undefined && (RENDER_DECIDING_MEMBERS as readonly string[]).includes(read.detail) ? read.detail : undefined;
}

/**
 * BY ITS ID (MCP, the Studio, a job) — why renders/<id>.json, which is THERE, is no record a by-id call takes, in one
 * sentence and its kind; null when the file is missing (the caller says "not found") or is a record of this id, of
 * whatever status. A file that is there is never "not found": a link (through MCP a render is read from its own file),
 * a record of a newer Retake, a file that does not read as a render record, a record that says another id. The one
 * rule of the by-id read: the engine's and core/io's (an export or a review job named by its id) both answer it.
 */
export function byIdProblem(entry: RenderEntry, id: string): { kind: 'refused' | 'invalid'; message: string } | null {
  const r = entry.read;
  const ref = projectRef('renders', `${id}.json`);
  const other = { kind: 'invalid' as const, message: `render "${id}": ${ref} says it is another render` };
  if (r.ok) return r.value.id === id ? null : other;
  if (r.problem === 'unknown-status') return r.record.id === id ? null : other;
  if (r.problem === 'missing') return null;
  if (r.problem === 'newer-format') return { kind: 'invalid', message: `render "${id}": ${r.message}` };
  if (entry.link) return { kind: 'refused', message: `render "${id}": ${ref} is a link: through MCP a render is read from its own file` };
  const detail = renderUnreadDetail(r);
  return { kind: 'invalid', message: `render "${id}": ${ref} does not read as a render record${detail ? ` (${detail})` : ''}` };
}

/** What the engine's `latest` with `status: 'any'` may name beside a render: a record of its file and scenario whose status Retake never writes. */
export interface UnknownStatusProjectRender {
  id: RenderId;
  unknown: UnknownStatusRender;
}

// D-11 (decided, on purpose): `latest` for renders is TWO rules, and stays two. The engine's — MCP, the Studio, the
// comments — names a render of its scenario only (a by-id call takes a render id, so `latest` never names a record a
// by-id call refuses). A terminal's names the newest succeeded record of renders/ whatever its file is called (a
// render written with `--out`, a record renamed by hand: a person named the folder, and acts on the file picked).
// One test holds them apart (the `--out` state: `quote-final` for one, `quote-v1` for the other).

/**
 * `latest`, the engine's: the newest render of its scenario (projectRenderOf) — of `o.scenario` and of `o.variant`
 * when given; `status: 'succeeded'`: a succeeded one; `'any'`: of any status, a status Retake never writes included
 * (a status question: answered as `unknown`, never as a status of the tool's); `quotable`: one a message may quote.
 */
export function latestProjectRender(entries: readonly RenderEntry[], o: { scenario?: string; variant?: string; status: 'succeeded'; quotable?: boolean }): RenderLatestPick<ProjectRender>;
export function latestProjectRender(entries: readonly RenderEntry[], o: { scenario?: string; variant?: string; status: 'any'; quotable?: boolean }): RenderLatestPick<ProjectRender | UnknownStatusProjectRender>;
export function latestProjectRender(entries: readonly RenderEntry[], o: { scenario?: string; variant?: string; status: 'succeeded' | 'any'; quotable?: boolean }): RenderLatestPick<ProjectRender | UnknownStatusProjectRender>;
export function latestProjectRender(
  entries: readonly RenderEntry[],
  o: { scenario?: string; variant?: string; status: 'succeeded' | 'any'; quotable?: boolean },
): RenderLatestPick<ProjectRender | UnknownStatusProjectRender> {
  const candidates: Array<Candidate<ProjectRender | UnknownStatusProjectRender>> = [];
  for (const entry of entries) {
    const r = projectRenderOf(entry);
    if (r) {
      if (o.status === 'succeeded' && r.record.status !== 'succeeded') continue;
      if (o.scenario !== undefined && r.record.scenario !== o.scenario) continue;
      if (o.variant !== undefined && r.record.variant !== o.variant) continue;
      if (o.quotable && !quotableRender(r)) continue;
      candidates.push({ entry, pick: r, created_at: r.record.created_at, id: r.id });
      continue;
    }
    const read = entry.read;
    if (o.status !== 'any' || o.quotable || read.ok || read.problem !== 'unknown-status' || read.lacks.length || read.record.id !== entry.name) continue;
    const id = renderIdOf(read.record.id, read.record.scenario);
    if (!id || (o.scenario !== undefined && read.record.scenario !== o.scenario) || (o.variant !== undefined && read.record.variant !== o.variant)) continue;
    candidates.push({ entry, pick: { id: id.id, unknown: read.record }, created_at: read.record.created_at, id: id.id });
  }
  return latestOf(entries, candidates, {
    ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
    // (With `any`, a failed or cancelled render left out for its variant is not "passed over": nothing is wrong with it.)
    why: (e) => {
      const why = renderNot(e, o.scenario !== undefined ? { scenario: o.scenario } : {});
      return o.status === 'any' && why === 'not-succeeded' ? null : why;
    },
  });
}

/** What a terminal's `latest` names: the entry (act on its FILE, `<name>.json`), its record, and whether its record says another id than its file's name. */
export interface NamedRenderPick {
  entry: RenderEntry;
  record: StoredRenderRecord;
  renamed: boolean;
}

/**
 * `latest`, a terminal's: the newest succeeded complete record of renders/ — of `o.scenario` when given — whatever
 * its file is called and whatever id it says (the lead's ruling on what P0 found: the command then acts on that
 * record by its file, never by looking its inner id up again). Between records of one creation time and one id, the
 * record of its own file wins over a copy.
 */
export function latestNamedRender(entries: readonly RenderEntry[], o: { scenario?: string } = {}): RenderLatestPick<NamedRenderPick> {
  const candidates: Array<Candidate<NamedRenderPick> & { own: number }> = [];
  for (const entry of entries) {
    const record = completeRender(entry);
    if (!record || record.status !== 'succeeded' || (o.scenario !== undefined && record.scenario !== o.scenario)) continue;
    const renamed = record.id !== entry.name;
    candidates.push({ entry, pick: { entry, record, renamed }, created_at: record.created_at, id: record.id, own: renamed ? 0 : 1 });
  }
  // The order of renders is stable: copies first, so that the record of its own file is the last of a tie.
  candidates.sort((a, b) => a.own - b.own);
  return latestOf(entries, candidates, {
    ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
    why: (e) => {
      const r = e.read;
      if (!r.ok) return renderNot(e);
      if (r.lacks.length) return 'incomplete';
      if (o.scenario !== undefined && r.value.scenario !== o.scenario) return 'another-scenario';
      return r.value.status === 'succeeded' ? null : 'not-succeeded';
    },
  });
}

/**
 * Decision iv — a record named at a terminal whose id is not its file's name (renamed, copied) works, but for one
 * case: the video it names is now ANOTHER render's. `beside`: the entry of the record beside that video
 * (`<video without its extension>.json`), when there is one. Refused when that one is a record of its own file, is not
 * the named entry itself, and was made at another time (a render's identity is its id and its creation time). A copy
 * beside its original (the same creation time), a record whose `file` was corrected by hand (beside it: itself), a
 * video that is gone: null.
 */
export function renamedProblem(entry: RenderEntry, beside: RenderEntry | null): { why: 'video-of-another-render'; id: string; other: string } | null {
  if (!entry.read.ok || entry.read.value.id === entry.name || beside === null || beside === entry || beside.name === entry.name) return null;
  const other = renderOfFile(beside);
  if (!other || other.created_at === entry.read.value.created_at) return null;
  return { why: 'video-of-another-render', id: entry.read.value.id, other: beside.name };
}

/**
 * Decision iii — what a use NEEDS of a render someone named and the record lacks: the first of `needs` in the entry's
 * `lacks`, or null (a named render works with what it has; only a use that needs the missing member refuses there,
 * naming it). An entry that is no record at all is not this function's: the reader's problem says what it is.
 */
export function namedRenderProblem(entry: RenderEntry, needs: readonly RenderLack[]): { why: 'lacks'; member: RenderLack } | null {
  const lacks = entry.read.ok ? entry.read.lacks : entry.read.problem === 'unknown-status' ? entry.read.lacks : [];
  const member = needs.find((n) => lacks.includes(n));
  return member ? { why: 'lacks', member } : null;
}

const LACK_WORDS: Record<RenderLack, string> = { scenario: 'no scenario', created_at: 'no creation time', plan: 'no plan' };
/** The fixed words of a member a record lacks ("no plan"). */
export function renderLackWords(member: RenderLack): string {
  return LACK_WORDS[member];
}

// ── What prune keeps (R-FLD-28, R-1) ─────────────────────────────────────────

/** A render prune may delete: a record of its own file that nothing keeps. `paths`: file names of renders/. */
export interface RenderPruneItem {
  id: string;
  scenario: string;
  reason: 'older render' | 'failed render' | 'cancelled render';
  paths: string[];
}

/**
 * The notes of a lenient read that keep a record out of prune's count: every member the count groups or orders by
 * (its scenario, its variant, its creation time, its status and id — the last two decide, so they are never
 * repaired) when the file's value did not read. A scenario or a creation time that does not read is also a lack
 * (rule 1); the variant is the one member only this set catches.
 */
const COUNTED_BY: ReadonlySet<string> = new Set(['scenario-dropped', 'variant-dropped', 'created_at-dropped', 'status-dropped', 'id-dropped']);

/** What the rule answers. */
export interface RenderKeeps {
  items: RenderPruneItem[];
  /** The ids whose review/<id>/ stays: every kept record's, every id a file that is no render says, and every such file's own name. */
  kept: ReadonlySet<string>;
  /** How many record files stay (the kept records of their file, and every file left alone). */
  kept_files: number;
  /** The takes a kept record names. */
  runs: ReadonlySet<string>;
  /** The takes named by a file that is no render of its own name (R-1): said in the result when it is a take's only reason. */
  file_runs: ReadonlySet<string>;
  /** The files left alone — never an item, never counted among a scenario's renders —, in the folder's order: the file's name and why. */
  alone: Array<{ file: string; why: RenderNot }>;
  /** How many files are too big to read: when any is, no render, review or take may be an item (`unjudged`). */
  too_big: number;
  unjudged: boolean;
}

/**
 * What prune keeps of renders/ — in every state a superset of what it kept before the lot.
 *
 * Fed every entry of the folder (`add`); `said`, for an entry the reader did not open as JSON because it is a link:
 * what prune's own read through the link found it to say (null: nothing; `'too-big'`: over the cap behind the link).
 * `done(files)`: `files` are the names of everything in renders/.
 *
 * Two classes. MINE — a record of its own file: kept when it lacks a member; kept when it succeeded and is no render
 * of its scenario (a name of its own); counted, when it is one, in the group of its scenario and of the variant its
 * record holds (as the file holds it, absent included), whose last `keep` succeeded by the order of renders are
 * kept; kept when a thread, a job or an unread thread names it. Every kept one protects its take; every other one is
 * an item, whose paths are the files named after its id MINUS the files of another entry. FOREIGN — every other
 * file: never an item, never counted; the id it says is kept too (no record with that id is an item while the file
 * is there), and the take it says is protected. A file too big to read could say anything: nothing is an item.
 */
export function renderKeeper(o: {
  keep: number;
  thread(id: string): boolean;
  busy(id: string): boolean;
  unread(r: { id: string; scenario: string }): boolean;
}): { add(entry: RenderEntry, said?: RenderSaid | 'too-big' | null): void; done(files: readonly string[]): RenderKeeps } {
  const mine: Array<{ entry: RenderEntry; record: StoredRenderRecord }> = [];
  const foreign: Array<{ entry: RenderEntry; said: RenderSaid | null }> = [];
  let tooBig = 0;
  return {
    add(entry, own) {
      const record = renderOfFile(entry);
      if (record) return void mine.push({ entry, record });
      if (own === 'too-big' || (!entry.read.ok && entry.read.problem === 'too-big')) tooBig++;
      // What it says: the reader's own parse when it parsed the file, else prune's read through a link.
      foreign.push({ entry, said: entrySaid(entry) ?? (own && own !== 'too-big' ? own : null) });
    },
    done(files) {
      const kept = new Set<string>();
      const groups = new Map<string, StoredRenderRecord[]>();
      for (const { entry, record } of mine) {
        // 1. It lacks a member: kept, in nobody's count.
        if (completeRender(entry) === null) {
          kept.add(record.id);
          continue;
        }
        // 2. Complete, no render of its scenario: stays when it succeeded.
        if (projectRenderOf(entry) === null) {
          if (record.status === 'succeeded') kept.add(record.id);
          continue;
        }
        // 2b. A member the count is grouped or ordered by did not read as the file holds it (a `variant` that is no
        // text, dropped by the lenient read): kept, in nobody's count — read as absent, it would join the group of the
        // records without a variant and could push one of them out of its window.
        if (entry.read.ok && entry.read.notes.some((n) => COUNTED_BY.has(n))) {
          kept.add(record.id);
          continue;
        }
        // 3. A render of its scenario: counted with its scenario and the variant its record holds.
        const key = `${record.scenario} ${String(record.variant)}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(record);
      }
      for (const g of groups.values()) {
        for (const r of orderRenders(g.filter((x) => x.status === 'succeeded')).slice(-o.keep)) kept.add(r.id);
      }
      // 4. What a thread, a job or an unread thread names.
      for (const { record } of mine) if (o.unread({ id: record.id, scenario: record.scenario }) || o.thread(record.id) || o.busy(record.id)) kept.add(record.id);
      // 7. The id a file that is no render says is kept too, and its own name's review.
      const saidIds = new Set<string>();
      const fileRuns = new Set<string>();
      for (const f of foreign) {
        if (f.said?.id !== undefined) saidIds.add(f.said.id);
        // 8. … and the take it says is protected.
        if (f.said?.run_id) fileRuns.add(f.said.run_id);
      }
      const unjudged = tooBig > 0;
      const names = [...mine.map((m) => m.entry.name), ...foreign.map((f) => f.entry.name)];
      const items: RenderPruneItem[] = [];
      const runs = new Set<string>();
      let keptFiles = foreign.length;
      for (const { record } of mine) {
        if (kept.has(record.id) || saidIds.has(record.id) || unjudged) {
          kept.add(record.id);
          keptFiles++;
          if (record.run_id) runs.add(record.run_id);
          continue;
        }
        const id = record.id;
        // 5. Its files, minus every file of another entry whose name starts with `<id>.`.
        const others = names.filter((n) => n !== id && n.startsWith(`${id}.`));
        const ofAnother = (f: string): boolean => others.some((n) => f === `${n}.json` || f.startsWith(`${n}.`));
        items.push({
          id,
          scenario: record.scenario,
          reason: record.status === 'succeeded' ? 'older render' : `${record.status} render`,
          paths: files.filter((f) => (f === `${id}.json` || f.startsWith(`${id}.`)) && !ofAnother(f)),
        });
      }
      const reviews = new Set<string>([...kept, ...saidIds, ...foreign.map((f) => f.entry.name)]);
      return {
        items,
        kept: reviews,
        kept_files: keptFiles,
        runs,
        file_runs: fileRuns,
        alone: foreign.map((f) => ({ file: `${f.entry.name}.json`, why: renderNot(f.entry) ?? 'renamed' })),
        too_big: tooBig,
        unjudged,
      };
    },
  };
}
