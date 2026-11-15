/** The view's fields read from the situation alone (no events read): the draft's fields are empty. */
function baseViewOf(s: Situation, id: string, version: string, ann: RecordAnnotations | null): RecordView {
  const meta = s.meta;
  return {
    rec_id: id,
    state: s.state,
    version,
    job: s.job
      ? {
          id: s.job.id,
          state: s.job.state,
          phase: s.job.progress?.phase ?? null,
          cancel_requested: s.cancelAsked,
          stop_requested: s.stopAsked,
          ...(s.job.error ? { error: { code: s.job.error.code, message: s.job.error.message, ...(s.job.error.fix ? { fix: s.job.error.fix } : {}) } } : {}),
        }
      : null,
    started_by: s.startedBy,
    can: { annotate: false, save: false, discard: false, stop: false },
    name: meta?.name ?? (s.job?.input.kind === 'record' ? (s.job.input.scenario ?? null) : null),
    env: meta?.env ?? (s.job?.input.kind === 'record' ? (s.job.input.env ?? null) : null),
    persona: meta?.persona ?? null,
    access: meta?.access ?? null,
    page: meta?.page ?? (s.job?.input.kind === 'record' ? s.job.input.source.page : null),
    path: meta?.path ?? (s.job?.input.kind === 'record' ? s.job.input.source.path : null),
    started_at: meta?.started_at ?? null,
    // started_at is the engine clock's own stamp (record.ts), not the runner's timer base: under a test's clock they differ.
    ends_at: meta ? new Date(Date.parse(meta.started_at) + (meta.max_ms ?? RECORD_DEFAULT_MAX_MS)).toISOString() : null,
    rev: ann?.rev ?? 0,
    draft_sha256: null,
    zoom: null,
    counts: { events: 0, actions: 0, dropped_lines: 0 },
    stats: null,
    issues: { error: 0, warning: 0, info: 0 },
    check: null,
    saved: ann?.saved
      ? { name: ann.saved.name, file: ann.saved.file, hash: ann.saved.hash }
      : s.record?.saved
        ? { name: s.record.saved.slice(PROJECT_DIRS.scenarios.length + 1, -'.yaml'.length), file: s.record.saved }
        : null,
    warnings: s.record?.warnings ?? [],
    writes: { total: 0, by_steps: 0, ambient: 0 },
    untrusted: null,
  };
}

/** The Record screen's view of a recording (record-studio.ts): its state, its live draft and what the screen may offer. */
import { join } from 'node:path';
import { plainTarget } from '@retake/core/language';
import { PERSONA_NONE } from '@retake/core/environment';
import { PROJECT_DIRS } from '@retake/core/project';
import { parseScenario, scenarioBlocks } from '@retake/core/scenario';
import { draftFromRecording, draftInvalidIssue, isEmptyRecordAnnotations, recordZoomOptions, recordedAlternatives, shownStep } from '@retake/core/run';
import { DEFAULT_TEMPLATE } from '@retake/core/theme';
import type { LoadedProject } from '@retake/core/project';
import type { TargetSpec } from '@retake/core/language';
import type { WorkFileFacts } from '@retake/core/model';
import type { ScenarioBlocks } from '@retake/core/scenario';
import type { DraftIssue, DraftPlaceholder, DraftSource, DraftWrite, RecordAnnotations, RecordInsert, RecordedEvent, RecordingDraft } from '@retake/core/run';
import type { JobClient, JobState } from './jobs/job-input.js';
import type { JobErrorView } from './jobs/types.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import { recordStart } from './record.js';
import { RECORD_META_FILE, RECORD_STUDIO_FILE } from './record-files.js';
import { sha256Hex } from './storage.js';
import { LINK_WORDS, ORIGIN_WORDS, TAMPERED_WORDS, mtimeOf, readRecordEvents } from './record-folder.js';
import type { RecordJson } from './record-folder.js';
import { ANNOTATE_STATES, FINAL_STATES, settleDiscard, situation, studioWords } from './record-situation.js';
import type { RecordState, RecordStudioContext, Situation } from './record-situation.js';

/** The runner's longest recording when nothing else is set (record-session RECORD_MAX_MS). */
const RECORD_DEFAULT_MAX_MS = 30 * 60_000;

/** A target the person may pick for a step (index 0: the recorder's suggestion). */
export interface RecordTargetOption {
  index: number;
  target: TargetSpec;
  /** The target in plain words (`button "Save"`). */
  words: string;
  fragile: string[];
}

export interface RecordCheckView {
  status: 'passed' | 'failed' | 'skipped' | 'cancelled';
  scope: 'all' | 'until_write' | null;
  reason?: string;
  steps_passed: number;
  steps_total: number;
  /** The events file is not the one the worker drafted and checked (record.json's events_sha256): the check does not hold. */
  events_changed: boolean;
}

/** The zoom factors the camera insert offers (each at most the project theme's max_zoom) and its default. */
export interface RecordZoomView {
  max: number;
  options: number[];
  default: number;
}

export interface RecordView {
  rec_id: string;
  state: RecordState;
  /** Pass it back as `since`: an answer with `unchanged: true` and nothing else means nothing changed. */
  version: string;
  unchanged?: true;
  job: { id: string; state: JobState; phase: string | null; cancel_requested: boolean; stop_requested: boolean; error?: JobErrorView } | null;
  /** Who started it (`ui`: the Studio; `mcp`: Claude; `cli`: a terminal); null when neither meta.json nor a job says. */
  started_by: JobClient | null;
  /** What the Record screen may offer. annotate / save / discard: a Studio recording, not saved, not discarded. */
  can: { annotate: boolean; save: boolean; discard: boolean; stop: boolean };
  /** Why the draft is not shown or cannot be changed (fixed words), when it is not. */
  problem?: string;
  name: string | null;
  env: string | null;
  persona: string | null;
  access: 'read-only' | 'read-write' | null;
  page: string | null;
  path: string | null;
  started_at: string | null;
  /** When the recording stops by itself (its maximum duration). */
  ends_at: string | null;
  /** studio.json's revision (annotate's and save's `rev`). */
  rev: number;
  /** sha256 of the draft shown (`untrusted.yaml`): Save sends it back and refuses any other draft. Null with no draft. */
  draft_sha256: string | null;
  /** The camera insert's factors under the project theme (null: the theme allows no zoom, or there is no draft). */
  zoom: RecordZoomView | null;
  counts: { events: number; actions: number; dropped_lines: number };
  stats: RecordingDraft['stats'] | null;
  issues: { error: number; warning: number; info: number };
  check: RecordCheckView | null;
  saved: { name: string; file: string; hash?: string } | null;
  /** The recording's warnings (engine and runner words: no page text). */
  warnings: string[];
  writes: { total: number; by_steps: number; ambient: number };
  /** Page and typed text: the draft, its rows, sources and issues, the alternatives, the inserts, the write labels. */
  untrusted: {
    yaml: string;
    blocks: ScenarioBlocks;
    sources: DraftSource[];
    issues: DraftIssue[];
    pending: string[];
    placeholders: DraftPlaceholder[];
    alternatives: Array<{ scene: string; step: number; seq: number; chosen: number; options: RecordTargetOption[] }>;
    inserts: RecordInsert[];
    writes: DraftWrite[];
    /**
     * The check replay's failure. `failed_at` is a step of the recorded draft the check replayed (no picks, no inserts);
     * `failed_row` the same step on screen (null: it is not there any more).
     */
    check?: { until?: string; failed_at?: { scene: string; step: number; action: string }; failed_row?: { scene: string; step: number } | null; error?: string };
  } | null;
}

// ── The draft ──────────────────────────────────────────────────────────────

const ACTION_EVENT_KINDS: ReadonlySet<string> = new Set(['pointer', 'dblclick', 'type', 'select_native', 'file', 'key']);

/**
 * The draft of the recording as it is now (meta.json's context with the current project.yaml), or why not. A Studio
 * recording's draft holds no YAML anchor or alias (the block editor edits it after Save); the others' is exactly
 * their job's.
 */
export function draftOf(s: Situation, events: readonly RecordedEvent[], annotations: RecordAnnotations | null, files: WorkFileFacts): { draft: RecordingDraft } | { problem: string } {
  const meta = s.meta!;
  let start: ReturnType<typeof recordStart>;
  try {
    start = recordStart(s.project, { env: meta.env, persona: meta.persona ?? PERSONA_NONE, page: meta.page, path: meta.path });
  } catch {
    return { problem: "the recording's environment, page or persona is no longer in project.yaml: the draft cannot be made" };
  }
  const config = s.project.config;
  const draft = draftFromRecording(
    events,
    {
      name: meta.name,
      env: start.env.name,
      envIsDefault: start.env.name === (config.default_env ?? Object.keys(config.environments ?? {})[0]),
      pages: start.env.pages,
      persona: meta.persona,
      ...(start.defaultPersonas ? { defaultPersonas: start.defaultPersonas } : {}),
      ...(config.vars ? { projectVars: config.vars } : {}),
      access: meta.access,
    },
    annotations,
    { ...(FINAL_STATES.has(s.state) || s.state === 'tampered' ? { final: true } : {}), ...(s.studio ? { aliases: false } : {}) },
  );
  // Valid in the project, as the worker checks it: errors located by scene and step, never the validator's text.
  if (!draft.issues.some((i) => i.severity === 'error')) {
    const ids = (draft.scenario.scenes as Array<{ id: string }>).map((x) => x.id);
    const file = join(s.dir, 'draft.yaml');
    for (const x of parseScenario(draft.yaml, { files, project: s.project, file, env: start.env.name }).issues) {
      if (x.severity === 'error') draft.issues.push(draftInvalidIssue(x, ids, 'the draft does not validate in the project'));
    }
  }
  return { draft };
}

function alternativesOf(draft: RecordingDraft, events: readonly RecordedEvent[], annotations: RecordAnnotations | null): NonNullable<RecordView['untrusted']>['alternatives'] {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const out: NonNullable<RecordView['untrusted']>['alternatives'] = [];
  for (const src of draft.sources) {
    if (src.target_seq === undefined) continue;
    const ev = bySeq.get(src.target_seq);
    const el = ev && 'el' in ev ? ev.el : null;
    if (!el?.target) continue;
    const offered = recordedAlternatives(el);
    if (!offered.length) continue;
    const main = el.target;
    const chosen = annotations?.choices[String(src.target_seq)] ?? 0;
    out.push({
      scene: src.scene,
      step: src.step,
      seq: src.target_seq,
      chosen,
      options: [
        { index: 0, target: main as TargetSpec, words: plainTarget(main), fragile: [...el.fragile] },
        ...offered.map((o) => ({ index: o.index, target: o.target, words: plainTarget(o.target), fragile: [...o.fragile] })),
      ],
    });
  }
  return out;
}

function checkOf(rec: RecordJson | null, eventsChanged: boolean): { view: RecordCheckView | null; untrusted?: NonNullable<RecordView['untrusted']>['check'] } {
  const c = rec?.check;
  if (!c) return { view: null };
  const status = ['passed', 'failed', 'skipped', 'cancelled'].includes(c.status as string) ? (c.status as RecordCheckView['status']) : null;
  if (!status) return { view: null };
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  const view: RecordCheckView = {
    status,
    scope: c.scope === 'all' || c.scope === 'until_write' ? c.scope : null,
    ...(typeof c.reason === 'string' && /^[a-z_]{1,40}$/.test(c.reason) ? { reason: c.reason } : {}),
    steps_passed: num(c.steps_passed),
    steps_total: num(c.steps_total),
    events_changed: eventsChanged,
  };
  const f = c.failed_at as { scene?: unknown; step?: unknown; action?: unknown } | undefined;
  const u = c.untrusted as { error?: unknown } | undefined;
  const untrusted = {
    ...(typeof c.until === 'string' ? { until: c.until.slice(0, 200) } : {}),
    ...(f && typeof f.scene === 'string' && typeof f.step === 'number' && Number.isInteger(f.step) && f.step >= 0
      ? { failed_at: { scene: f.scene.slice(0, 100), step: f.step, action: typeof f.action === 'string' ? f.action.slice(0, 40) : '?' } }
      : {}),
    ...(u && typeof u.error === 'string' ? { error: u.error.slice(0, 2000) } : {}),
  };
  return { view, ...(Object.keys(untrusted).length ? { untrusted } : {}) };
}

function versionOf(parts: unknown[]): string {
  return sha256Hex(JSON.stringify(parts)).slice(0, 16);
}

async function versionFor(s: Situation): Promise<string> {
  const [ev, st, rj, py] = await Promise.all([
    mtimeOf(join(s.dir, 'events.jsonl')),
    mtimeOf(join(s.dir, RECORD_STUDIO_FILE)),
    mtimeOf(join(s.dir, 'record.json')),
    mtimeOf(join(s.project.dir, 'project.yaml')),
  ]);
  return versionOf([s.state, s.folder, s.link, s.studio, s.job?.state, s.job?.progress?.phase ?? null, s.stopAsked, s.cancelAsked, ev, st, rj, py, await mtimeOf(join(s.dir, RECORD_META_FILE))]);
}

/** The camera insert's factors under the project theme's max_zoom. */
export async function zoomOf(project: LoadedProject, ctx: Pick<RecordStudioContext, 'reads' | 'files'>): Promise<RecordZoomView | null> {
  let max = DEFAULT_TEMPLATE.motion.max_zoom;
  try {
    max = (await ctx.reads.loadProjectTemplate(project, undefined, { files: ctx.files })).template.motion.max_zoom;
  } catch {
    max = DEFAULT_TEMPLATE.motion.max_zoom;
  }
  const o = recordZoomOptions(max);
  return o ? { max, options: o.options, default: o.default } : null;
}

/** The Record screen's view of a recording (see the module comment). */
export async function recordView(ctx: RecordStudioContext, project: LoadedProject, id: string, o: { job?: string; since?: string } = {}): Promise<RecordView> {
  let s = await situation(ctx, project, id, o.job);
  if (await settleDiscard(s)) s = { ...s, folder: false, state: 'discarded' };
  const version = await versionFor(s);
  const annRead = s.ann;
  const ann = 'annotations' in annRead ? annRead.annotations : null;
  const studio = s.studio;
  const meta = s.meta;
  const base = baseViewOf(s, id, version, ann);
  const liveJob = !!s.job && !FINISHED_JOB_STATES.has(s.job.state);
  base.can.stop = liveJob && !s.cancelAsked && !s.stopAsked && (s.state === 'queued' || s.state === 'preflight' || s.state === 'recording');
  const open = studio && !base.saved && !ann?.discard && s.state !== 'discarded';
  base.can.discard = studio && !ann?.discard && (s.folder || liveJob) && !(liveJob && s.cancelAsked);
  if (o.since !== undefined && o.since === version) return { ...base, unchanged: true };
  if (s.link) {
    base.problem = LINK_WORDS;
    return base;
  }
  if (s.unverified && s.folder) base.problem = ORIGIN_WORDS;
  else if (!studio && s.startedBy !== null && s.folder) base.problem = studioWords(s.startedBy);
  if ('problem' in annRead && studio) base.problem = annRead.problem;
  if (s.state === 'tampered') base.problem = TAMPERED_WORDS;
  if (!s.folder || !meta) {
    if (s.folder && !meta) base.problem = "the recording's meta.json is missing or not valid: it is read-only here";
    return base;
  }
  const read = readRecordEvents(s.dir);
  if (!read.ok) {
    base.problem = read.problem;
    return base;
  }
  // The events as drafted and checked (fail closed: a record.json without the checksum never matches).
  const eventsChanged = !!s.record && s.record.events_sha256 !== sha256Hex(read.bytes);
  const shownAnn = studio ? ann : null;
  const made = draftOf(s, read.events, shownAnn, ctx.files);
  base.counts = { events: read.events.length, actions: read.events.filter((e) => ACTION_EVENT_KINDS.has(e.kind)).length, dropped_lines: read.dropped };
  const check = checkOf(s.record, eventsChanged);
  base.check = check.view;
  if ('problem' in made) {
    base.problem = made.problem;
    return base;
  }
  const d = made.draft;
  base.stats = d.stats;
  base.draft_sha256 = sha256Hex(d.yaml);
  base.issues = {
    error: d.issues.filter((i) => i.severity === 'error').length,
    warning: d.issues.filter((i) => i.severity === 'warning').length,
    info: d.issues.filter((i) => i.severity === 'info').length,
  };
  base.writes = { total: d.writes.length, by_steps: d.writes.filter((w) => w.step !== null).length, ambient: d.writes.filter((w) => w.step === null).length };
  const annotatable = open && ANNOTATE_STATES.has(s.state) && 'annotations' in annRead;
  base.can.annotate = annotatable;
  base.can.save = annotatable && FINAL_STATES.has(s.state) && !eventsChanged && read.events.length > 0;
  if (annotatable) base.zoom = await zoomOf(project, ctx);
  // The check replayed the recorder's own draft (no picks, no inserts): its failing step, found on screen.
  let checkUntrusted = check.untrusted;
  const failedAt = checkUntrusted?.failed_at;
  if (failedAt) {
    let row: { scene: string; step: number } | null = { scene: failedAt.scene, step: failedAt.step };
    if (!isEmptyRecordAnnotations(shownAnn)) {
      const bare = draftOf(s, read.events, null, ctx.files);
      row = 'draft' in bare ? shownStep(bare.draft.sources, d.sources, failedAt) : null;
    }
    checkUntrusted = { ...checkUntrusted, failed_row: row };
  }
  base.untrusted = {
    yaml: d.yaml,
    blocks: scenarioBlocks(d.yaml),
    sources: d.sources,
    issues: d.issues,
    pending: d.pending,
    placeholders: d.placeholders,
    alternatives: alternativesOf(d, read.events, shownAnn),
    inserts: studio ? (ann?.inserts ?? []) : [],
    writes: d.writes,
    ...(checkUntrusted ? { check: checkUntrusted } : {}),
  };
  return base;
}
