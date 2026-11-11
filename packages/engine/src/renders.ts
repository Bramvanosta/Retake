/**
 * Renders of a project as clients outside the CLI see them (L3.2): the plan of a render before it runs
 * (plan_preview), and one render's status — its job first, then its record renders/<id>.json. A render id is reused
 * after a failed or cancelled render (nothing was written under it): the newest job of the id is the one shown, unless
 * a render record written after that job (a `retake render` in a terminal) says otherwise. Text the filmed site or the
 * scenario controls (captions, display URLs, page titles quoted by warnings) is kept under `untrusted`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { canonicalJson, formatRenderId, isRenderId, isRunId, isThemeName, latestProjectRender, orderRenders, projectPath, projectRef, projectRenderOf, renderIdOf, renderLackWords, renderNot, renderNotWords } from '@retake/core';
import { readListedRender, readPlainFile } from '@retake/core/io';
import type { LoadedProject, ProjectRender, RenderEntry, RenderLatestPick, RenderNot, StoredRenderRecord, UnknownStatusRender } from '@retake/core';
import type { StoredRender } from '@retake/editor';
import { EngineError } from './errors.js';
import { firstErrorLine, openProjectBySlug } from './projects.js';
import { checkProjectSlug, checkScenarioName, isRenderOfItsScenario } from './refs.js';
import { latestRenderNotice, readById, renderEntries, renderFileProblem } from './render-records.js';
import type { PassedOverRenders } from './render-records.js';
import { latestNoticeOf, planRenderRequest } from './jobs/render-job.js';
import { editor } from './lazy.js';
import type { PassedOverRuns, RenderRequest } from './jobs/render-job.js';
import type { JobQueueView } from './jobs/job-queue.js';
import { FINISHED_JOB_STATES } from './jobs/types.js';
import type { JobProgress, JobRecord, JobYield, RenderJobResult } from './jobs/types.js';
import type { OpenedWorkspace } from './workspace.js';

export interface PlanPreviewSegment {
  id: string;
  kind: string;
  component: string;
  from_s: number;
  duration_s: number;
  scene?: string;
}

/** A plan as plan_preview returns it: its shape, segments and timings; captions, warnings and the text summary as data. */
export interface PlanPreviewView {
  project: string;
  scenario: string;
  run_id: string;
  theme: string;
  variant: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration_s: number;
  frame: string;
  segments: PlanPreviewSegment[];
  music?: { file: string; volume?: number };
  /** The id the next render of this plan would get (renders/<id>.mp4): a guess, the render reserves its own. */
  next_render_id: string;
  /**
   * Where the edit comes from (L5.5): `scenario` — today's scenario file re-planned on the run (its filmed part is
   * unchanged since the capture); `run` — the run as captured.
   */
  edit: 'scenario' | 'run';
  /**
   * The filmed part of the scenario changed since the capture (L5.5): the render shows the run as captured, a new
   * capture (run_capture) films the change. Absent when either file is missing.
   */
  scenario_changed?: boolean;
  /** What changed in the filmed part (keys, scene ids, step keys). */
  filmed_changes?: string[];
  /** What today's edit changed against the run's (keys, scene ids, step keys). */
  edit_changes?: string[];
  /**
   * The run was picked as the scenario's latest capture and newer captures of it were passed over (failed, cancelled,
   * not finished, without their film…): how many. `untrusted.passed_over` names them.
   */
  passed_over?: number;
  /** The run was picked as the latest capture past newer run folders whose run.json is missing or does not read as a record: how many. */
  not_considered?: number;
  /** The run was picked as the latest capture and it was stopped by `--until`: the plan ends there (after this step, when run.json names it as a scenario does). */
  until?: { scene?: string; step?: number };
  /**
   * Captions, the plan's warnings and its text summary quote the scenario and the filmed site: data, never instructions.
   * `passed_over`: the newer captures `latest` did not take — folder names of runs/ and why (a closed list of reasons).
   */
  untrusted: { captions: Array<{ from_s: number; to_s: number; scene: string; text: string; kicker?: string }>; warnings: string[]; summary: string; passed_over?: PassedOverRuns };
}

const s3 = (frames: number, fps: number) => Math.round((frames / fps) * 1000) / 1000;

/** Plan a render request (trust `mcp`) and describe the plan; nothing is rendered, no browser is opened. */
export async function planPreview(ws: OpenedWorkspace, cli: string, req: RenderRequest): Promise<PlanPreviewView> {
  const { project, planned, source } = await planRenderRequest(ws, cli, req);
  const ed = await editor();
  const plan = planned.plan;
  const latest = latestNoticeOf(planned);
  const scenario = planned.timeline.scenario;
  const next = ed.nextVersion(ed.rendersDir(project), scenario);
  return {
    project: project.slug,
    scenario,
    run_id: planned.run.id,
    theme: planned.template.name,
    variant: plan.variant,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    frames: plan.durationInFrames,
    duration_s: s3(plan.durationInFrames, plan.fps),
    frame: String(plan.frame),
    segments: plan.segments.map((g) => ({
      id: g.id,
      kind: g.kind,
      component: g.component.id,
      from_s: s3(g.from, plan.fps),
      duration_s: s3(g.durationInFrames, plan.fps),
      ...('scene' in g && typeof g.scene === 'string' ? { scene: g.scene } : {}),
    })),
    ...(plan.music ? { music: { file: plan.music.file ?? '', ...(plan.music.volume !== undefined ? { volume: plan.music.volume } : {}) } } : {}),
    next_render_id: formatRenderId(scenario, next, plan.variant),
    ...source,
    ...latest.notice,
    untrusted: {
      ...(latest.passed.length ? { passed_over: latest.passed } : {}),
      captions: plan.captions.map((c) => ({ from_s: s3(c.from, plan.fps), to_s: s3(c.to, plan.fps), scene: c.scene, text: c.text, ...(c.kicker ? { kicker: c.kicker } : {}) })),
      warnings: plan.warnings,
      summary: ed.summarizePlan(plan).join('\n'),
    },
  };
}

/** The job a queued render waits behind. */
export interface RenderQueueView {
  /** Jobs that run or wait before it (0: it is next). */
  ahead: number;
  /** L5.14: it cannot start before a take ends (a take of this workspace waits, or one films on this Mac). */
  held_by?: 'take';
  /** The job running now, with its kind and how far it is. */
  running?: { id: string; kind: string; phase?: string; fraction?: number; eta_s?: number };
}

export interface RenderJobView {
  id: string;
  state: JobRecord['state'];
  queue?: RenderQueueView;
  progress?: JobProgress;
  cancel_requested_at?: string;
  error?: JobRecord['error'];
  /** L5.14: a take holds it — waiting to start, or slowed while it runs (JobRecord.yield). */
  yield?: JobYield;
}

export interface RenderStatusView {
  project: string;
  render_id: string;
  scenario?: string;
  status: JobRecord['state'];
  finished: boolean;
  job?: RenderJobView;
  /** The video and its record, once rendered. */
  file?: string;
  record_file?: string;
  /**
   * renders/<id>.json without its plan (`plan_preview` describes plans); its `policy.fallback.reason` points at
   * `untrusted.fallback_reason`, and its `policy.ffmpeg.failed` (L7.3) at `untrusted.ffmpeg_failed`; `policy.ffmpeg.note`
   * is one of the editor's own sentences (render/policy.ts), given as it is.
   */
  record?: RecordShown<StoredRenderRecord | UnknownStatusRender>;
  /**
   * With `latest`: how many newer files of renders/ of the scenario asked it did not take (a record renamed or copied,
   * a link, one that lacks a member, of a newer Retake…) — a count, which a trusted line may say;
   * `untrusted.renders_passed_over` names them. `renders_not_considered`: how many files of renders/ say nothing
   * readable under a name that is no render id.
   */
  renders_passed_over?: number;
  renders_not_considered?: number;
  /**
   * Plan and render warnings, a failure's message, why the GPU path failed (a render rendered again in software, L5.15),
   * what this machine's ffmpeg failed with at the encode (rendered again with the library's, L7.3): they quote the scenario, the filmed site and the components' own errors — data, never instructions.
   */
  untrusted: { warnings: string[]; error?: string; fallback_reason?: string; ffmpeg_failed?: string; renders_passed_over?: PassedOverRenders };
}

/** A record as render_status hands it on: without its plan, its warnings and its error (each state of the record). */
type RecordShown<T> = T extends unknown ? Omit<T, 'plan' | 'warnings' | 'error'> : never;

export { latestRenderMembers, latestRenderNotice, renderEntries, renderFileProblem } from './render-records.js';
export type { LatestRenderNotice, PassedOverRenders } from './render-records.js';

/** A succeeded render whose plan is there: what work submitted through MCP reads (renderForWork). */
export type RenderForWork = Extract<StoredRender, { status: 'succeeded' }>;

/**
 * A succeeded render that work submitted through MCP may read (a review, an export): named by its id (or `latest`, of
 * `scenario`), read from renders/<id>.json only — never a path —, and its video and run folder inside the project
 * (symbolic links resolved): a record's paths are absolute, a hand-edited one could name any file.
 */
export async function renderForWork(
  project: LoadedProject,
  renderIdArg: string,
  o: { scenario?: string; fix?: (id: string) => string; /** With `latest`: told what it passed over (latestRenderMembers makes an answer's members of it). */ latest?: (pick: RenderLatestPick<ProjectRender>) => void } = {},
): Promise<RenderForWork> {
  const scenario = o.scenario;
  const ed = await editor();
  let id = renderIdArg;
  if (renderIdArg === 'latest') {
    // The newest succeeded render of its scenario (core's rule, the engine's `latest`): a complete record of its own file.
    const pick = latestProjectRender(await renderEntries(project.dir), { ...(scenario !== undefined ? { scenario } : {}), status: 'succeeded' });
    if (!pick.pick) throw new EngineError('not_found', `no finished render of ${project.slug}${scenario ? ` · ${scenario}` : ''} yet: render makes one`);
    o.latest?.(pick);
    id = pick.pick.id;
  } else if (!isRenderId(renderIdArg)) {
    throw new EngineError('invalid', `invalid render id "${String(renderIdArg)}": <scenario>-v<N> (render returns it), or "latest"`);
  }
  const entry = await readById(project.dir, id);
  const unread = renderFileProblem(entry, id);
  if (unread) throw unread;
  if (!entry.read.ok) {
    // Its status is not one Retake writes (said in fixed words: the file's word is text anyone could write), or the file is not there.
    if (entry.read.problem === 'unknown-status') throw new EngineError('invalid', `render ${id}: ${renderNotWords('unknown-status')}: nothing to read`);
    throw new EngineError('not_found', `render "${id}" not found in ${project.slug} (no renders/${id}.json): render_status says whether it is still running`);
  }
  if (entry.read.value.status !== 'succeeded') throw new EngineError('invalid', `render ${id} ${entry.read.value.status}: nothing to read`);
  // Work reads the plan: a record without it is refused here, naming it (the one place a stored plan becomes an edit plan).
  const planned = ed.withPlan(entry.read.value);
  if (!planned.ok) throw new EngineError('invalid', `render ${id} has ${renderLackWords('plan')} (${projectRef('renders', `${id}.json`)}): nothing to read`);
  const record = planned.value;
  if (record.status !== 'succeeded') throw new EngineError('invalid', `render ${id} ${record.status}: nothing to read`);
  const problem = ed.recordPathProblem(project.dir, record);
  if (problem) throw new EngineError('refused', problem, { ...(o.fix ? { fix: o.fix(id) } : {}), details: { problems: [problem] } });
  // (The path is the record's text: under `details.untrusted`, never in the sentence.)
  if (!existsSync(record.file)) throw new EngineError('not_found', `the video of render ${id} is missing: its record names a file that is not there`, { details: { untrusted: { video: record.file } } });
  return record;
}

/**
 * The render id `latest` names: the newest render (record or job) of the project, of `scenario` when given — among the
 * renders of their scenario only (isRenderOfItsScenario), so the id is one the by-id call takes.
 */
async function latestRenderId(
  projectDir: string,
  queue: JobQueueView,
  slug: string,
  scenario?: string,
): Promise<{ id?: string; /** The id is a record's whose status Retake never writes. */ unknown: boolean; pick: RenderLatestPick<unknown> }> {
  // The newest record of any status (core's rule; a status Retake never writes is answered as unknown) …
  const pick = latestProjectRender(await renderEntries(projectDir), { ...(scenario !== undefined ? { scenario } : {}), status: 'any' });
  let best = pick.pick ? { id: pick.pick.id as string, at: 'record' in pick.pick ? pick.pick.record.created_at : pick.pick.unknown.created_at, unknown: 'unknown' in pick.pick } : undefined;
  // … or a newer job of a render (a record wins a tie, as it always did).
  for (const j of await queue.list({ project: slug, kinds: ['render'], limit: 200 })) {
    if (j.input.kind !== 'render' || !isRenderOfItsScenario({ id: j.input.render_id, scenario: j.input.scenario }) || (scenario !== undefined && j.input.scenario !== scenario)) continue;
    if (!best || j.created_at.localeCompare(best.at) > 0) best = { id: j.input.render_id, at: j.created_at, unknown: false };
  }
  return { ...(best ? { id: best.id } : {}), unknown: best?.unknown ?? false, pick };
}

/** A render's status: its newest job (queued, running, its result or error), then its record. */
export async function renderStatus(ws: OpenedWorkspace, queue: JobQueueView, slug: string, renderIdArg: string, scenario?: string): Promise<RenderStatusView> {
  checkProjectSlug(slug);
  if (scenario !== undefined) checkScenarioName(scenario);
  const project = await openProjectBySlug(ws, slug);
  let renderId = renderIdArg;
  let latest: Awaited<ReturnType<typeof latestRenderId>> | undefined;
  if (renderIdArg === 'latest') {
    latest = await latestRenderId(project.dir, queue, slug, scenario);
    if (!latest.id) throw new EngineError('not_found', `no render of ${slug}${scenario ? ` · ${scenario}` : ''} yet: render starts one`);
    renderId = latest.id;
  } else if (!isRenderId(renderIdArg)) {
    throw new EngineError('invalid', `invalid render id "${String(renderIdArg)}": <scenario>-v<N> (render returns it), or "latest"`);
  }
  const job = await queue.ofRender(slug, renderId);
  // The record of this id, read leniently: a status question is answered whatever the record lacks (its plan, its
  // creation time) and whatever its status says. A file that is there and is no record of this id is said as that.
  const entry = await readById(project.dir, renderId);
  const unread = renderFileProblem(entry, renderId);
  let record: StoredRenderRecord | UnknownStatusRender | undefined = unread ? undefined : entry.read.ok ? entry.read.value : entry.read.problem === 'unknown-status' ? entry.read.record : undefined;
  if (!job && unread) throw unread;
  // A record older than the job belongs to an earlier render of the id only when the job did not write it — never here
  // (a free id has no record); a record newer than an unfinished or failed job is a later `retake render` of the id.
  const jobFirst = job && !(record && job.state !== 'succeeded' && record.created_at > (job.finished_at ?? job.created_at));
  if (!job && !record) throw new EngineError('not_found', `render "${renderId}" not found in ${slug} (no job, no renders/${renderId}.json): render starts one`);
  if (jobFirst && job.state !== 'succeeded') record = undefined;
  const view: RenderStatusView = {
    project: slug,
    render_id: renderId,
    ...(job?.input.kind === 'render' ? { scenario: job.input.scenario } : record ? { scenario: record.scenario } : {}),
    status: jobFirst ? job.state : statusSaid(record, latest?.unknown === true),
    finished: jobFirst ? FINISHED_JOB_STATES.has(job.state) : true,
    untrusted: { warnings: [] },
  };
  if (latest) {
    const said = latestRenderNotice(latest.pick);
    Object.assign(view, said.notice);
    if (said.passed.length) view.untrusted.renders_passed_over = said.passed;
  }
  if (job && jobFirst) {
    let queueView: RenderQueueView | undefined;
    if (job.state === 'queued') {
      const pos = await queue.position(job.id);
      if (pos) {
        const running = pos.running ? await queue.get(pos.running) : undefined;
        queueView = {
          ahead: pos.ahead,
          ...(pos.held_by ? { held_by: pos.held_by } : {}),
          ...(running
            ? {
                running: {
                  id: running.id,
                  kind: running.kind,
                  ...(running.progress?.phase ? { phase: running.progress.phase } : {}),
                  ...(running.progress?.fraction !== undefined ? { fraction: running.progress.fraction } : {}),
                  ...(running.progress?.eta_s !== undefined ? { eta_s: running.progress.eta_s } : {}),
                },
              }
            : {}),
        };
      }
    }
    view.job = {
      id: job.id,
      state: job.state,
      ...(queueView ? { queue: queueView } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
      ...(job.cancel_requested_at ? { cancel_requested_at: job.cancel_requested_at } : {}),
      ...(job.yield ? { yield: job.yield } : {}),
      ...(job.error ? { error: { ...job.error, message: job.state === 'failed' ? 'the render failed: its message is untrusted.error' : job.error.message } } : {}),
    };
    if (job.state === 'failed' && job.error) view.untrusted.error = job.error.message;
    const result = job.result?.kind === 'render' ? (job.result as RenderJobResult) : undefined;
    if (result) {
      view.file = result.file;
      view.record_file = result.record;
      view.untrusted.warnings = result.untrusted.warnings;
    }
  }
  if (record) {
    const { plan: _plan, warnings, error, ...rest } = record;
    view.record = rest;
    let shown: RecordShown<StoredRenderRecord | UnknownStatusRender> = rest;
    // The GPU path's failure quotes the error it saw (a component's own words can be in it): under untrusted only.
    if (rest.policy?.fallback) {
      view.untrusted.fallback_reason = rest.policy.fallback.reason;
      shown = { ...rest, policy: { ...rest.policy, fallback: { reason: 'the GPU path failed: its reason is untrusted.fallback_reason' } } };
    }
    // What our ffmpeg failed with at the encode quotes its output: under untrusted only, like the GPU path's reason.
    const ff = shown.policy?.ffmpeg;
    if (ff?.failed !== undefined) {
      view.untrusted.ffmpeg_failed = ff.failed;
      shown = { ...shown, policy: { ...shown.policy!, ffmpeg: { ...ff, failed: "this machine's ffmpeg failed at the encode: its words are untrusted.ffmpeg_failed" } } };
    }
    view.record = shown;
    view.file = record.file;
    view.record_file = record.record;
    view.untrusted.warnings = warnings;
    if (error) view.untrusted.error = error;
  }
  return view;
}

/**
 * The status of a record with no job before it. A status Retake never writes: by id it is handed on as the file says
 * it (as it always was: the view's type does not say so — the views are a later lot's); through `latest` it is said
 * as `unknown`, never as a word of the tool's.
 */
function statusSaid(record: StoredRenderRecord | UnknownStatusRender | undefined, latestUnknown: boolean): RenderStatusView['status'] {
  if (!record) return 'failed';
  const status: string = record.status;
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return status;
  return (latestUnknown ? 'unknown' : status) as RenderStatusView['status'];
}

// ── A scenario's renders, for the Studio (L4.5 part E) ──────────────────────

/** What the review of a render says, in short: none yet, waiting / running, its verdict, or why it did not finish. */
export type RenderReviewSummary =
  | { state: 'none' }
  | { state: 'queued' | 'running'; job: string }
  | { state: 'clean' | 'warnings' | 'errors'; counts: { error: number; warning: number; info: number }; created_at?: string }
  | { state: 'failed' | 'cancelled' };

/** A render of the scenario that is queued or running (a Studio click, Claude, another client). */
export interface ScenarioRenderJobView {
  id: string;
  render_id: string;
  run_id: string;
  state: 'queued' | 'running';
  created_at: string;
  submitted_by: string;
  /** sha256 of the scenario text its edit was planned from (absent: the take as captured). */
  edit_sha256?: string;
  /** The render's phase (planning, bundling, rendering, encoding…; `review:<stage>` while it reviews itself). */
  phase?: string;
  fraction?: number;
  eta_s?: number;
  /** The render is written; its inline review runs now. */
  reviewing: boolean;
  /** Queued: what runs before it. */
  queue?: RenderQueueView;
  cancel_requested: boolean;
  /** L5.14: a take holds it — waiting to start, or slowed while it runs (JobRecord.yield). */
  yield?: JobYield;
}

/** A render of the scenario that was written (renders/<id>.json), newest first. */
export interface ScenarioRenderView {
  render_id: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  created_at: string;
  run_id: string;
  theme: string;
  variant: string;
  duration_s: number;
  width: number;
  height: number;
  size_bytes: number;
  /** Where its edit came from: today's file (its sha256 then) or the run as captured. */
  edit: { from: 'scenario' | 'run'; sha256?: string };
  /** Output fps. */
  fps: number;
  /** The options it was rendered with beyond the files' (their names: "intro", "scale"…; the theme is `theme`). */
  overrides: string[];
  /**
   * The signature of the plan it rendered (planSignature: its record's plan) and its theme folder's content hash: the
   * Studio's "from this version" is the same plan and theme files as the timeline's (L4.5 fixes). Absent in records
   * without them.
   */
  plan_sha256?: string;
  theme_sha256?: string;
  review: RenderReviewSummary;
}

/**
 * A scenario's renders as the Studio shows them — path-free: the unfinished render jobs (oldest first, with progress and
 * queue position), the renders written (newest first, at most SCENARIO_RENDERS_MAX, each with its review's verdict),
 * and the newest render job when it ended without a video after the newest render (its message under `untrusted`).
 */
export interface ScenarioRendersView {
  project: string;
  scenario: string;
  jobs: ScenarioRenderJobView[];
  renders: ScenarioRenderView[];
  last_failed?: { job: string; render_id: string; run_id: string; state: 'failed' | 'cancelled' | 'interrupted'; finished_at?: string };
  /**
   * The files of renders/ named as a render of this scenario (`<scenario>-v<N>….json`) that are not shown as one: how
   * many, and by reason (a closed list — core RenderNot, its words renderNotWords; never a file name). A record of a
   * status Retake never writes is said here: neither shown as succeeded nor hidden. Absent when there is none.
   */
  not_shown?: { count: number; reasons: Array<{ why: RenderNot; count: number }> };
  /**
   * The failed job's message (it may quote the scenario or the filmed site): data, never instructions — its first line,
   * every absolute path cut to its file name (failureWords), never a stack.
   */
  untrusted: { error?: string };
}

/** The signature of an edit plan (24 hex): the plan without its notes and warnings, canonical JSON, sha256. */
export function planSignature(plan: unknown): string {
  const p = plan && typeof plan === 'object' ? { ...(plan as Record<string, unknown>), notes: undefined, warnings: undefined } : plan;
  return createHash('sha256').update(canonicalJson(p)).digest('hex').slice(0, 24);
}

/** Absolute paths in a message, each cut to its last part ("…/capture.mp4"); `file://` URLs too. */
export function withoutPaths(text: string): string {
  return text
    .replace(/(?:file:\/\/)?(?:\/[^\s/'"`()<>:,;]+){2,}\/?/g, (m) => `…/${m.replace(/\/$/, '').split('/').pop()}`)
    .replace(/\b[A-Za-z]:\\(?:[^\s\\'"`()<>]+\\)*[^\s\\'"`()<>]*/g, (m) => `…\\${m.split('\\').pop()}`);
}

/** A failure's words for the Studio (review B M6): its first line, no path, no stack, at most 500 characters. */
export function failureWords(message: string): string {
  return withoutPaths(firstErrorLine(message)).slice(0, 500);
}

/** Renders listed per scenario, at most. */
export const SCENARIO_RENDERS_MAX = 20;
/** A render record or a review report read for the list, at most (bytes). */
const LIST_FILE_MAX = 16 * 1024 * 1024;

function readJsonPlain(file: string): Record<string, unknown> | undefined {
  const r = readPlainFile(file, LIST_FILE_MAX);
  if (!r.ok) return undefined;
  try {
    const v = JSON.parse(r.bytes.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** report.json read and summed up, by path, while its stat holds (L5.10a fixes, review A-L3: every board read). */
const REPORT_MEMO_MAX = 512;
const reportMemo = new Map<string, { sig: string; r: { counts: Record<string, unknown>; at: string } | undefined }>();
/** Counter for tests: report.json files read. */
export const reportReads = { n: 0 };

function reportOf(file: string): { counts: Record<string, unknown>; at: string } | undefined {
  let sig = '-';
  try {
    const s = lstatSync(file);
    sig = `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    /* none */
  }
  const held = reportMemo.get(file);
  if (held && held.sig === sig) return held.r;
  reportReads.n++;
  const r = sig === '-' ? undefined : readJsonPlain(file);
  const out =
    r && r.version === 1 && Array.isArray(r.findings)
      ? { counts: (r.counts ?? {}) as Record<string, unknown>, at: typeof (r.review as Record<string, unknown> | undefined)?.created_at === 'string' ? ((r.review as Record<string, unknown>).created_at as string) : '' }
      : undefined;
  reportMemo.delete(file);
  reportMemo.set(file, { sig, r: out });
  while (reportMemo.size > REPORT_MEMO_MAX) reportMemo.delete(reportMemo.keys().next().value as string);
  return out;
}

/** The review verdict of review/<id>/report.json (written after the render: `since`), or undefined. */
function reportSummary(projectDir: string, id: string, since: string): { summary: RenderReviewSummary; at: string } | undefined {
  const r = reportOf(projectPath(projectDir, 'review', id, 'report.json'));
  if (!r) return undefined;
  const at = r.at;
  // A review of an earlier render of the id (its record pruned, the id reused) is not this render's.
  if (at && at < since) return undefined;
  const c = r.counts;
  const counts = { error: n0(c.error), warning: n0(c.warning), info: n0(c.info) };
  return { summary: { state: counts.error > 0 ? 'errors' : counts.warning > 0 ? 'warnings' : 'clean', counts, ...(at ? { created_at: at } : {}) }, at };
}

/** Counter for tests: record files of renders/ read for the Studio's list and the board. */
export const renderRecordReads = { n: 0 };

/** renders/<name>.json as a listing reads it (the one reader: no link followed, within the cap) — the board's read, held while the file's stat holds. */
export function readListedRecord(projectDir: string, name: string): Promise<RenderEntry> {
  renderRecordReads.n++;
  return readListedRender(projectPath(projectDir, 'renders'), name);
}

/** The render of `scenario` an entry of renders/ is (core projectRenderOf: a complete record of its own file, its id of its scenario), or null. */
export function scenarioRenderOf(entry: RenderEntry, scenario: string): StoredRenderRecord | null {
  const r = projectRenderOf(entry);
  return r && r.record.scenario === scenario ? r.record : null;
}

const OVERRIDE_KEY = /^[a-z][a-z_]{0,39}$/;

/**
 * One render record as the Studio lists it (path-free): its review from a standalone review job, its own render job's
 * inline review, or review/<id>/report.json. `renderJobs`: the project's render jobs of this scenario (newest first);
 * `reviewJobs`: its queued or running review jobs. Shared by the render list and the project board (L5.10a).
 */
export function renderView(projectDir: string, r: StoredRenderRecord, renderJobs: readonly JobRecord[], reviewJobs: readonly JobRecord[]): ScenarioRenderView {
  let review: RenderReviewSummary = { state: 'none' };
  const standalone = reviewJobs.find((j) => j.input.kind === 'review' && j.input.render_id === r.id);
  const job = renderJobs.find((j) => j.input.kind === 'render' && j.input.render_id === r.id && j.created_at <= r.created_at);
  const report = r.status === 'succeeded' ? reportSummary(projectDir, r.id, r.created_at) : undefined;
  if (standalone) review = { state: standalone.state === 'running' ? 'running' : 'queued', job: standalone.id };
  else if (job && !FINISHED_JOB_STATES.has(job.state)) review = { state: 'running', job: job.id };
  else {
    const inline = job?.result?.kind === 'render' ? (job.result as RenderJobResult).review : undefined;
    const stopped = inline && (inline.state === 'failed' || inline.state === 'cancelled') && (!report || (job?.finished_at ?? '') > report.at) ? inline.state : undefined;
    if (stopped) review = { state: stopped };
    else if (report) review = report.summary;
  }
  return {
    render_id: r.id,
    status: r.status,
    created_at: r.created_at,
    run_id: isRunId(r.run_id) ? r.run_id : 'unknown',
    // The record's theme, by its folder's name (the board compares it with today's: project-board.ts themeName, the same test).
    theme: isThemeName(r.template) ? r.template : 'unknown',
    variant: r.variant === 'vertical' || r.variant === 'square' ? r.variant : 'landscape',
    duration_s: n0(r.duration_s),
    width: n0(r.width),
    height: n0(r.height),
    size_bytes: n0(r.size_bytes),
    edit: { from: r.edit?.from === 'scenario' ? 'scenario' : 'run', ...(r.edit?.from === 'scenario' && typeof r.edit.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.edit.sha256) ? { sha256: r.edit.sha256 } : {}) },
    fps: n0(r.fps),
    overrides: r.overrides && typeof r.overrides === 'object' ? Object.keys(r.overrides).filter((k) => k !== 'theme' && OVERRIDE_KEY.test(k) && (r.overrides as Record<string, unknown>)[k] !== undefined).sort() : [],
    ...(r.plan && typeof r.plan === 'object' ? { plan_sha256: memoPlanSignature(r) } : {}),
    ...(typeof r.template_sha256 === 'string' && /^[0-9a-f]{16}$/.test(r.template_sha256) ? { theme_sha256: r.template_sha256 } : {}),
    review,
  };
}

/** A scenario's render jobs and renders, path-free (the Studio's render queue and list). */
export async function scenarioRenders(ws: OpenedWorkspace, queue: JobQueueView, slug: string, scenario: string): Promise<ScenarioRendersView> {
  checkProjectSlug(slug);
  checkScenarioName(scenario);
  const project = await openProjectBySlug(ws, slug);
  const renderJobs = (await queue.list({ project: slug, kinds: ['render'], limit: 200 })).filter((j) => j.input.kind === 'render' && j.input.scenario === scenario);
  const reviewJobs = await queue.list({ project: slug, kinds: ['review'], states: ['queued', 'running'], limit: 50 });

  // Records: renders/<scenario>-v<N>[-variant].json only (named by the file first: other scenarios' records are not read).
  const entries = await renderEntries(project.dir, (name) => {
    if (renderIdOf(name, scenario) === null) return false;
    renderRecordReads.n++;
    return true;
  });
  const found: StoredRenderRecord[] = [];
  // What is named as a render of the scenario and is none: counted by reason, never hidden in silence.
  const notShown: Array<{ why: RenderNot; count: number }> = [];
  for (const entry of entries) {
    const r = scenarioRenderOf(entry, scenario);
    if (r) {
      found.push(r);
      continue;
    }
    // (A file gone since the folder was listed is not there to be said.)
    if (!entry.read.ok && entry.read.problem === 'missing') continue;
    const why = renderNot(entry, { scenario }) ?? 'unreadable';
    const reason = notShown.find((x) => x.why === why);
    if (reason) reason.count++;
    else notShown.push({ why, count: 1 });
  }
  // Newest first (the one order of renders, reversed).
  const records = orderRenders(found).reverse();
  const renders: ScenarioRenderView[] = records.slice(0, SCENARIO_RENDERS_MAX).map((r) => renderView(project.dir, r, renderJobs, reviewJobs));

  const jobs: ScenarioRenderJobView[] = [];
  for (const j of [...renderJobs].reverse()) {
    if (j.input.kind !== 'render' || FINISHED_JOB_STATES.has(j.state)) continue;
    let queueView: RenderQueueView | undefined;
    if (j.state === 'queued') {
      const pos = await queue.position(j.id);
      if (pos) {
        const running = pos.running ? await queue.get(pos.running) : undefined;
        queueView = {
          ahead: pos.ahead,
          ...(pos.held_by ? { held_by: pos.held_by } : {}),
          ...(running
            ? {
                running: {
                  id: running.id,
                  kind: running.kind,
                  ...(running.progress?.phase ? { phase: running.progress.phase } : {}),
                  ...(running.progress?.fraction !== undefined ? { fraction: running.progress.fraction } : {}),
                  ...(running.progress?.eta_s !== undefined ? { eta_s: running.progress.eta_s } : {}),
                },
              }
            : {}),
        };
      }
    }
    const p = j.progress;
    jobs.push({
      id: j.id,
      render_id: j.input.render_id,
      run_id: j.input.run_id,
      state: j.state === 'running' ? 'running' : 'queued',
      created_at: j.created_at,
      submitted_by: j.input.submitted_by,
      ...(j.input.edit_sha256 ? { edit_sha256: j.input.edit_sha256 } : {}),
      ...(p?.phase ? { phase: p.phase } : {}),
      ...(p?.fraction !== undefined ? { fraction: p.fraction } : {}),
      ...(p?.eta_s !== undefined ? { eta_s: p.eta_s } : {}),
      reviewing: j.state === 'running' && (p?.phase ?? '').startsWith('review:'),
      ...(queueView ? { queue: queueView } : {}),
      cancel_requested: j.cancel_requested_at !== undefined,
      ...(j.yield ? { yield: j.yield } : {}),
    });
  }

  const view: ScenarioRendersView = { project: slug, scenario, jobs, renders, untrusted: {} };
  if (notShown.length) view.not_shown = { count: notShown.reduce((n, x) => n + x.count, 0), reasons: notShown };
  const newest = renderJobs[0];
  if (newest && newest.input.kind === 'render' && (newest.state === 'failed' || newest.state === 'cancelled' || newest.state === 'interrupted')) {
    const ended = newest.finished_at ?? newest.created_at;
    if (!records[0] || ended > records[0].created_at) {
      view.last_failed = { job: newest.id, render_id: newest.input.render_id, run_id: newest.input.run_id, state: newest.state, ...(newest.finished_at ? { finished_at: newest.finished_at } : {}) };
      if (newest.error?.message) view.untrusted.error = failureWords(newest.error.message);
    }
  }
  return view;
}

/** Plan signatures of render records (a record never changes once written: keyed by its id and times). */
const planSigMemo = new Map<string, string>();
function memoPlanSignature(r: StoredRenderRecord): string {
  const key = `${r.id}|${r.created_at}|${r.finished_at}`;
  let sig = planSigMemo.get(key);
  if (sig === undefined) {
    sig = planSignature(r.plan);
    if (planSigMemo.size > 256) planSigMemo.delete(planSigMemo.keys().next().value!);
    planSigMemo.set(key, sig);
  }
  return sig;
}
